import {
  EncryptedSecretStore,
  GFIN_CONNECTION_SLUG,
  GFIN_KEY_MALFORMED,
  GFIN_PERSONAL_KEY_PREFIX,
  GFIN_PUBLIC_LABEL,
} from "@rakazo/adapters";
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

describe("gfin connection provisioning", () => {
  it("creates the labelled public-search connection on account creation, with no user action", async () => {
    const fake = fakePrisma();
    const outcome = await ensureGfinConnection(
      deps(fake, {
        mcpUrl: "https://app.gofunditnow.com/api/mcp",
        houseKey: HOUSE_KEY,
      }),
      USER,
    );
    expect(outcome).toEqual({ action: "created", mode: "public" });
    expect(fake.servers).toHaveLength(1);
    const row = fake.servers[0]!;
    expect(row.slug).toBe(GFIN_CONNECTION_SLUG);
    expect(row.name).toBe(GFIN_PUBLIC_LABEL);
    expect(row.transport).toBe("streamable_http");
    expect(row.endpoint).toBe("https://app.gofunditnow.com/api/mcp");
    expect(row.allBots).toBe(true);
    expect(row.allSpaces).toBe(true);
    // The key exists only as ciphertext in the encrypted store.
    const secretRow = fake.secrets[0]!;
    expect(secretRow.kind).toBe("mcp");
    expect(secretRow.ciphertext).not.toContain(HOUSE_KEY);
    const material = JSON.parse(await store.load(secretRow.ciphertext, secretRow.id as never));
    expect(material).toEqual({ secret: HOUSE_KEY });
    // The key is in no row JSON, no returned object, no other secret row.
    expect(await cleartextSurfaces(fake, outcome)).not.toContain(HOUSE_KEY);
  });

  it("converges: a second admission changes nothing", async () => {
    const fake = fakePrisma();
    const config = { mcpUrl: "https://app.gofunditnow.com/api/mcp", houseKey: HOUSE_KEY };
    await ensureGfinConnection(deps(fake, config), USER);
    const before = JSON.stringify(fake.servers);
    const outcome = await ensureGfinConnection(deps(fake, config), USER);
    expect(outcome).toEqual({ action: "current", mode: "public" });
    expect(fake.servers).toHaveLength(1);
    expect(fake.secrets).toHaveLength(1);
    expect(JSON.stringify(fake.servers)).toBe(before);
  });

  it("stays off, named, when the deployment configures no key", async () => {
    const fake = fakePrisma();
    const outcome = await ensureGfinConnection(deps(fake, undefined), USER);
    expect(outcome).toEqual({ action: "off" });
    expect(fake.servers).toHaveLength(0);
  });

  it("uses a per-person gfin_ key from the provisioning endpoint, labelled personally", async () => {
    const fake = fakePrisma();
    const provision = provisionStub({ body: { key: PERSONAL_KEY } });
    const outcome = await ensureGfinConnection(
      deps(
        fake,
        {
          mcpUrl: "https://app.gofunditnow.com/api/mcp",
          provision: { url: "https://g3.example.test/provision", token: "service-token" },
        },
        provision.fetchStub,
      ),
      USER,
    );
    expect(outcome).toEqual({ action: "created", mode: "personal" });
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

  it("re-keys an existing public-search connection to the personal key automatically", async () => {
    const fake = fakePrisma();
    await ensureGfinConnection(
      deps(fake, { mcpUrl: "https://app.gofunditnow.com/api/mcp", houseKey: HOUSE_KEY }),
      USER,
    );
    const originalSecretId = fake.secrets[0]!.id;
    const provision = provisionStub({ body: { key: PERSONAL_KEY } });
    const outcome = await ensureGfinConnection(
      deps(
        fake,
        {
          mcpUrl: "https://app.gofunditnow.com/api/mcp",
          provision: { url: "https://g3.example.test/provision", token: "service-token" },
        },
        provision.fetchStub,
      ),
      USER,
    );
    expect(outcome).toEqual({ action: "rekeyed", mode: "personal" });
    const row = fake.servers[0]!;
    expect(row.name).toBe("Go Fund It Now");
    expect(row.secretId).not.toBe(originalSecretId);
    // The old secret row went with the re-key.
    expect(fake.secrets.map((secret) => secret.id)).toEqual([row.secretId]);
    const material = JSON.parse(
      await store.load(fake.secrets[0]!.ciphertext, fake.secrets[0]!.id as never),
    );
    expect(material).toEqual({ secret: PERSONAL_KEY });
  });

  it("refuses a malformed per-person key by name instead of falling back", async () => {
    const fake = fakePrisma();
    const provision = provisionStub({ body: { key: "sk-not-a-gfin-key" } });
    await expect(
      ensureGfinConnection(
        deps(
          fake,
          {
            mcpUrl: "https://app.gofunditnow.com/api/mcp",
            houseKey: HOUSE_KEY,
            provision: { url: "https://g3.example.test/provision", token: "service-token" },
          },
          provision.fetchStub,
        ),
        USER,
      ),
    ).rejects.toThrow(GFIN_KEY_MALFORMED);
    // No row at all: the refusal is loud, the fallback silent one never happens.
    expect(fake.servers).toHaveLength(0);
    expect(fake.secrets).toHaveLength(0);
    expect(GfinKeyMalformedError).toBeDefined();
    expect(GFIN_PERSONAL_KEY_PREFIX).toBe("gfin_");
  });

  it("degrades, named, to the public-search connection when provisioning is unreachable", async () => {
    const fake = fakePrisma();
    const provision = provisionStub({ status: 503 });
    const outcome = await ensureGfinConnection(
      deps(
        fake,
        {
          mcpUrl: "https://app.gofunditnow.com/api/mcp",
          houseKey: HOUSE_KEY,
          provision: { url: "https://g3.example.test/provision", token: "service-token" },
        },
        provision.fetchStub,
      ),
      USER,
    );
    expect(outcome).toEqual({ action: "created", mode: "public" });
    expect(fake.servers[0]!.name).toBe(GFIN_PUBLIC_LABEL);
  });
});
