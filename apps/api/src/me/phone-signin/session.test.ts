import type { PrismaClient, SignupPolicyEnv } from "@rakazo/db";
import { bootstrapUserSpace } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InviteError } from "../invitations/invitations.js";
import { sha256Hex } from "./codes.js";
import { hashIdentifier } from "./identity.js";
import { verify } from "./service.js";
import { linkVerifiedPhone, phoneUserId, signInVerifiedPhone } from "./session.js";

// Only bootstrapUserSpace is replaced; every other export of the module stays
// real, so runAsSystem and the Prisma error checks behave as in production.
vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/db")>();
  return { ...actual, bootstrapUserSpace: vi.fn() };
});

/**
 * Admission through the phone door: the invitations service is the one owner of
 * account creation. An offline fake mirrors the transaction semantics the
 * Prisma client would run against Postgres (the same shape service.test.ts
 * uses): its transaction rolls back on a throw, a statement that fails marks
 * the transaction aborted so every later statement in it fails with 25P02, and
 * a concurrent transaction's commit lands even while this one fails. The real
 * database exercises the same predicates in invitations.postgres.test.ts.
 */

const PHONE_HASH = "e".repeat(64);
const USER_ID = phoneUserId(PHONE_HASH);
const INVITER = "inviter-1";
const INVITE_HASH = "a".repeat(64);

const env: SignupPolicyEnv = { signupsEnabled: "false", signupAllowlist: "" };

/** The error Postgres gives every statement after one failed in its transaction. */
const TX_ABORTED = {
  code: "25P02",
  message: "current transaction is aborted, commands ignored until end of transaction block",
};

type UserRow = { id: string; name: string; email: string; phoneHash?: string | null };

type SigninRow = {
  id: string;
  nonceHash: string;
  phoneHash: string;
  inviteTokenHash: string | null;
  codeHash: string;
  boundAt: Date;
  consumedAt: Date | null;
  expiresAt: Date;
  attempts: number;
};

type InviteRow = {
  id: string;
  inviterId: string;
  tokenHash: string;
  status: string;
  expiresAt: Date;
};

type AuthEvent = { type: string; userId: string; via: string | null };

function fakePrisma(invites: InviteRow[] = [], options: { concurrentWinner?: boolean } = {}) {
  const users: UserRow[] = [];
  const signins: SigninRow[] = [];
  const members: string[] = [];
  const quota = { userId: INVITER, allocation: 10, redeemedCount: 0 };
  const events: AuthEvent[] = [];
  const bootstrap = vi.mocked(bootstrapUserSpace);
  let createCalls = 0;
  // Set when the simulated concurrent winner commits during a failed insert;
  // applied after this transaction rolls back, like a concurrent commit.
  let winnerCommit: (() => void) | null = null;

  const findUser = (id: string) => users.find((candidate) => candidate.id === id) ?? null;

  const user = {
    findUnique: async ({ where }: { where: { id: string; phoneHash?: string } }) => {
      if ("phoneHash" in where) {
        return users.find((candidate) => candidate.phoneHash === where.phoneHash) ?? null;
      }
      return findUser(where.id);
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const found = findUser(where.id);
      if (!found) throw { code: "P2025" };
      return found;
    },
    create: async ({ data }: { data: UserRow }) => {
      if (options.concurrentWinner && createCalls++ === 0) {
        // The concurrent first sign-in commits its person, invite claim and
        // quota count while this insert waits on the row's lock; the unique
        // constraint then rejects this insert after that commit.
        winnerCommit = () => {
          users.push({ ...data, email: "concurrent-winner@phone.invalid" });
          const invite = invites.find((candidate) => candidate.status === "issued");
          if (invite) {
            Object.assign(invite, {
              status: "redeemed",
              redeemedAt: new Date(),
              redeemedByUserId: data.id,
            });
          }
          quota.redeemedCount += 1;
        };
        throw { code: "P2002" };
      }
      if (findUser(data.id)) throw { code: "P2002" };
      if (users.some((candidate) => candidate.phoneHash && candidate.phoneHash === data.phoneHash))
        throw { code: "P2002" };
      users.push({ ...data });
      return { ...data };
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; phoneHash: null };
      data: { phoneHash: string };
    }) => {
      let count = 0;
      for (const user of users) {
        if (user.id !== where.id) continue;
        if (user.phoneHash != null) continue;
        user.phoneHash = data.phoneHash;
        count += 1;
      }
      return { count };
    },
  };

  // The door's rows, as verify() and the admission's redemption read and write
  // them: the charge is conditional on the attempt bound, the redemption on
  // `consumedAt` still being null.
  const mePhoneSignin = {
    findUnique: async ({ where }: { where: { nonceHash: string } }) =>
      signins.find((row) => row.nonceHash === where.nonceHash) ?? null,
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

  const spaceMember = {
    findFirst: async ({ where }: { where: { userId: string } }) =>
      members.includes(where.userId) ? { id: "member-1" } : null,
  };

  const meInvite = {
    findUnique: async ({ where }: { where: { tokenHash: string } }) =>
      invites.find((invite) => invite.tokenHash === where.tokenHash) ?? null,
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; status: string };
      data: Record<string, unknown>;
    }) => {
      let count = 0;
      for (const invite of invites) {
        if (invite.id !== where.id || invite.status !== where.status) continue;
        Object.assign(invite, data);
        count += 1;
      }
      return { count };
    },
  };

  const meInviteQuota = {
    findUnique: async () => quota,
    updateMany: async ({
      where,
      data,
    }: {
      where: { userId: string; redeemedCount: { lt: number } };
      data: { redeemedCount: { increment: number } };
    }) => {
      if (where.userId !== INVITER || !(quota.redeemedCount < where.redeemedCount.lt))
        return { count: 0 };
      quota.redeemedCount += data.redeemedCount.increment;
      return { count: 1 };
    },
  };

  const prisma = {
    user,
    spaceMember,
    meInvite,
    meInviteQuota,
    mePhoneSignin,
    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
      // Rollback semantics: a throw leaves none of the transaction's writes.
      const usersBefore = users.length;
      const signinsBefore = signins.map((row) => ({ ...row }));
      const invitesBefore = invites.map((invite) => ({ ...invite }));
      const redeemedBefore = quota.redeemedCount;
      let aborted = false;
      const step =
        <A, R>(op: (args: A) => Promise<R>) =>
        async (args: A): Promise<R> => {
          if (aborted) throw TX_ABORTED;
          try {
            return await op(args);
          } catch (error) {
            aborted = true;
            throw error;
          }
        };
      try {
        return await work({
          user: {
            create: step(user.create),
            findUnique: step(user.findUnique),
            findUniqueOrThrow: step(user.findUniqueOrThrow),
            updateMany: step(user.updateMany),
          },
          spaceMember: { findFirst: step(spaceMember.findFirst) },
          meInvite: {
            findUnique: step(meInvite.findUnique),
            updateMany: step(meInvite.updateMany),
          },
          meInviteQuota: {
            findUnique: step(meInviteQuota.findUnique),
            updateMany: step(meInviteQuota.updateMany),
          },
          mePhoneSignin: { updateMany: step(mePhoneSignin.updateMany) },
        });
      } catch (error) {
        users.length = usersBefore;
        signins.length = 0;
        signinsBefore.forEach((row) => signins.push({ ...row }));
        invitesBefore.forEach((snapshot, index) => {
          const invite = invites[index];
          if (invite) Object.assign(invite, snapshot);
        });
        quota.redeemedCount = redeemedBefore;
        // A concurrent transaction's commit lands even though this one failed.
        winnerCommit?.();
        throw error;
      }
    },
  } as unknown as PrismaClient;

  const auth = {
    issueSession: async (id: string) => ({
      token: `token-for-${id}`,
      expiresAt: new Date(Date.parse("2026-11-17T13:00:00Z")),
    }),
    // The emitter the auth config's user-create hook runs, recorded here.
    recordUserCreated: async (person: { id: string }, via: string | null) => {
      events.push({ type: "auth.sign_up", userId: person.id, via });
    },
  } as never;

  bootstrap.mockImplementation(async (_client, person) => {
    members.push(person.id);
    return { spaceId: `space-for-${person.id}` };
  });

  return { prisma, auth, users, signins, invites, quota, bootstrap, events };
}

function issuedInvite(): InviteRow {
  return {
    id: "invite-1",
    inviterId: INVITER,
    tokenHash: INVITE_HASH,
    status: "issued",
    expiresAt: new Date(Date.parse("2026-12-01T00:00:00Z")),
  };
}

/** A noop redemption for tests that do not exercise the code's consume. */
const noopRedeem = async () => {};

const NOW = Date.parse("2026-11-18T12:00:00Z");
const NONCE = "ME-TESTNONCE1";
const CODE = "654321";
const config = { identityHashKey: "test-key", now: () => NOW };

function boundSignin(overrides: Partial<SigninRow> = {}): SigninRow {
  return {
    id: "row-1",
    nonceHash: sha256Hex(NONCE),
    phoneHash: PHONE_HASH,
    inviteTokenHash: null,
    codeHash: sha256Hex(CODE),
    boundAt: new Date(NOW - 60_000),
    consumedAt: null,
    expiresAt: new Date(NOW + 5 * 60_000),
    attempts: 0,
    ...overrides,
  };
}

describe("phone door admission", () => {
  beforeEach(() => {
    vi.mocked(bootstrapUserSpace).mockReset();
  });

  it("refuses a sign-in with no invite by name and writes no user", async () => {
    const fake = fakePrisma([]);

    await expect(
      signInVerifiedPhone(fake.prisma, fake.auth, env, PHONE_HASH, {}, null, noopRedeem),
    ).rejects.toMatchObject({ reason: "invite_required" });
    expect(fake.users).toHaveLength(0);
    expect(fake.bootstrap).not.toHaveBeenCalled();
  });

  it("keeps a correct code usable when admission refuses, then redeems the same code once invited", async () => {
    const fake = fakePrisma([issuedInvite()]);
    fake.signins.push(boundSignin());

    const refused = await verify(fake.prisma, config, { nonce: NONCE, code: CODE });
    await expect(
      signInVerifiedPhone(fake.prisma, fake.auth, env, PHONE_HASH, {}, null, refused.redeem),
    ).rejects.toMatchObject({ reason: "invite_required" });
    // The refusal consumed nothing: the code is still redeemable.
    expect(fake.signins[0]!.consumedAt).toBeNull();
    expect(fake.users).toHaveLength(0);

    // The same nonce, now carrying the invite hash, admits the person on the same code.
    fake.signins[0]!.inviteTokenHash = INVITE_HASH;
    const invited = await verify(fake.prisma, config, { nonce: NONCE, code: CODE });
    const session = await signInVerifiedPhone(
      fake.prisma,
      fake.auth,
      env,
      PHONE_HASH,
      {},
      INVITE_HASH,
      invited.redeem,
    );
    expect(session.userId).toBe(USER_ID);
    expect(fake.signins[0]!.consumedAt).not.toBeNull();
    expect(fake.invites[0]!.status).toBe("redeemed");
  });

  it("rolls the code's consume back when the invite cannot be claimed", async () => {
    const spent = { ...issuedInvite(), status: "redeemed" };
    const fake = fakePrisma([spent]);
    fake.signins.push(boundSignin({ inviteTokenHash: INVITE_HASH }));

    const verified = await verify(fake.prisma, config, { nonce: NONCE, code: CODE });
    await expect(
      signInVerifiedPhone(fake.prisma, fake.auth, env, PHONE_HASH, {}, INVITE_HASH, verified.redeem),
    ).rejects.toMatchObject({ reason: "already_redeemed" });
    expect(fake.signins[0]!.consumedAt).toBeNull();
    expect(fake.users).toHaveLength(0);
  });

  it("creates exactly one account with a valid invite and spends it once", async () => {
    const fake = fakePrisma([issuedInvite()]);

    const session = await signInVerifiedPhone(
      fake.prisma,
      fake.auth,
      env,
      PHONE_HASH,
      {},
      INVITE_HASH,
      noopRedeem,
    );

    expect(session.userId).toBe(USER_ID);
    expect(fake.users).toHaveLength(1);
    expect(fake.users[0]!.id).toBe(USER_ID);
    expect(fake.invites[0]!.status).toBe("redeemed");
    expect(fake.quota.redeemedCount).toBe(1);
    expect(fake.bootstrap).toHaveBeenCalledTimes(1);
    // The account-created audit trail has the auth layer's one shape.
    expect(fake.events).toEqual([{ type: "auth.sign_up", userId: USER_ID, via: "phone" }]);

    // The spent invite admits nobody else: a second phone using the same token
    // is refused with the invitations service's own reason and writes no user.
    const otherHash = hashIdentifier("phone", "k", "15550002000");
    await expect(
      signInVerifiedPhone(fake.prisma, fake.auth, env, otherHash, {}, INVITE_HASH, noopRedeem),
    ).rejects.toBeInstanceOf(InviteError);
    expect(fake.users).toHaveLength(1);
    expect(fake.quota.redeemedCount).toBe(1);
    // The refused attempt created and rolled back a person, so it emitted nothing.
    expect(fake.events).toHaveLength(1);
  });

  it("converges when a concurrent first sign-in creates the person first", async () => {
    const fake = fakePrisma([issuedInvite()], { concurrentWinner: true });

    const session = await signInVerifiedPhone(
      fake.prisma,
      fake.auth,
      env,
      PHONE_HASH,
      {},
      INVITE_HASH,
      noopRedeem,
    );

    // The loser joins the winner's committed row instead of surfacing the
    // aborted transaction, and the winner's claim stands, spent exactly once.
    expect(session.userId).toBe(USER_ID);
    expect(fake.users).toHaveLength(1);
    expect(fake.invites[0]!.status).toBe("redeemed");
    expect(fake.quota.redeemedCount).toBe(1);
    // The loser bootstraps nothing and emits nothing: the winner owns both.
    expect(fake.bootstrap).not.toHaveBeenCalled();
    expect(fake.events).toHaveLength(0);
  });

  it("refuses person creation when the invite cannot be claimed, writing no user", async () => {
    const spent = { ...issuedInvite(), status: "redeemed" };
    const fake = fakePrisma([spent]);

    await expect(
      signInVerifiedPhone(fake.prisma, fake.auth, env, PHONE_HASH, {}, INVITE_HASH, noopRedeem),
    ).rejects.toMatchObject({ reason: "already_redeemed" });
    expect(fake.users).toHaveLength(0);
    expect(fake.bootstrap).not.toHaveBeenCalled();
  });

  it("signs a returning person in again with no invite", async () => {
    const fake = fakePrisma([issuedInvite()]);
    fake.users.push({ id: USER_ID, name: "Phone person", email: "phone-x@phone.invalid" });

    const session = await signInVerifiedPhone(
      fake.prisma,
      fake.auth,
      env,
      PHONE_HASH,
      {},
      null,
      noopRedeem,
    );

    expect(session.token).toBe(`token-for-${USER_ID}`);
    expect(fake.users).toHaveLength(1);
    // A returning person is not a new account, so the audit trail is silent.
    expect(fake.events).toHaveLength(0);
    // The untouched invite is still spendable by a new person later.
    expect(fake.invites[0]!.status).toBe("issued");
    expect(fake.quota.redeemedCount).toBe(0);
  });

  it("signs a linked account in: the owner bootstrap's phone reaches the same user, with no invite", async () => {
    const fake = fakePrisma([]);
    // The account the email bootstrap created, carrying the phone's hash.
    fake.users.push({ id: "owner-1", name: "Account", email: "owner@x.test", phoneHash: PHONE_HASH });

    const session = await signInVerifiedPhone(
      fake.prisma,
      fake.auth,
      env,
      PHONE_HASH,
      {},
      null,
      noopRedeem,
    );

    expect(session.userId).toBe("owner-1");
    expect(fake.users).toHaveLength(1);
    expect(fake.bootstrap).not.toHaveBeenCalled();
    expect(fake.events).toHaveLength(0);
  });

  it("creates a phone person carrying the phone's hash", async () => {
    const fake = fakePrisma([issuedInvite()]);

    const session = await signInVerifiedPhone(
      fake.prisma,
      fake.auth,
      env,
      PHONE_HASH,
      {},
      INVITE_HASH,
      noopRedeem,
    );

    expect(session.userId).toBe(USER_ID);
    expect(fake.users[0]!.phoneHash).toBe(PHONE_HASH);
  });

  it("attaches a verified phone to the signed-in person", async () => {
    const fake = fakePrisma([]);
    fake.users.push({ id: "owner-1", name: "Account", email: "owner@x.test" });
    fake.signins.push(boundSignin());
    // The real redemption the door hands back: a conditional update on the row.
    const redeem = vi.fn(async (client: { mePhoneSignin: { updateMany: (args: {
      where: { id: string; consumedAt: null };
      data: { consumedAt: Date };
    }) => Promise<{ count: number }> } }) => {
      const redeemed = await client.mePhoneSignin.updateMany({
        where: { id: "row-1", consumedAt: null },
        data: { consumedAt: new Date(NOW) },
      });
      if (redeemed.count !== 1) throw Object.assign(new Error("code_invalid"), { reason: "code_invalid" });
    });

    await linkVerifiedPhone(fake.prisma, PHONE_HASH, "owner-1", redeem);

    expect(fake.users[0]!.phoneHash).toBe(PHONE_HASH);
    // The attach redeemed the code inside its own transaction.
    expect(redeem).toHaveBeenCalledTimes(1);
    expect(fake.signins[0]!.consumedAt).not.toBeNull();
  });

  it("refuses a link of a phone another person holds, leaving the code usable", async () => {
    const fake = fakePrisma([]);
    fake.users.push({ id: "holder-1", name: "Other", email: "other@x.test", phoneHash: PHONE_HASH });
    fake.users.push({ id: "owner-1", name: "Account", email: "owner@x.test" });
    fake.signins.push(boundSignin());

    await expect(
      linkVerifiedPhone(fake.prisma, PHONE_HASH, "owner-1", noopRedeem),
    ).rejects.toMatchObject({ reason: "already_bound" });
    expect(fake.users[1]!.phoneHash).toBeUndefined();
    // The refusal rolled the consume back.
    expect(fake.signins[0]!.consumedAt).toBeNull();
  });

  it("refuses a link of a phone a phone-created person already owns", async () => {
    const fake = fakePrisma([]);
    // An account created before the hash column: reachable only by the derived id.
    fake.users.push({ id: USER_ID, name: "Phone person", email: "phone-x@phone.invalid" });
    fake.users.push({ id: "owner-1", name: "Account", email: "owner@x.test" });
    fake.signins.push(boundSignin());

    await expect(
      linkVerifiedPhone(fake.prisma, PHONE_HASH, "owner-1", noopRedeem),
    ).rejects.toMatchObject({ reason: "already_bound" });
    expect(fake.users[1]!.phoneHash).toBeUndefined();
  });

  it("refuses a link onto a person who already carries a different phone", async () => {
    const fake = fakePrisma([]);
    fake.users.push({
      id: "owner-1",
      name: "Account",
      email: "owner@x.test",
      phoneHash: "b".repeat(64),
    });
    fake.signins.push(boundSignin());

    await expect(
      linkVerifiedPhone(fake.prisma, PHONE_HASH, "owner-1", noopRedeem),
    ).rejects.toMatchObject({ reason: "already_bound" });
    expect(fake.users[0]!.phoneHash).toBe("b".repeat(64));
  });
});
