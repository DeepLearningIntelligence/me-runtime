import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { GfinConnectionConfig } from "@rakazo/adapters";
import {
  GFIN_CONNECTION_SLUG,
  GFIN_KEY_MALFORMED,
  GFIN_MCP_URL,
  GFIN_PERSONAL_DESCRIPTION,
  GFIN_PERSONAL_KEY_PREFIX,
  GFIN_PERSONAL_LABEL,
  GFIN_PUBLIC_DESCRIPTION,
  GFIN_PUBLIC_LABEL,
} from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { isUniqueViolation } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * The person's Go Fund It Now connection (D-RUN-9).
 *
 * One function converges the connection for a person: it creates it on first admission,
 * and when per-person provisioning (GFIN G3) goes live it re-keys the existing
 * public-search connection to the personal key in the same code path. It is called from
 * the account hook on every workspace admission, so a failed run is retried on the next
 * sign-in and an account that predates this code converges too.
 *
 * The key is stored only through the encrypted secret store, as MCP credential material
 * (`{ secret }`); no row, log, prompt or DTO ever holds it. me.io never sends `org_id`,
 * and the connector guard refuses it before any request.
 */

export interface GfinConnectionDeps {
  prisma: Pick<PrismaClient, "mcpServer" | "secret" | "spaceMember" | "user" | "$transaction">;
  secrets: Pick<SecretStore, "put">;
  config: GfinConnectionConfig | undefined;
  /** Server-to-server calls; tests inject a stub. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

/** What the convergence did, named so the caller can log or count it. */
export type GfinConnectionOutcome =
  | { action: "created" | "rekeyed" | "current"; mode: "public" | "personal" }
  | { action: "off" };

/** The resolved key and the connection mode it stands for. */
type ResolvedKey = { key: string; mode: "public" | "personal" };

export async function ensureGfinConnection(
  deps: GfinConnectionDeps,
  user: { id: string },
): Promise<GfinConnectionOutcome> {
  if (!deps.config) return { action: "off" };
  const existing = await deps.prisma.mcpServer.findFirst({
    where: { userId: user.id, slug: GFIN_CONNECTION_SLUG },
    select: { id: true, spaceId: true, name: true, secretId: true },
  });
  // Already personal: nothing to resolve, so the per-sign-in path stays off the network.
  if (existing && existing.name === GFIN_PERSONAL_LABEL)
    return { action: "current", mode: "personal" };

  let resolved: ResolvedKey;
  try {
    resolved = await resolveGfinKey(deps, user.id);
  } catch (error) {
    // A malformed provisioning response is a named refusal, never a silent fallback to
    // the house key; the next admission retries and the hook logs the refusal.
    if (error instanceof GfinKeyMalformedError) throw error;
    // An unreachable provisioning endpoint degrades, visibly, to the house key's
    // public-search connection; without a house key there is nothing to degrade to.
    if (deps.config.houseKey) {
      getLogger().warn("gfin provisioning failed; using the public search connection", {
        "gfin.reason": error instanceof Error ? error.message : "unknown",
      });
      resolved = { key: deps.config.houseKey, mode: "public" };
    } else {
      throw error;
    }
  }

  const label = labelFor(resolved.mode);
  if (!existing) {
    await createConnection(deps, user.id, resolved.key, label);
    return { action: "created", mode: resolved.mode };
  }
  if (existing.name === label.name) return { action: "current", mode: resolved.mode };
  await rekeyConnection(deps, user.id, existing, resolved.key, label);
  return { action: "rekeyed", mode: resolved.mode };
}

/** The provisioning endpoint (G3) first, the house key behind the labelled degraded path. */
async function resolveGfinKey(deps: GfinConnectionDeps, userId: string): Promise<ResolvedKey> {
  const config = deps.config!;
  if (!config.provision) {
    if (!config.houseKey)
      throw new Error("gfin provisioning is not configured (gfin_unconfigured)");
    return { key: config.houseKey, mode: "public" };
  }
  const person = await deps.prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  // A GFIN key is personal, so a person who cannot be named to GFIN is not provisioned.
  if (!person) throw new Error(`gfin provisioning found no person ${userId} (gfin_no_person)`);
  const doFetch = deps.fetch ?? globalThis.fetch;
  const response = await doFetch(config.provision.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.provision.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ userId, email: person.email }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(
      `the provisioning endpoint answered HTTP ${response.status} (gfin_provision_refused)`,
    );
  const body = (await response.json()) as { key?: unknown };
  const key = typeof body.key === "string" ? body.key : undefined;
  if (!key?.startsWith(GFIN_PERSONAL_KEY_PREFIX)) throw new GfinKeyMalformedError();
  return { key, mode: "personal" };
}

export class GfinKeyMalformedError extends Error {
  constructor() {
    super(GFIN_KEY_MALFORMED);
    this.name = "GfinKeyMalformedError";
  }
}

function labelFor(mode: "public" | "personal"): { name: string; description: string } {
  return mode === "personal"
    ? { name: GFIN_PERSONAL_LABEL, description: GFIN_PERSONAL_DESCRIPTION }
    : { name: GFIN_PUBLIC_LABEL, description: GFIN_PUBLIC_DESCRIPTION };
}

/** Credential material the connector sends to the endpoint; only the store sees the key. */
function credentialMaterial(key: string): string {
  return JSON.stringify({ secret: key });
}

function connectionContext(spaceId: string, userId: string): AdapterContext {
  return {
    operationId: "gfin.provision",
    traceId: "gfin.provision",
    spaceId,
    userId,
    signal: new AbortController().signal,
  };
}

async function createConnection(
  deps: GfinConnectionDeps,
  userId: string,
  key: string,
  label: { name: string; description: string },
): Promise<void> {
  const membership = await deps.prisma.spaceMember.findFirst({
    where: { userId, space: { deletingAt: null } },
    orderBy: { createdAt: "asc" },
    select: { spaceId: true },
  });
  if (!membership)
    throw new Error(`gfin provisioning found no workspace for ${userId} (gfin_no_workspace)`);
  const stored = await deps.secrets.put(
    credentialMaterial(key),
    connectionContext(membership.spaceId, userId),
  );
  try {
    await deps.prisma.$transaction(async (tx) => {
      await tx.secret.create({
        data: {
          id: stored.id,
          userId,
          // Available in every space of the owner, like a server the person added.
          spaceId: null,
          kind: "mcp",
          ciphertext: stored.ciphertext,
        },
      });
      await tx.mcpServer.create({
        data: {
          spaceId: membership.spaceId,
          userId,
          allSpaces: true,
          allBots: true,
          slug: GFIN_CONNECTION_SLUG,
          name: label.name,
          description: label.description,
          transport: "streamable_http",
          endpoint: deps.config?.mcpUrl ?? GFIN_MCP_URL,
          env: {},
          files: {},
          headers: {},
          secretId: stored.id,
          enabled: true,
        },
      });
    });
  } catch (error) {
    // A concurrent admission for the same person created it first; that row converges.
    if (isUniqueViolation(error)) return;
    throw error;
  }
}

/** The per-person key arrived: swap the credential and the label, one revision up. */
async function rekeyConnection(
  deps: GfinConnectionDeps,
  userId: string,
  existing: { id: string; secretId: string | null; spaceId: string },
  key: string,
  label: { name: string; description: string },
): Promise<void> {
  const stored = await deps.secrets.put(
    credentialMaterial(key),
    connectionContext(existing.spaceId, userId),
  );
  // The secret the row pointed at before this re-key, captured before any write.
  const previousSecretId = existing.secretId;
  await deps.prisma.$transaction(async (tx) => {
    await tx.secret.create({
      data: {
        id: stored.id,
        userId,
        spaceId: null,
        kind: "mcp",
        ciphertext: stored.ciphertext,
      },
    });
    await tx.mcpServer.update({
      where: { id: existing.id },
      data: {
        name: label.name,
        description: label.description,
        secretId: stored.id,
        revision: { increment: 1 },
        // The old verdict is about the old key.
        healthStatus: "unknown",
        healthMessage: null,
        healthToolCount: null,
        healthCheckedAt: null,
      },
    });
    if (previousSecretId) await tx.secret.deleteMany({ where: { id: previousSecretId } });
  });
}
