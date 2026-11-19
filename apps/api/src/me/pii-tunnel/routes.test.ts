import { EncryptedSecretStore } from "@rakazo/adapters";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../env.js";
import { mountPiiTunnelRoutes } from "./routes.js";
import { unseal } from "./vault.js";

type CreatedRow = { userId: string; secretId: string; ciphertext: string };
type Outbound = { idempotencyKey: string; kind: string; identityId: string; body: string };

/**
 * The routes' collaborators, mirrored: one fake session, a stateful one-shot
 * consume, an in-memory Prisma surface, and the real encrypted store so the
 * stored ciphertext is the value a reader will open.
 */
function harness(options: { user?: { id: string } | null; owner?: string } = {}) {
  const created: CreatedRow[] = [];
  const outbound: Outbound[] = [];
  const jobs: string[] = [];
  const secrets = new EncryptedSecretStore("pii-route-test-key");
  const owner = options.owner ?? "user-1";
  const unspent = new Set(["tok-1"]);

  const prisma = {
    piiUpload: {
      create: async ({ data }: { data: CreatedRow }) => {
        created.push(data);
        return { id: `upload-${created.length}` };
      },
    },
    messagingIdentity: {
      findFirst: async () => ({ id: "identity-1" }),
    },
    messagingOutbound: {
      createMany: async ({ data }: { data: Outbound[] }) => {
        outbound.push(...data);
        return { count: data.length };
      },
    },
  };

  const auth = {
    api: {
      getSession: async () =>
        options.user === null ? null : { user: { id: options.user?.id ?? owner } },
    },
    issuePIITunnelToken: async () => "tok-1",
    consumePIITunnelToken: async (token: string) => {
      if (!unspent.delete(token)) return null;
      return token === "tok-1" ? owner : null;
    },
  };

  const app = new Hono();
  mountPiiTunnelRoutes(app, {
    prisma: prisma as never,
    auth: auth as never,
    env: { webOrigin: "https://me.test" } as unknown as AppEnv,
    jobs: {
      enqueue: async (job: { name: string }) => {
        jobs.push(job.name);
      },
    } as never,
    secretStore: secrets,
  });

  return { app, created, outbound, jobs, secrets, unspent };
}

async function postJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/me/pii-tunnel", () => {
  it("refuses a signed-out caller", async () => {
    const { app } = harness({ user: null });
    const response = await app.request("/api/me/pii-tunnel");
    expect(response.status).toBe(401);
  });

  it("returns the signed link and its expiry to the signed-in person", async () => {
    const { app } = harness();
    const response = await app.request("/api/me/pii-tunnel");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string; expiresAt: string };
    expect(body.url).toBe("https://me.gofunditnow.com/pii/tok-1");
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("GET /pii/:token", () => {
  it("sends a signed-out person to sign in without spending the link", async () => {
    const { app, unspent } = harness({ user: null });
    const response = await app.request("/pii/tok-1");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://me.test/sign-in");
    expect(unspent.has("tok-1")).toBe(true);
  });

  it("renders the upload page and spends the link once", async () => {
    const { app, unspent } = harness();
    const first = await app.request("/pii/tok-1");
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/html");
    expect(await first.text()).toContain("Upload your credentials");
    expect(unspent.has("tok-1")).toBe(false);

    const second = await app.request("/pii/tok-1");
    expect(second.status).toBe(400);
  });

  it("refuses a link issued to another person", async () => {
    const { app } = harness({ user: { id: "someone-else" } });
    const response = await app.request("/pii/tok-1");
    expect(response.status).toBe(400);
  });

  it("serves the same page under the API prefix", async () => {
    const { app } = harness();
    const response = await app.request("/api/pii/tok-1");
    expect(response.status).toBe(200);
  });
});

describe("POST /pii/:token", () => {
  it("stores the sealed credentials and queues the receipt", async () => {
    const { app, created, outbound, jobs, secrets } = harness();
    const response = await postJson(app, "/pii/tok-1", {
      service: "Go Fund It Now",
      username: "damu",
      password: "correct horse",
      notes: "use for the dashboard",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    expect(created).toHaveLength(1);
    const row = created[0]!;
    expect(row.userId).toBe("user-1");
    expect(row.ciphertext).not.toContain("correct horse");
    const opened = JSON.parse(
      await unseal(secrets, { id: row.secretId, ciphertext: row.ciphertext }),
    );
    expect(opened).toEqual({
      service: "Go Fund It Now",
      username: "damu",
      password: "correct horse",
      notes: "use for the dashboard",
    });

    expect(outbound).toEqual([
      {
        idempotencyKey: "pii-upload:upload-1",
        kind: "dm",
        identityId: "identity-1",
        body: "PII uploaded via the tunnel - thank you.",
      },
    ]);
    expect(jobs).toEqual(["messaging.deliver"]);
  });

  it("accepts a form-encoded post", async () => {
    const { app, created } = harness();
    const response = await app.request("/pii/tok-1", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "damu", password: "pw" }).toString(),
    });
    expect(response.status).toBe(200);
    expect(created).toHaveLength(1);
  });

  it("refuses a body with no password", async () => {
    const { app, created } = harness();
    const response = await postJson(app, "/pii/tok-1", { username: "damu" });
    expect(response.status).toBe(400);
    expect(created).toHaveLength(0);
  });

  it("sends a signed-out poster to sign in", async () => {
    const { app, created } = harness({ user: null });
    const response = await postJson(app, "/pii/tok-1", { username: "damu", password: "pw" });
    expect(response.status).toBe(303);
    expect(created).toHaveLength(0);
  });
});
