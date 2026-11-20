import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hashInviteToken,
  inspectInvite,
  issueInvite,
  listInvites,
  redeemInvite,
  revokeInvite,
} from "./invitations.js";

/**
 * Unit tests over an in-memory prisma double. Reads see the committed rows plus
 * the calling transaction's own writes, never another open transaction's, and
 * a failed transaction discards its writes while committed ones stand: the
 * READ COMMITTED semantics the redeem guard relies on. The true concurrency
 * proof is invitations.postgres.test.ts, which needs Postgres.
 */

type Row = Record<string, unknown>;
type Overlay = Map<string, Row>;

interface PrismaDouble {
  meInviteQuota: {
    upsert(args: { where: Row; create: Row; update: Row }): Promise<Row>;
    updateMany(args: { where: Row; data: Row }): Promise<{ count: number }>;
    findUnique(args: { where: Row }): Promise<Row | null>;
  };
  meInvite: {
    create(args: { data: Row; select?: Row }): Promise<Row>;
    findUnique(args: { where: Row; select?: Row }): Promise<Row | null>;
    findMany(args: { where: Row; select?: Row }): Promise<Row[]>;
    updateMany(args: { where: Row; data: Row }): Promise<{ count: number }>;
  };
  user: { findUnique(args: { where: Row }): Promise<Row | null> };
  $transaction(work: (tx: PrismaDouble) => Promise<unknown>): Promise<unknown>;
}

const DAY_MS = 86_400_000;

let committed: { quotas: Row[]; invites: Row[]; users: Row[] };
let overlay: Overlay | undefined;
/** Runs just before a claim predicate is applied, so a test can interleave a racer. */
let beforeClaim: (() => Promise<unknown>) | undefined;

function keyOf(collection: "quota" | "invite", row: Row): string {
  return collection === "quota" ? `quota:${row.userId}` : `invite:${row.tokenHash}`;
}

function committedRows(collection: "quota" | "invite" | "user"): Row[] {
  if (collection === "quota") return committed.quotas;
  if (collection === "invite") return committed.invites;
  return committed.users;
}

function store(collection: "quota" | "invite", row: Row): void {
  const rows = committedRows(collection);
  const key = keyOf(collection, row);
  const index = rows.findIndex((candidate) => keyOf(collection, candidate) === key);
  if (index >= 0) rows[index] = row;
  else rows.push(row);
}

/** The row a read sees: the transaction's own write, or the committed one. */
function visible(
  collection: "quota" | "invite" | "user",
  match: (row: Row) => boolean,
): Row | undefined {
  for (const row of committedRows(collection)) {
    if (!match(row)) continue;
    if (overlay) return overlay.get(keyOf(collection as "quota" | "invite", row)) ?? row;
    return row;
  }
  return undefined;
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition !== null && typeof condition === "object" && "lt" in (condition as object)) {
      return (row[key] as number) < (condition as { lt: number }).lt;
    }
    if (condition !== null && typeof condition === "object" && "gt" in (condition as object)) {
      return (row[key] as number) > (condition as { gt: number }).gt;
    }
    return row[key] === condition;
  });
}

function apply(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && "increment" in (value as object)) {
      row[key] = (row[key] as number) + (value as { increment: number }).increment;
    } else if (value !== null && typeof value === "object" && "decrement" in (value as object)) {
      row[key] = (row[key] as number) - (value as { decrement: number }).decrement;
    } else {
      row[key] = value;
    }
  }
}

async function updateMany(
  collection: "quota" | "invite",
  { where, data }: { where: Row; data: Row },
): Promise<{ count: number }> {
  if (collection === "invite" && beforeClaim) {
    // Stands in for a racer whose claim commits between this read and this write.
    const hook = beforeClaim;
    beforeClaim = undefined;
    await hook();
  }
  const candidates = new Map<string, Row>();
  for (const row of committedRows(collection)) {
    if (matches(row, where)) {
      candidates.set(keyOf(collection, row), overlay?.get(keyOf(collection, row)) ?? row);
    }
  }
  if (overlay) {
    for (const [key, row] of overlay) {
      if (key.startsWith(`${collection}:`) && matches(row, where)) candidates.set(key, row);
    }
  }
  for (const [key, row] of candidates) {
    const written = { ...row };
    apply(written, data);
    if (overlay) overlay.set(key, written);
    else store(collection, written);
  }
  return { count: candidates.size };
}

const prisma: PrismaDouble = {
  meInviteQuota: {
    upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const found = visible("quota", (row) => row.userId === where.userId);
      if (found) {
        const written = { ...found };
        apply(written, update);
        if (overlay) overlay.set(`quota:${where.userId}`, written);
        else store("quota", written);
        return written;
      }
      const row = { ...create, grantedCount: 0, redeemedCount: 0 };
      if (overlay) overlay.set(`quota:${where.userId}`, row);
      else store("quota", row);
      return row;
    },
    updateMany: (args: { where: Row; data: Row }) => updateMany("quota", args),
    findUnique: async ({ where }: { where: Row }) =>
      visible("quota", (row) => row.userId === where.userId) ?? null,
  },
  meInvite: {
    create: async ({ data, select }: { data: Row; select?: Row }) => {
      const row: Row = {
        createdAt: new Date(),
        redeemedAt: null,
        redeemedByUserId: null,
        revokedAt: null,
        status: "issued",
        ...data,
        id: `invite-${committed.invites.length + 1}`,
      };
      if (overlay) overlay.set(`invite:${row.tokenHash}`, row);
      else store("invite", row);
      return select ? { id: row.id } : row;
    },
    findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
      const row = visible("invite", (candidate) => candidate.tokenHash === where.tokenHash);
      if (!row) return null;
      if (select?.inviter) {
        return {
          ...row,
          inviter: committed.users.find((user) => user.id === row.inviterId) ?? null,
        };
      }
      return row;
    },
    findMany: async ({ where, select }: { where: Row; select?: Row }) => {
      const rows = committed.invites.filter((row) => matches(row, where));
      if (overlay) {
        for (const [key, row] of overlay) {
          if (!key.startsWith("invite:") || !matches(row, where)) continue;
          if (!rows.some((candidate) => candidate.tokenHash === row.tokenHash)) rows.push(row);
        }
      }
      return rows.map((row) => (select ? { ...row } : row));
    },
    updateMany: (args: { where: Row; data: Row }) => updateMany("invite", args),
  },
  user: {
    findUnique: async ({ where }: { where: Row }) =>
      committed.users.find((user) => user.id === where.id) ?? null,
  },
  $transaction: async (work: (tx: PrismaDouble) => Promise<unknown>) => {
    const previous = overlay;
    const mine: Overlay = new Map();
    overlay = mine;
    try {
      const result = await work(prisma);
      // Commit: this transaction's writes become the rows every later read sees.
      for (const [key, row] of mine) store(key.startsWith("quota:") ? "quota" : "invite", row);
      return result;
    } finally {
      overlay = previous;
    }
  },
};

const service = prisma as unknown as Parameters<typeof issueInvite>[0];

async function seedUser(id: string, name: string) {
  committed.users.push({ id, name });
}

async function issue(inviterId = "inviter") {
  return (await issueInvite(service, { inviterUserId: inviterId, allocation: 10, ttlDays: 14 }))
    .token;
}

describe("invitations", () => {
  beforeEach(() => {
    committed = { quotas: [], invites: [], users: [] };
    overlay = undefined;
    beforeClaim = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("issue then redeem succeeds once and returns the inviter", async () => {
    await seedUser("inviter", "Ada Lovelace");
    const token = await issue();

    const redeemed = await redeemInvite(service, { token, userId: "joiner" });
    expect(redeemed).toEqual({ inviterId: "inviter", inviterName: "Ada Lovelace" });
    expect(committed.invites[0]!).toMatchObject({
      status: "redeemed",
      redeemedByUserId: "joiner",
    });

    await expect(redeemInvite(service, { token, userId: "joiner" })).rejects.toMatchObject({
      name: "InviteError",
      reason: "already_redeemed",
    });
  });

  it("a racer whose read predates another's claim still cannot claim it", async () => {
    // The interleaving the database would produce: both racers read the row as
    // issued; the first commits its claim while the second holds the stale read;
    // the second's claim predicate must re-check and refuse, and its quota
    // increment must be discarded with its transaction.
    await seedUser("inviter", "Ada Lovelace");
    const token = await issue();
    const raced = redeemInvite(service, { token, userId: "second" });
    beforeClaim = () => redeemInvite(service, { token, userId: "first" });

    await expect(raced).rejects.toMatchObject({ reason: "already_redeemed" });
    expect(committed.invites[0]!).toMatchObject({
      status: "redeemed",
      redeemedByUserId: "first",
    });
    expect(committed.quotas[0]!).toMatchObject({ grantedCount: 1, redeemedCount: 1 });
  });

  it("the 11th invite is refused by name", async () => {
    await seedUser("inviter", "Ada Lovelace");
    for (let i = 0; i < 10; i += 1) await issue();
    expect(committed.quotas[0]!.grantedCount).toBe(10);

    await expect(
      issueInvite(service, { inviterUserId: "inviter", allocation: 10, ttlDays: 14 }),
    ).rejects.toMatchObject({ name: "InviteError", reason: "quota_exceeded" });
    expect(committed.quotas[0]!.grantedCount).toBe(10);
    expect(committed.invites).toHaveLength(10);
  });

  it("an expired token is refused by name", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    await seedUser("inviter", "Ada Lovelace");
    const token = await issue();

    vi.setSystemTime(new Date("2026-12-01T12:00:00Z"));
    expect(await inspectInvite(service, token)).toEqual({ ok: false, reason: "expired" });
    await expect(redeemInvite(service, { token, userId: "joiner" })).rejects.toMatchObject({
      reason: "expired",
    });
  });

  it("redemption counts against the inviter's quota exactly once", async () => {
    await seedUser("inviter", "Ada Lovelace");
    const token = await issue();

    await redeemInvite(service, { token, userId: "joiner" });
    expect(committed.quotas[0]!).toMatchObject({ grantedCount: 1, redeemedCount: 1 });

    await expect(redeemInvite(service, { token, userId: "joiner" })).rejects.toMatchObject({
      reason: "already_redeemed",
    });
    expect(committed.quotas[0]!).toMatchObject({ grantedCount: 1, redeemedCount: 1 });
  });

  it("a full quota refuses a redemption by name", async () => {
    await seedUser("inviter", "Ada Lovelace");
    const token = await issue();
    committed.quotas[0]!.redeemedCount = 10;

    await expect(redeemInvite(service, { token, userId: "joiner" })).rejects.toMatchObject({
      reason: "quota_exceeded",
    });
    expect(committed.quotas[0]!.redeemedCount).toBe(10);
  });

  it("an unknown token is refused by name", async () => {
    expect(await inspectInvite(service, "no-such-token")).toEqual({ ok: false, reason: "invalid" });
    await expect(
      redeemInvite(service, { token: "no-such-token", userId: "joiner" }),
    ).rejects.toMatchObject({ reason: "invalid" });
  });

  it("a revoked token is refused by name", async () => {
    await seedUser("inviter", "Ada Lovelace");
    const token = await issue();
    expect(
      await revokeInvite(service, {
        inviterUserId: "inviter",
        id: committed.invites[0]!.id as string,
      }),
    ).toBe(true);

    expect(await inspectInvite(service, token)).toEqual({ ok: false, reason: "revoked" });
    await expect(redeemInvite(service, { token, userId: "joiner" })).rejects.toMatchObject({
      reason: "revoked",
    });
  });

  it("withdrawing an outstanding invite returns its slot to the pool", async () => {
    await seedUser("inviter", "Ada Lovelace");
    const issued = await issueInvite(service, {
      inviterUserId: "inviter",
      allocation: 1,
      ttlDays: 14,
    });
    // The only slot is held by the outstanding link.
    await expect(
      issueInvite(service, { inviterUserId: "inviter", allocation: 1, ttlDays: 14 }),
    ).rejects.toMatchObject({ reason: "quota_exceeded" });

    expect(await revokeInvite(service, { inviterUserId: "inviter", id: issued.id })).toBe(true);
    expect(committed.quotas[0]!).toMatchObject({ grantedCount: 0, redeemedCount: 0 });
    expect((await listInvites(service, { inviterUserId: "inviter", allocation: 1 })).quota).toEqual(
      { allocation: 1, grantedCount: 0, redeemedCount: 0 },
    );

    // The released slot mints a replacement link.
    await issueInvite(service, { inviterUserId: "inviter", allocation: 1, ttlDays: 14 });
    expect(committed.quotas[0]!).toMatchObject({ grantedCount: 1, redeemedCount: 0 });
    expect(committed.invites).toHaveLength(2);
  });

  it("a second withdrawal releases no slot", async () => {
    await seedUser("inviter", "Ada Lovelace");
    const issued = await issueInvite(service, {
      inviterUserId: "inviter",
      allocation: 1,
      ttlDays: 14,
    });

    expect(await revokeInvite(service, { inviterUserId: "inviter", id: issued.id })).toBe(true);
    expect(await revokeInvite(service, { inviterUserId: "inviter", id: issued.id })).toBe(false);
    expect(committed.quotas[0]!).toMatchObject({ grantedCount: 0 });
    expect(committed.invites[0]!).toMatchObject({ status: "revoked" });
  });

  it("withdrawing a redeemed invite releases no slot", async () => {
    await seedUser("inviter", "Ada Lovelace");
    const issued = await issueInvite(service, {
      inviterUserId: "inviter",
      allocation: 1,
      ttlDays: 14,
    });
    await redeemInvite(service, { token: issued.token, userId: "joiner" });

    expect(await revokeInvite(service, { inviterUserId: "inviter", id: issued.id })).toBe(false);
    expect(committed.quotas[0]!).toMatchObject({ grantedCount: 1, redeemedCount: 1 });
  });

  it("redeeming still consumes an available slot", async () => {
    await seedUser("inviter", "Ada Lovelace");
    const issued = await issueInvite(service, {
      inviterUserId: "inviter",
      allocation: 1,
      ttlDays: 14,
    });

    expect(await redeemInvite(service, { token: issued.token, userId: "joiner" })).toEqual({
      inviterId: "inviter",
      inviterName: "Ada Lovelace",
    });
    expect(committed.quotas[0]!).toMatchObject({ grantedCount: 1, redeemedCount: 1 });
    await expect(
      issueInvite(service, { inviterUserId: "inviter", allocation: 1, ttlDays: 14 }),
    ).rejects.toMatchObject({ reason: "quota_exceeded" });
  });

  it("the welcome page sees who invited them", async () => {
    await seedUser("inviter", "Ada Lovelace");
    const token = await issue();

    const inspection = await inspectInvite(service, token);
    expect(inspection.ok).toBe(true);
    if (inspection.ok) {
      expect(inspection.inviterName).toBe("Ada Lovelace");
      // 14 days from the issue moment, within a second.
      expect(Math.abs(inspection.expiresAt.getTime() - (Date.now() + 14 * DAY_MS))).toBeLessThan(
        1000,
      );
    }
  });

  it("the meter reads the quota row, seeded once from config", async () => {
    await seedUser("inviter", "Ada Lovelace");
    await issue();

    const listed = await listInvites(service, { inviterUserId: "inviter", allocation: 10 });
    expect(listed.quota).toEqual({ allocation: 10, grantedCount: 1, redeemedCount: 0 });
    expect(listed.invites).toHaveLength(1);

    // A second read never re-seeds the allowance from config.
    await listInvites(service, { inviterUserId: "inviter", allocation: 99 });
    expect(committed.quotas[0]!.allocation).toBe(10);
  });

  it("stores only the token's hash", async () => {
    await seedUser("inviter", "Ada Lovelace");
    const token = await issue();

    expect(committed.invites[0]!.tokenHash).toBe(hashInviteToken(token));
    expect(JSON.stringify(committed)).not.toContain(token);
  });
});

describe("issueInvite quota retry narrowing", () => {
  beforeEach(() => {
    committed = { quotas: [], invites: [], users: [] };
    overlay = undefined;
    beforeClaim = undefined;
  });

  it("propagates a P2002 from invite creation without retrying", async () => {
    await seedUser("inviter", "Ada Lovelace");

    const inviteError = Object.assign(new Error("unique"), {
      code: "P2002",
      meta: { modelName: "MeInvite" },
    });

    let createCalls = 0;
    const throwingPrisma = {
      ...prisma,
      meInvite: {
        ...prisma.meInvite,
        create: async (_args: { data: Row; select?: Row }) => {
          createCalls += 1;
          throw inviteError;
        },
      },
    } as unknown as typeof prisma;
    // Run the work against the throwing double, not the original, so the
    // retry path is exercised on the same object whose create throws.
    throwingPrisma.$transaction = async (work: (tx: typeof throwingPrisma) => Promise<unknown>) => {
      const previous = overlay;
      const mine: Overlay = new Map();
      overlay = mine;
      try {
        const result = await work(throwingPrisma);
        for (const [key, row] of mine) {
          store(key.startsWith("quota:") ? "quota" : "invite", row);
        }
        return result;
      } finally {
        overlay = previous;
      }
    };

    await expect(
      issueInvite(throwingPrisma as unknown as Parameters<typeof issueInvite>[0], {
        inviterUserId: "inviter",
        allocation: 10,
        ttlDays: 14,
      }),
    ).rejects.toBe(inviteError);
    expect(createCalls).toBe(1);
  });
});
