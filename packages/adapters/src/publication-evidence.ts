import type { PublicationCard } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { ExecutorDeps } from "./executor-deps.js";
import { GFIN_CONNECTION_SLUG } from "./gfin-connection.js";
import { GFIN_MCP_URL } from "./gfin-endpoint.js";
import { publishMessage } from "./run-messages.js";

/**
 * Read-only evidence for the publication card a public action posts (Packet D, QW-1).
 *
 * One gather answers "who applied, who was denied?": readiness is read from the Space's
 * own GFIN connection row, the applied and denied lists are read through the GFIN MCP
 * `callTool` seam the caller owns. Nothing here writes, and nothing degrades silently:
 * a payload that does not match the expected contract, or a connection row that does
 * not, throws a named error so the caller can fail closed instead of publishing a card
 * that invents an answer.
 */

/** The GFIN read that serves the Space's applied and denied lists. */
export const GFIN_EVIDENCE_TOOL = "get_my_saved_opportunities";

/** The GFIN portal the card links to when the action named no opportunity link. */
export const GFIN_PORTAL_URL = new URL(GFIN_MCP_URL).origin;

/** Named refusals: every failure the gather can raise carries one of these keys. */
export type PublicationEvidenceErrorKey =
  | "gfin_evidence_contract_mismatch"
  | "gfin_evidence_unavailable"
  | "db_evidence_contract_mismatch";

export class PublicationEvidenceError extends Error {
  constructor(
    readonly key: PublicationEvidenceErrorKey,
    message: string,
  ) {
    super(message);
    this.name = "PublicationEvidenceError";
  }
}

/** What one read-only gather found, before it becomes a card. */
export interface PublicationEvidence {
  /** Who applied: the saved opportunities GFIN returned for this Space, in its order. */
  applied: string[];
  /** Who was denied: the entries GFIN returned with a denied status. */
  denied: string[];
  /** Whether the Space's GFIN connection row exists and is enabled. */
  readiness: boolean;
  /** The GFIN link the card offers. */
  gfinLink: string;
}

export interface PublicationEvidenceDeps {
  /** The local read: the Space's GFIN connection row, and nothing writable. */
  prisma: Pick<PrismaClient, "mcpServer">;
  /** The GFIN MCP `callTool` seam; the caller owns the session, its lane and its credential. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contractMismatch(message: string): PublicationEvidenceError {
  return new PublicationEvidenceError("gfin_evidence_contract_mismatch", message);
}

/** The GFIN link the action named, or the portal when it named none. */
export function gfinLinkFromArgs(args: Record<string, unknown>): string {
  const link = args.gfin_url;
  if (typeof link === "string" && /^https:\/\/\S+$/.test(link.trim())) return link.trim();
  return GFIN_PORTAL_URL;
}

/** The JSON payload of one GFIN call, from structured content or the text block. */
function gfinPayload(result: unknown): unknown {
  if (!isRecord(result))
    throw contractMismatch("the GFIN callTool result was not an object");
  if (result.isError === true)
    throw new PublicationEvidenceError(
      "gfin_evidence_unavailable",
      "GFIN refused the saved-opportunities read",
    );
  if (result.structuredContent !== undefined && result.structuredContent !== null)
    return result.structuredContent;
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
      try {
        return JSON.parse(block.text) as unknown;
      } catch {
        throw contractMismatch("the GFIN saved-opportunities text was not JSON");
      }
    }
  }
  throw contractMismatch("the GFIN callTool result carried no payload");
}

/** The row name: the opportunity's own name, else its title. */
function rowName(row: Record<string, unknown>): string | undefined {
  for (const key of ["name", "title"] as const) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/** Splits the saved-opportunities payload into the applied and denied lists. */
function savedOpportunities(result: unknown): { applied: string[]; denied: string[] } {
  const payload = gfinPayload(result);
  const rows = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.opportunities)
      ? payload.opportunities
      : undefined;
  if (!rows) throw contractMismatch("the GFIN payload did not carry an opportunities array");
  const applied: string[] = [];
  const denied: string[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw contractMismatch("a saved opportunity was not an object");
    const name = rowName(row);
    if (!name) throw contractMismatch("a saved opportunity had no name");
    const status = typeof row.status === "string" ? row.status.trim().toLowerCase() : "";
    if (status === "denied") denied.push(name);
    else applied.push(name);
  }
  return { applied, denied };
}

/**
 * Gathers the evidence for one public action, read-only. Throws a named error on a
 * contract mismatch instead of guessing: the caller then publishes no card (or an
 * unvalidated one), never a card whose answer it could not read.
 */
export async function collectPublicationEvidence(
  spaceId: string,
  args: Record<string, unknown>,
  deps: PublicationEvidenceDeps,
): Promise<PublicationEvidence> {
  const gfinLink = gfinLinkFromArgs(args);
  const connection = await deps.prisma.mcpServer.findFirst({
    where: { spaceId, slug: GFIN_CONNECTION_SLUG },
    select: { id: true, enabled: true },
  });
  if (
    connection !== null &&
    (typeof connection.id !== "string" || typeof connection.enabled !== "boolean")
  )
    throw new PublicationEvidenceError(
      "db_evidence_contract_mismatch",
      "the GFIN connection row did not match the expected shape",
    );
  const readiness = connection !== null && connection.enabled;
  if (!readiness) return { applied: [], denied: [], readiness: false, gfinLink };
  const lists = savedOpportunities(await deps.callTool(GFIN_EVIDENCE_TOOL, {}));
  return { applied: lists.applied, denied: lists.denied, readiness: true, gfinLink };
}

/** Builds the card from one gather: validated only when the connection was ready. */
export function buildPublicationCard(evidence: PublicationEvidence): PublicationCard {
  return {
    validated: evidence.readiness,
    applied_by: evidence.applied,
    denied_by: evidence.denied,
    ...(evidence.readiness ? {} : { reason: "gfin_connection_not_ready" }),
    gfinLink: evidence.gfinLink,
  };
}

/**
 * Posts the card through the same run-outbox layer the app_connect card uses, keyed to
 * the completed run. `publishMessage` persists the message with the run's id and
 * notifies the thread, so the card lands in order and replays with the run.
 */
export async function publishPublicationCard(
  deps: ExecutorDeps,
  run: { id: string; spaceId: string; threadId: string; botId: string; trigger: string },
  card: PublicationCard,
): Promise<void> {
  await publishMessage(deps, run, "bot", [{ kind: "visual_pack", ...card }]);
}
