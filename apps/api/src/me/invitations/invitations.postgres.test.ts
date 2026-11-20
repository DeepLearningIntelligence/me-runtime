import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueInvite, listInvites, redeemInvite } from "./invitations.js";

/**
 * The true concurrency proof for D-RUN-7: two redeemers racing one token must
 * produce exactly one account and one quota count. Needs Postgres; without
 * VERIFY_DATABASE it is skipped, and the guard is then proven by the unit
 * suite's interleaved racer test and the two mutations on the predicates.
 */

const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

dbTests("concurrent redeem of one invite token", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  let token: string;
  const inviterId = `meinvite-${stamp}`;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
    await prisma.user.create({
      data: {
        id: inviterId,
        name: "Ada Lovelace",
        email: `${inviterId}@rakazo.test`,
        emailVerified: true,
      },
    });
    // The claim records the redeemer in a real foreign key (the phone door
    // creates the person in the same transaction), so the racers must be
    // existing accounts for the race to reach the compare-and-swap at all.
    await prisma.user.createMany({
      data: [`first-${stamp}`, `second-${stamp}`].map((id) => ({
        id,
        name: id,
        email: `${id}@rakazo.test`,
        emailVerified: true,
      })),
    });
    token = (await issueInvite(prisma, { inviterUserId: inviterId, allocation: 10, ttlDays: 14 }))
      .token;
  });

  afterAll(async () => {
    // Redeemer rows are not the inviter's cascade; remove them explicitly.
    await prisma.user.deleteMany({
      where: { id: { in: [`first-${stamp}`, `second-${stamp}`] } },
    });
    await prisma.user.deleteMany({ where: { id: inviterId } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("gives exactly one redeemer the account", async () => {
    // Both racers read the row as issued; only the first claim's predicate holds.
    const settled = await Promise.allSettled([
      redeemInvite(prisma, { token, userId: `first-${stamp}` }),
      redeemInvite(prisma, { token, userId: `second-${stamp}` }),
    ]);

    const succeeded = settled.filter((result) => result.status === "fulfilled");
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]).toMatchObject({
      value: { inviterId, inviterName: "Ada Lovelace" },
    });

    const quota = await prisma.meInviteQuota.findUnique({ where: { userId: inviterId } });
    // One grant, one redemption: the loser's increment rolled back with its
    // transaction.
    expect(quota).toMatchObject({ allocation: 10, grantedCount: 1, redeemedCount: 1 });
  });
});

dbTests("concurrent first read of one inviter's quota", () => {
  const stamp = `${process.pid}-${Date.now()}-list`;
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  const inviterId = `meinvite-list-${stamp}`;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
    await prisma.user.create({
      data: {
        id: inviterId,
        name: "Ada Lovelace",
        email: `${inviterId}@rakazo.test`,
        emailVerified: true,
      },
    });
  });

  afterAll(async () => {
    // Covers the per-case inviters as well as the shared one; quota rows cascade.
    await prisma.user.deleteMany({ where: { id: { startsWith: inviterId } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("adopts a committed row when its insert loses the race", async () => {
    // The race is made deterministic: one client inserts the row and holds the
    // transaction open, so the reader's own insert provably blocks on the unique
    // index. When the writer commits, the reader loses the insert and must adopt
    // the committed row, including its allocation, rather than overwrite it.
    const readerId = `${inviterId}-race`;
    await prisma.user.create({
      data: {
        id: readerId,
        name: readerId,
        email: `${readerId}@rakazo.test`,
        emailVerified: true,
      },
    });

    const holder = await holdUncommittedQuotaRow(readerId, 10);
    try {
      const listed = listInvites(prisma, { inviterUserId: readerId, allocation: 99 });
      listed.catch(() => undefined);
      await holder.waitForBlocked();
      await holder.commit();

      await expect(listed).resolves.toMatchObject({
        quota: { allocation: 10, grantedCount: 0, redeemedCount: 0 },
        invites: [],
      });
      await expect(
        prisma.meInviteQuota.findUnique({ where: { userId: readerId } }),
      ).resolves.toMatchObject({ allocation: 10, grantedCount: 0, redeemedCount: 0 });
      expect(await prisma.meInviteQuota.count({ where: { userId: readerId } })).toBe(1);
    } finally {
      await holder.close();
    }
  });

  it("retries once when the first issue loses the quota insert race", async () => {
    // Same held insert: the issue call's transaction aborts with the unique
    // violation, and the retry must grant its link against the row the other
    // writer created, adopting that row's allocation instead of its own.
    const issuerId = `${inviterId}-issue`;
    await prisma.user.create({
      data: {
        id: issuerId,
        name: issuerId,
        email: `${issuerId}@rakazo.test`,
        emailVerified: true,
      },
    });

    const holder = await holdUncommittedQuotaRow(issuerId, 10);
    try {
      const issued = issueInvite(prisma, {
        inviterUserId: issuerId,
        allocation: 99,
        ttlDays: 14,
      });
      issued.catch(() => undefined);
      await holder.waitForBlocked();
      await holder.commit();

      await expect(issued).resolves.toMatchObject({
        token: expect.any(String),
        expiresAt: expect.any(Date),
      });
      await expect(
        prisma.meInviteQuota.findUnique({ where: { userId: issuerId } }),
      ).resolves.toMatchObject({ allocation: 10, grantedCount: 1, redeemedCount: 0 });
      expect(await prisma.meInvite.count({ where: { inviterId: issuerId } })).toBe(1);
    } finally {
      await holder.close();
    }
  });

  it("keeps a returning inviter's counters and allocation", async () => {
    const seeded = await listInvites(prisma, { inviterUserId: inviterId, allocation: 10 });
    expect(seeded.quota).toEqual({ allocation: 10, grantedCount: 0, redeemedCount: 0 });
    // Counters only move through issue and redeem; a later read cannot reseed them.
    await prisma.meInviteQuota.update({
      where: { userId: inviterId },
      data: { grantedCount: 3, redeemedCount: 1 },
    });

    const listed = await listInvites(prisma, { inviterUserId: inviterId, allocation: 99 });

    expect(listed.quota).toEqual({ allocation: 10, grantedCount: 3, redeemedCount: 1 });
    expect(await prisma.meInviteQuota.count({ where: { userId: inviterId } })).toBe(1);
  });
});

type HolderDb = ReturnType<typeof createDb>;

/** Holds a quota row uncommitted so a losing insert provably blocks on the unique index. */
async function holdUncommittedQuotaRow(userId: string, allocation: number): Promise<HolderHandle> {
  return setupQuotaHolder(createDb(process.env.DATABASE_URL!), userId, allocation);
}

type HolderHandle = {
  waitForBlocked: () => Promise<void>;
  commit: () => Promise<void>;
  close: () => Promise<void>;
};

/** The setup is separable so a transaction that cannot start can be tested. */
async function setupQuotaHolder(
  db: HolderDb,
  userId: string,
  allocation: number,
): Promise<HolderHandle> {
  const client = asSystem(db.prisma);
  let holderPid!: number;
  let hasInserted!: () => void;
  const ready = new Promise<void>((resolve) => {
    hasInserted = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transaction = client.$transaction(async (tx) => {
    const [pidRow] = await tx.$queryRaw<
      Array<{ pid: number }>
    >`SELECT pg_backend_pid()::int AS pid`;
    if (!pidRow) throw new Error("could not read the holder backend pid");
    holderPid = pidRow.pid;
    await tx.meInviteQuota.create({ data: { userId, allocation } });
    hasInserted();
    await released;
  });
  // Prevent an unhandled rejection; callers still get the error from commit().
  transaction.catch(() => undefined);
  try {
    await Promise.race([ready, transaction]);
  } catch (error) {
    // The caller never received this holder, so clean up its resources here and
    // rethrow the original setup error even if cleanup also fails.
    release();
    await transaction.catch(() => undefined);
    try {
      await db.prisma.$disconnect();
    } catch {
      // cleanup is best effort
    }
    try {
      await db.pool.end();
    } catch {
      // cleanup is best effort
    }
    throw error;
  }
  let settled = false;
  const settle = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    release();
    await transaction.catch(() => undefined);
  };
  return {
    waitForBlocked: () => waitForBlockedQuotaInsert(client, holderPid),
    commit: async () => {
      if (settled) return;
      settled = true;
      release();
      await transaction; // propagate transaction errors
    },
    close: async () => {
      await settle();
      await db.prisma.$disconnect();
      await db.pool.end();
    },
  };
}

/** Waits until a backend is provably blocked by the specific holder transaction. */
async function waitForBlockedQuotaInsert(client: PrismaClient, holderPid: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // The holder's backend pid must appear in the blocked backend's
    // pg_blocking_pids(), and the blocked statement must target the quota
    // table, so an unrelated waiter cannot satisfy the poll.
    const [row] = await client.$queryRaw<Array<{ blocked: number }>>`
      SELECT count(*)::int AS blocked
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND pid <> pg_backend_pid()
        AND pg_blocking_pids(pid) @> ARRAY[${holderPid}::int]
        AND query ILIKE '%me_invite_quotas%'
    `;
    if (row && row.blocked > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the reader never blocked on the holder's transaction");
}

describe("quota holder setup", () => {
  it("rejects and cleans up when the transaction cannot start", async () => {
    // $transaction rejects before its callback runs, so the readiness promise
    // can never resolve. The race must surface this error and clean up.
    const setupError = new Error("connection unavailable");
    let disconnected = 0;
    let poolEnded = 0;
    const fakeDb = {
      prisma: {
        $transaction: async () => {
          throw setupError;
        },
        $disconnect: async () => {
          disconnected += 1;
        },
      },
      pool: {
        end: async () => {
          poolEnded += 1;
        },
      },
    } as unknown as HolderDb;

    await expect(setupQuotaHolder(fakeDb, "inviter", 10)).rejects.toBe(setupError);
    expect(disconnected).toBe(1);
    expect(poolEnded).toBe(1);
  });
});
