import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { GfinConnectionConfig, GfinMode } from "@rakazo/adapters";
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
 * One function converges the connection for a person on every admission: it creates the
 * public connection on first admission, with no credential, and when a provisioning key
 * or the house key is configured it upgrades the same row to the connected label and
 * credential in this code path. A stored credential also selects the connected tool lane
 * in the guard; nothing writes a separate allowlist. A person who added a second server
 * pointing at the GFIN endpoint has it disabled here, because two rows would serve the
 * same connection with different credentials.
 *
 * The key is stored only through the encrypted secret store, as MCP credential material
 * (`{ secret }`); no row, log, prompt or DTO ever holds it. me.io never sends `org_id`,
 * and the connector guard refuses it before any request.
 */

export interface GfinConnectionDeps {
  prisma: Pick<PrismaClient, "mcpServer" | "secret" | "spaceMember" | "user" | "$transaction">;
  secrets: Pick<SecretStore, "put">;
  config: GfinConnectionConfig;
  /** Server-to-server calls; tests inject a stub. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

/** What the convergence did, named so the caller can log or count it. */
export type GfinConnectionOutcome = {
  action: "created" | "rekeyed" | "converged" | "current";
  mode: GfinMode;
};

export async function ensureGfinConnection(
  deps: GfinConnectionDeps,
  user: { id: string },
): Promise<GfinConnectionOutcome> {
  const existing = await deps.prisma.mcpServer.findFirst({
    where: { userId: user.id, slug: GFIN_CONNECTION_SLUG },
    select: { id: true, spaceId: true, name: true, secretId: true },
  });
  // Already connected: nothing to resolve, so the per-sign-in path stays off the network.
  const connectedAlready = Boolean(existing?.secretId) && existing?.name === GFIN_PERSONAL_LABEL;
  let key: string | undefined;
  if (!connectedAlready) {
    try {
      key = await resolveGfinKey(deps, user.id);
    } catch (error) {
      // A malformed provisioning response is a named refusal, never a silent fallback to
      // the house key; the next admission retries and the hook logs the refusal.
      if (error instanceof GfinKeyMalformedError) throw error;
      // An unreachable provisioning endpoint degrades, visibly, to the house key.
      if (deps.config.houseKey) {
        getLogger().warn("gfin provisioning failed; using the house key", {
          "gfin.reason": error instanceof Error ? error.message : "unknown",
        });
        key = deps.config.houseKey;
      } else {
        throw error;
      }
    }
  }
  // The row's own credential is the lane authority: a secret means the connected lane.
  const mode: GfinMode = key || existing?.secretId ? "connected" : "public";
  const label = labelFor(mode);

  let action: GfinConnectionOutcome["action"];
  if (!existing) {
    await createConnection(deps, user.id, key, label);
    action = "created";
  } else if (key !== undefined && (existing.name !== label.name || !existing.secretId)) {
    await rekeyConnection(deps, user.id, existing, key, label);
    action = "rekeyed";
  } else if (existing.name !== label.name) {
    await relabelConnection(deps.prisma, existing.id, label);
    action = "converged";
  } else {
    action = "current";
  }
  const disabled = await disableDuplicateEndpointRows(deps, user.id);
  if (disabled > 0 && action === "current") action = "converged";
  return { action, mode };
}

/** The provisioning endpoint (G3) first, the house key behind it, or no key at all. */
async function resolveGfinKey(
  deps: GfinConnectionDeps,
  userId: string,
): Promise<string | undefined> {
  const config = deps.config;
  if (!config.provision) return config.houseKey;
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
  return key;
}

export class GfinKeyMalformedError extends Error {
  constructor() {
    super(GFIN_KEY_MALFORMED);
    this.name = "GfinKeyMalformedError";
  }
}

function labelFor(mode: GfinMode): { name: string; description: string } {
  return mode === "connected"
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
  key: string | undefined,
  label: { name: string; description: string },
): Promise<void> {
  const membership = await deps.prisma.spaceMember.findFirst({
    where: { userId, space: { deletingAt: null } },
    orderBy: { createdAt: "asc" },
    select: { spaceId: true },
  });
  if (!membership)
    throw new Error(`gfin provisioning found no workspace for ${userId} (gfin_no_workspace)`);
  const stored = key
    ? await deps.secrets.put(credentialMaterial(key), connectionContext(membership.spaceId, userId))
    : undefined;
  try {
    await deps.prisma.$transaction(async (tx) => {
      if (stored)
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
          endpoint: deps.config.mcpUrl,
          env: {},
          files: {},
          headers: {},
          ...(stored ? { secretId: stored.id } : {}),
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

/** The row's label follows its credential state without touching the credential. */
async function relabelConnection(
  prisma: GfinConnectionDeps["prisma"],
  id: string,
  label: { name: string; description: string },
): Promise<void> {
  await prisma.mcpServer.update({
    where: { id },
    data: { name: label.name, description: label.description },
  });
}

/**
 * A second row pointing at the same GFIN endpoint would reach the same account with a
 * different credential and escape the guard's lane, so it is disabled, never deleted.
 */
async function disableDuplicateEndpointRows(
  deps: GfinConnectionDeps,
  userId: string,
): Promise<number> {
  const { count } = await deps.prisma.mcpServer.updateMany({
    where: {
      userId,
      endpoint: { in: [...new Set([deps.config.mcpUrl, GFIN_MCP_URL])] },
      slug: { not: GFIN_CONNECTION_SLUG },
      enabled: true,
    },
    data: { enabled: false },
  });
  if (count > 0)
    getLogger().warn("disabled duplicate Go Fund It Now connections", {
      userId,
      count,
    });
  return count;
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
