import {
  EncryptedSecretStore,
  GFIN_CONNECTION_SLUG,
  GFIN_KEY_MALFORMED,
  GFIN_MCP_URL,
  GFIN_PERSONAL_KEY_PREFIX,
  GFIN_PUBLIC_LABEL,
} from "@rakazo/adapters";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { describe, expect, it } from "vitest";
import type { GfinConnectionDeps } from "./service.js";
import { ensureGfinConnection, GfinKeyMalformedError } from "./service.js";

/**
 * The connection a person gets without any action, against an in-memory store that
 * follows the Prisma calls the service makes, and the real encrypted secret store.
 * The key value appears only inside ciphertext; every other surface is asserted clean.
 */

const HOUSE_KEY = "gfin_house_test_key_000000";
const PERSONAL_KEY = "gfin_personal_test_key_111111";
const USER = { id: "user-1", email: "phone-abc@phone.invalid" };

type SecretRow = {
  id: string;
  userId: string;
  spaceId: string | null;
  kind: string;
  ciphertext: string;
};
type McpRow = Record<string, unknown> & { id: string; userId: string };

function fakePrisma() {
  const secrets: SecretRow[] = [];
  const servers: McpRow[] = [];
  const memberships = [{ spaceId: "space-1", userId: USER.id, createdAt: new Date(0) }];
  let nextId = 1;

  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === USER.id ? { id: USER.id, email: USER.email } : null,
    },
    spaceMember: {
      findFirst: async () => memberships[0] ?? null,
    },
    secret: {
      create: async ({ data }: { data: SecretRow }) => {
        secrets.push({ ...data });
        return data;
      },
      deleteMany: async ({ where }: { where: { id: string } }) => {
        const kept = secrets.filter((row) => row.id !== where.id);
        const removed = secrets.length - kept.length;
        secrets.splice(0, secrets.length, ...kept);
        return { count: removed };
      },
    },
    mcpServer: {
      findFirst: async ({ where }: { where: { userId: string; slug: string } }) => {
        const row = servers.find(
          (candidate) => candidate.userId === where.userId && candidate.slug === where.slug,
        );
        // Prisma returns plain rows of the read, never the live store objects.
        return row ? { ...row } : null;
      },
      create: async ({ data }: { data: McpRow }) => {
        const collision = servers.some(
          (row) =>
            row.spaceId === data.spaceId && row.userId === data.userId && row.slug === data.slug,
        );
        if (collision) {
          const error = new Error("Unique constraint failed");
          (error as { code?: string }).code = "P2002";
          throw error;
        }
        const row = { ...data, id: `srv-${nextId++}` };
        servers.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = servers.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          userId?: string;
          endpoint?: string | { in: string[] };
          slug?: { not: string };
          enabled?: boolean;
        };
        data: Record<string, unknown>;
      }) => {
        const endpoints =
          where.endpoint === undefined
            ? undefined
            : typeof where.endpoint === "string"
              ? [where.endpoint]
              : where.endpoint.in;
        const matches = servers.filter(
          (row) =>
            (where.userId === undefined || row.userId === where.userId) &&
            (endpoints === undefined || endpoints.includes(String(row.endpoint))) &&
            (where.slug?.not === undefined || row.slug !== where.slug.not) &&
            (where.enabled === undefined || row.enabled === where.enabled),
        );
        for (const row of matches) Object.assign(row, data);
        return { count: matches.length };
      },
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        secret: prisma.secret,
        mcpServer: prisma.mcpServer,
      }),
  };
  return { prisma, secrets, servers };
}

const store = new EncryptedSecretStore("0123456789abcdef0123456789abcdef");

function deps(
  fake: ReturnType<typeof fakePrisma>,
  config: Parameters<typeof ensureGfinConnection>[0]["config"],
  fetch?: typeof globalThis.fetch,
) {
  return {
    prisma: fake.prisma as unknown as GfinConnectionDeps["prisma"],
    secrets: store,
    config,
    ...(fetch ? { fetch } : {}),
  };
}

const rowsOf = (fake: ReturnType<typeof fakePrisma>) =>
  fake.servers.map((row) => JSON.stringify(row)).join("\n");

/** Every stored or returned surface, joined, so one assertion covers the whole sweep. */
async function cleartextSurfaces(fake: ReturnType<typeof fakePrisma>, outcome: unknown) {
  return [rowsOf(fake), JSON.stringify(outcome), ...fake.secrets.map((row) => row.ciphertext)].join(
    "\n",
  );
}

function provisionStub(response: { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      body: JSON.parse(await request.text()),
    });
    if ((response.status ?? 200) !== 200) return new Response("no", { status: response.status });
    return Response.json(response.body ?? {});
  }) as typeof globalThis.fetch;
  return { calls, fetchStub };
}

const CONFIG = { mcpUrl: "https://app.gofunditnow.com/api/mcp" };

function seedServer(
  fake: ReturnType<typeof fakePrisma>,
  row: { id: string; slug: string; name: string; endpoint: string; enabled?: boolean },
) {
  const seeded = {
    userId: USER.id,
    spaceId: "space-1",
    transport: "streamable_http",
    allBots: false,
    allSpaces: false,
    env: {},
    files: {},
    headers: {},
    args: [],
    revision: 1,
    enabled: true,
    ...row,
  };
  fake.servers.push(seeded);
  return seeded;
}

describe("gfin connection provisioning", () => {
  it("creates an enabled public connection with no credential when nothing is configured", async () => {
    const fake = fakePrisma();
    const outcome = await ensureGfinConnection(deps(fake, CONFIG), USER);
    expect(outcome).toEqual({ action: "created", mode: "public" });
    expect(fake.servers).toHaveLength(1);
    const row = fake.servers[0]!;
    expect(row.slug).toBe(GFIN_CONNECTION_SLUG);
    expect(row.name).toBe(GFIN_PUBLIC_LABEL);
    expect(row.transport).toBe("streamable_http");
    expect(row.endpoint).toBe(CONFIG.mcpUrl);
    expect(row.allBots).toBe(true);
    expect(row.allSpaces).toBe(true);
    expect(row.enabled).toBe(true);
    expect(row.secretId).toBeUndefined();
    expect(fake.secrets).toHaveLength(0);
  });

  it("a house key alone never becomes a credential on a person's row", async () => {
    const fake = fakePrisma();
    const outcome = await ensureGfinConnection(
      deps(fake, { ...CONFIG, houseKey: HOUSE_KEY }),
      USER,
    );
    expect(outcome).toEqual({ action: "created", mode: "public" });
    const row = fake.servers[0]!;
    expect(row.name).toBe(GFIN_PUBLIC_LABEL);
    expect(row.secretId).toBeUndefined();
    expect(fake.secrets).toHaveLength(0);
    // The deployment key is in no row, no secret, and no returned surface.
    expect(await cleartextSurfaces(fake, outcome)).not.toContain(HOUSE_KEY);
  });

  it("converges: a second admission changes nothing", async () => {
    const fake = fakePrisma();
    await ensureGfinConnection(deps(fake, CONFIG), USER);
    const before = JSON.stringify(fake.servers);
    const outcome = await ensureGfinConnection(deps(fake, CONFIG), USER);
    expect(outcome).toEqual({ action: "current", mode: "public" });
    expect(fake.servers).toHaveLength(1);
    expect(fake.secrets).toHaveLength(0);
    expect(JSON.stringify(fake.servers)).toBe(before);
  });

  it("uses a per-person gfin_ key from the provisioning endpoint, labelled personally", async () => {
    const fake = fakePrisma();
    const provision = provisionStub({ body: { key: PERSONAL_KEY } });
    const outcome = await ensureGfinConnection(
      deps(
        fake,
        {
          ...CONFIG,
          provision: { url: "https://g3.example.test/provision", token: "service-token" },
        },
        provision.fetchStub,
      ),
      USER,
    );
    expect(outcome).toEqual({ action: "created", mode: "connected" });
    const row = fake.servers[0]!;
    expect(row.name).toBe("Go Fund It Now");
    // The service credential authenticates the call; the request names the person and
    // never carries org_id or a key.
    expect(provision.calls).toHaveLength(1);
    expect(provision.calls[0]!.authorization).toBe("Bearer service-token");
    expect(provision.calls[0]!.body).toEqual({ userId: USER.id, email: USER.email });
    expect(JSON.stringify(provision.calls[0]!.body)).not.toContain("org_id");
    const material = JSON.parse(
      await store.load(fake.secrets[0]!.ciphertext, fake.secrets[0]!.id as never),
    );
    expect(material).toEqual({ secret: PERSONAL_KEY });
    expect(await cleartextSurfaces(fake, outcome)).not.toContain(PERSONAL_KEY);
  });

  it("upgrades an existing public connection to the personal key automatically", async () => {
    const fake = fakePrisma();
    await ensureGfinConnection(deps(fake, CONFIG), USER);
    expect(fake.servers[0]!.secretId).toBeUndefined();
    const provision = provisionStub({ body: { key: PERSONAL_KEY } });
    const outcome = await ensureGfinConnection(
      deps(
        fake,
        {
          ...CONFIG,
          provision: { url: "https://g3.example.test/provision", token: "service-token" },
        },
        provision.fetchStub,
      ),
      USER,
    );
    expect(outcome).toEqual({ action: "rekeyed", mode: "connected" });
    const row = fake.servers[0]!;
    expect(row.name).toBe("Go Fund It Now");
    expect(row.secretId).toBeDefined();
    // The old public row pointed at no secret; the connected row owns exactly one.
    expect(fake.secrets.map((secret) => secret.id)).toEqual([row.secretId]);
    const material = JSON.parse(
      await store.load(fake.secrets[0]!.ciphertext, fake.secrets[0]!.id as never),
    );
    expect(material).toEqual({ secret: PERSONAL_KEY });
  });

  it("clears a legacy house-key credential from a public row", async () => {
    const fake = fakePrisma();
    const legacy = await store.put(JSON.stringify({ secret: HOUSE_KEY }), {
      operationId: "seed",
      traceId: "seed",
      spaceId: "space-1",
      userId: USER.id,
      signal: new AbortController().signal,
    } as never);
    fake.secrets.push({
      id: legacy.id,
      userId: USER.id,
      spaceId: null,
      kind: "mcp",
      ciphertext: legacy.ciphertext,
    });
    fake.servers.push({
      id: "srv-legacy",
      userId: USER.id,
      spaceId: "space-1",
      slug: GFIN_CONNECTION_SLUG,
      name: GFIN_PUBLIC_LABEL,
      endpoint: CONFIG.mcpUrl,
      secretId: legacy.id,
      enabled: true,
    });
    const outcome = await ensureGfinConnection(
      deps(fake, { ...CONFIG, houseKey: HOUSE_KEY }),
      USER,
    );
    expect(outcome).toEqual({ action: "converged", mode: "public" });
    const row = fake.servers[0]!;
    expect(row.name).toBe(GFIN_PUBLIC_LABEL);
    expect(row.secretId).toBeNull();
    expect(fake.secrets).toHaveLength(0);
  });

  it("refuses a malformed per-person key by name instead of falling back", async () => {
    const fake = fakePrisma();
    const provision = provisionStub({ body: { key: "sk-not-a-gfin-key" } });
    await expect(
      ensureGfinConnection(
        deps(
          fake,
          {
            ...CONFIG,
            houseKey: HOUSE_KEY,
            provision: { url: "https://g3.example.test/provision", token: "service-token" },
          },
          provision.fetchStub,
        ),
        USER,
      ),
    ).rejects.toThrow(GFIN_KEY_MALFORMED);
    // No row at all: the refusal is named, and the house key is not used instead.
    expect(fake.servers).toHaveLength(0);
    expect(fake.secrets).toHaveLength(0);
    expect(GfinKeyMalformedError).toBeDefined();
    expect(GFIN_PERSONAL_KEY_PREFIX).toBe("gfin_");
  });

  it("leaves the public row with no secret when provisioning fails", async () => {
    const fake = fakePrisma();
    const provision = provisionStub({ status: 503 });
    const sink = createTestSink();
    const previous = getLogger();
    installLogger(createLogger({ service: "test", sinks: [sink], level: "debug" }));
    try {
      const outcome = await ensureGfinConnection(
        deps(
          fake,
          {
            ...CONFIG,
            houseKey: HOUSE_KEY,
            provision: { url: "https://g3.example.test/provision", token: "service-token" },
          },
          provision.fetchStub,
        ),
        USER,
      );
      expect(outcome).toEqual({ action: "created", mode: "public" });
      expect(fake.servers[0]!.name).toBe(GFIN_PUBLIC_LABEL);
      expect(fake.servers[0]!.secretId).toBeUndefined();
      expect(fake.secrets).toHaveLength(0);
      expect(JSON.stringify(sink.events)).toContain("gfin_provision_refused");
    } finally {
      installLogger(previous);
    }
  });

  it("disables a duplicate server on the GFIN endpoint and leaves every other server alone", async () => {
    const fake = fakePrisma();
    const config = { mcpUrl: "https://gfin-proxy.example.test/api/mcp" };
    const duplicate = seedServer(fake, {
      id: "srv-duplicate",
      slug: "gfin-funding-radar-2",
      name: "GFIN Funding Radar 2",
      endpoint: GFIN_MCP_URL,
    });
    const unrelated = seedServer(fake, {
      id: "srv-unrelated",
      slug: "notes",
      name: "Notes",
      endpoint: "https://notes.example.test/api/mcp",
    });
    const before = JSON.stringify(unrelated);
    const sink = createTestSink();
    const previous = getLogger();
    installLogger(createLogger({ service: "test", sinks: [sink], level: "debug" }));
    try {
      const outcome = await ensureGfinConnection(deps(fake, config), USER);
      expect(outcome).toEqual({ action: "created", mode: "public" });
      const gfin = fake.servers.find((row) => row.slug === GFIN_CONNECTION_SLUG)!;
      expect(gfin.endpoint).toBe(config.mcpUrl);
      expect(gfin.enabled).toBe(true);
      expect(duplicate.enabled).toBe(false);
      expect(unrelated.enabled).toBe(true);
      expect(JSON.stringify(unrelated)).toBe(before);
      const logged = JSON.stringify(sink.events);
      expect(logged).toContain("disabled duplicate Go Fund It Now connections");
      expect(logged).toContain(USER.id);
      expect(logged).toContain('"count":1');
    } finally {
      installLogger(previous);
    }
  });
});
