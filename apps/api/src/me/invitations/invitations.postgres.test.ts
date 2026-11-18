import { BillingEmulator } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueInvite, redeemInvite } from "./invitations.js";

/**
 * The true concurrency proof for D-RUN-7: two redeemers racing one token must
 * produce exactly one account and one quota count. Needs Postgres; without
 * VERIFY_DATABASE it is skipped, and the guard is then proven by the unit
 * suite's interleaved racer test and the two mutations on the predicates.
 */

const dbTests =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

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
    token = (
      await issueInvite(prisma, { inviterUserId: inviterId, allocation: 10, ttlDays: 14 })
    ).token;
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
