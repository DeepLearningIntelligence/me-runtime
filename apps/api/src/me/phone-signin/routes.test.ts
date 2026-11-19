import type { Auth } from "@rakazo/auth";
import type { PrismaClient, SignupPolicyEnv } from "@rakazo/db";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../env.js";
import { sha256Hex } from "./codes.js";
import { mountPhoneSigninRoutes } from "./routes.js";

/**
 * The verify route's mode decision: the pending row decides link or sign-in,
 * never the request. An offline fake mirrors the reads and conditional updates
 * the Prisma client would run (the same shape service.test.ts and
 * session.test.ts use), and the auth fake answers the session lookup the route
 * makes, so the mode refusals and both completions are exercised end to end.
 */

// Relative to the run, not a fixed instant: a hard-coded NOW made every fixture
// expire at midnight on the day it was written, and the suite went red the next day.
const NOW = Date.now();
const NONCE = "ME-TESTNONCE1";
const CODE = "654321";
const PHONE_HASH = "e".repeat(64);
const OPENER = "opener-1";

type UserRow = { id: string; name?: string; email?: string; phoneHash?: string | null };

type SigninRow = {
  id: string;
  nonceHash: string;
  phoneHash: string;
  inviteTokenHash: string | null;
  linkUserId: string | null;
  codeHash: string;
  boundAt: Date;
  consumedAt: Date | null;
  expiresAt: Date;
  attempts: number;
  senderAddress?: string | null;
};

function boundSignin(overrides: Partial<SigninRow> = {}): SigninRow {
  return {
    id: "row-1",
    nonceHash: sha256Hex(NONCE),
    phoneHash: PHONE_HASH,
    inviteTokenHash: null,
    linkUserId: null,
    codeHash: sha256Hex(CODE),
    boundAt: new Date(NOW - 60_000),
    consumedAt: null,
    expiresAt: new Date(NOW + 5 * 60_000),
    attempts: 0,
    senderAddress: null,
    ...overrides,
  };
}

function fakePrisma(users: UserRow[] = [], rows: SigninRow[] = []) {
  const people = users.map((user) => ({ ...user }));
  const signins = rows.map((row) => ({ ...row }));

  const mePhoneSignin = {
    findUnique: async ({ where }: { where: { nonceHash: string } }) => {
      const row = signins.find((candidate) => candidate.nonceHash === where.nonceHash);
      return row ? { ...row } : null;
    },
    // The attempt charge (attempts < MAX) and the one-time redemption
    // (consumedAt still null) are conditional updates, mirrored exactly.
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; consumedAt?: null; attempts?: { lt: number } };
      data: { consumedAt?: Date; attempts?: { increment: number } };
    }) => {
      let count = 0;
      for (const row of signins) {
        if (row.id !== where.id) continue;
        if (where.consumedAt === null && row.consumedAt !== null) continue;
        if (where.attempts && row.attempts >= where.attempts.lt) continue;
        if (data.attempts) row.attempts += data.attempts.increment;
        if (data.consumedAt) row.consumedAt = data.consumedAt;
        count += 1;
      }
      return { count };
    },
  };

  const user = {
    findUnique: async ({ where }: { where: { id?: string; phoneHash?: string } }) => {
      if ("phoneHash" in where) {
        return people.find((candidate) => candidate.phoneHash === where.phoneHash) ?? null;
      }
      return people.find((candidate) => candidate.id === where.id) ?? null;
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const found = people.find((candidate) => candidate.id === where.id);
      if (!found) throw { code: "P2025" };
      return found;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; phoneHash: null };
      data: { phoneHash: string };
    }) => {
      let count = 0;
      for (const person of people) {
        if (person.id !== where.id || person.phoneHash != null) continue;
        person.phoneHash = data.phoneHash;
        count += 1;
      }
      return { count };
    },
  };

  const prisma = {
    mePhoneSignin,
    user,
    // The attach's transaction: the fake has no rollback because the guards
    // under test here refuse before the first write (session.test.ts covers
    // the transaction's rollback semantics).
    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> =>
      work({ user, mePhoneSignin }),
  } as unknown as PrismaClient;

  return { prisma, people, signins };
}

function fakeAuth(signedInAs: string | null) {
  const issuedTo: string[] = [];
  const auth = {
    api: {
      getSession: async () => (signedInAs ? { user: { id: signedInAs } } : null),
    },
    issueSession: async (userId: string) => {
      issuedTo.push(userId);
      return { token: `token-for-${userId}`, expiresAt: new Date(NOW + 3_600_000) };
    },
    // Better Auth's $context is an already-created promise property.
    $context: Promise.resolve({
      authCookies: { sessionToken: { name: "me.session", attributes: {} } },
      secret: "test-secret",
    }),
  } as unknown as Auth;
  return { auth, issuedTo };
}

function mounted(
  fake: ReturnType<typeof fakePrisma>,
  auth: ReturnType<typeof fakeAuth>["auth"],
): Hono {
  const app = new Hono();
  mountPhoneSigninRoutes(app, {
    prisma: fake.prisma,
    auth,
    env: {
      meIdentityHashKey: "test-key",
      signupsEnabled: "false",
      signupAllowlist: "",
    } as AppEnv & SignupPolicyEnv,
    clientIp: () => undefined,
    // The welcome job's publisher; no fixture here binds a sender address, so
    // the route's post-sign-in link reports `not_attempted` and enqueues
    // nothing (session.test.ts covers the attach and its enqueue).
    jobs: { enqueue: async () => Promise.resolve() },
  });
  return app;
}

async function verifyCall(app: Hono, body: Record<string, unknown>): Promise<Response> {
  return app.request("/api/auth/phone/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("the verify route's mode decision", () => {
  it("refuses a link door with no session: 401, nothing attached", async () => {
    const fake = fakePrisma(
      [{ id: OPENER, email: "opener@x.test" }],
      [boundSignin({ linkUserId: OPENER })],
    );
    const { auth, issuedTo } = fakeAuth(null);
    const app = mounted(fake, auth);

    const response = await verifyCall(app, { nonce: NONCE, code: CODE });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(fake.people[0]!.phoneHash).toBeUndefined();
    expect(fake.signins[0]!.consumedAt).toBeNull();
    expect(issuedTo).toEqual([]);
  });

  it("refuses a link door redeemed by a different signed-in person: 403 session_mismatch, nothing attached", async () => {
    const fake = fakePrisma(
      [
        { id: OPENER, email: "opener@x.test" },
        { id: "other-1", email: "other@x.test" },
      ],
      [boundSignin({ linkUserId: OPENER })],
    );
    const { auth, issuedTo } = fakeAuth("other-1");
    const app = mounted(fake, auth);

    const response = await verifyCall(app, { nonce: NONCE, code: CODE });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "session_mismatch" });
    expect(fake.people[1]!.phoneHash).toBeUndefined();
    expect(fake.signins[0]!.consumedAt).toBeNull();
    expect(issuedTo).toEqual([]);
  });

  it("refuses a plain door that a request calls a link: 400 link_not_started, nothing attached", async () => {
    const fake = fakePrisma([{ id: OPENER, email: "opener@x.test" }], [boundSignin()]);
    const { auth, issuedTo } = fakeAuth(OPENER);
    const app = mounted(fake, auth);

    const response = await verifyCall(app, { nonce: NONCE, code: CODE, link: true });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "link_not_started" });
    // Nothing attached: no session issued, no phone on the person, code usable.
    expect(issuedTo).toEqual([]);
    expect(fake.people[0]!.phoneHash).toBeUndefined();
    expect(fake.signins[0]!.consumedAt).toBeNull();
  });

  it("completes a link door for its own signed-in opener", async () => {
    const fake = fakePrisma(
      [{ id: OPENER, email: "opener@x.test" }],
      [boundSignin({ linkUserId: OPENER })],
    );
    const { auth, issuedTo } = fakeAuth(OPENER);
    const app = mounted(fake, auth);

    const response = await verifyCall(app, { nonce: NONCE, code: CODE });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, linked: true, whatsapp: "not_attempted" });
    expect(fake.people[0]!.phoneHash).toBe(PHONE_HASH);
    expect(fake.signins[0]!.consumedAt).not.toBeNull();
    expect(issuedTo).toEqual([]);
  });

  it("signs a plain door's returning person in, with no link flag", async () => {
    const fake = fakePrisma(
      [{ id: OPENER, email: "opener@x.test", phoneHash: PHONE_HASH }],
      [boundSignin()],
    );
    const { auth, issuedTo } = fakeAuth(null);
    const app = mounted(fake, auth);

    const response = await verifyCall(app, { nonce: NONCE, code: CODE });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, whatsapp: "not_attempted" });
    expect(issuedTo).toEqual([OPENER]);
    expect(response.headers.get("set-cookie")).toContain("me.session=token-for-opener-1");
    expect(fake.signins[0]!.consumedAt).not.toBeNull();
  });
});
