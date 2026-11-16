import { createHash, randomBytes } from "node:crypto";

import type { PrismaClient } from "@rakazo/db";
import { runAsSystem, withTransactionRetry } from "@rakazo/db";

/**
 * Person-to-person invitations (ME-RUN-001, D-RUN-7): the only door into the
 * product for a new person.
 *
 * Two properties matter more than the rest:
 * - the token is stored only as a hash, so a database read cannot mint a link
 * - redeem is atomic: the claim is a compare-and-swap on the row's status, so
 *   two concurrent opens of one link produce one account
 *
 * The quota lives in the person's quota row and every guard reads it there, so
 * no client-supplied number can widen it. Allocation and link lifetime come
 * from the deployment config (`apps/api/src/env.ts`); callers pass them in and
 * the service keeps no default of its own.
 */

export type InviteFailure =
  | "invalid"
  | "already_redeemed"
  | "expired"
  | "revoked"
  | "quota_exceeded";

export class InviteError extends Error {
  constructor(public readonly reason: InviteFailure) {
    super(reason);
    this.name = "InviteError";
  }
}

/** The words the person sees for each refusal; rpc-errors.ts shows them. */
export const INVITE_FAILURE_MESSAGE: Record<InviteFailure, string> = {
  invalid: "That invite link is not valid.",
  already_redeemed: "That invite link has already been used.",
  expired: "That invite link has expired.",
  revoked: "That invite link was withdrawn.",
  quota_exceeded: "You have no invites left.",
};

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The deployment defaults, read once per call by the caller from config. */
export interface InviteSettings {
  /** ME_INVITE_ALLOCATION: seeded into a person's first quota row. */
  allocation: number;
  /** ME_INVITE_TTL_DAYS. */
  ttlDays: number;
}

export type IssuedInvite = { id: string; token: string; expiresAt: Date };

export async function issueInvite(
  prisma: PrismaClient,
  params: { inviterUserId: string } & InviteSettings,
): Promise<IssuedInvite> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + params.ttlDays * 86_400_000);

  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      // The quota row, created on the first issue, then owns the allowance:
      // later config changes do not silently move it for people who have rows.
      const quota = await tx.meInviteQuota.upsert({
        where: { userId: params.inviterUserId },
        create: { userId: params.inviterUserId, allocation: params.allocation },
        update: {},
      });

      // Compare-and-swap on the counter: the WHERE clause is what stops two
      // concurrent issues from exceeding the allocation. Reading then writing
      // would not.
      const granted = await tx.meInviteQuota.updateMany({
        where: { userId: params.inviterUserId, grantedCount: { lt: quota.allocation } },
        data: { grantedCount: { increment: 1 } },
      });
      if (granted.count === 0) throw new InviteError("quota_exceeded");

      const row = await tx.meInvite.create({
        data: { inviterId: params.inviterUserId, tokenHash: hashInviteToken(token), expiresAt },
        select: { id: true },
      });
      return { id: row.id, token, expiresAt };
    }),
  );
}

/**
 * Claims an invitation for the person whose account is being created. The
 * claim, the quota count and nothing else land or roll back together: of two
 * concurrent redeemers exactly one wins, and every refusal carries its reason.
 */
export async function redeemInvite(
  prisma: PrismaClient,
  params: { token: string; userId: string },
): Promise<{ inviterId: string; inviterName: string }> {
  // Cross-person by design: the redeemer's row-level context is not the inviter's.
  return runAsSystem("me invitations: redeem", () =>
    withTransactionRetry(() =>
      prisma.$transaction(async (tx) => {
        const tokenHash = hashInviteToken(params.token);
        const invite = await tx.meInvite.findUnique({ where: { tokenHash } });

        if (!invite) throw new InviteError("invalid");
        if (invite.status === "revoked") throw new InviteError("revoked");
        if (invite.status === "redeemed") throw new InviteError("already_redeemed");
        if (invite.expiresAt.getTime() <= Date.now()) throw new InviteError("expired");

        // Quota is claimed first so a full inviter cannot consume a token, and
        // the claim rolls back with this transaction if the one below loses.
        // A person without a quota row cannot pass a zero bound; every token
        // comes from an issue that created the row, so reaching here means the
        // row is gone.
        const quota = await tx.meInviteQuota.findUnique({ where: { userId: invite.inviterId } });
        const counted = await tx.meInviteQuota.updateMany({
          where: { userId: invite.inviterId, redeemedCount: { lt: quota?.allocation ?? 0 } },
          data: { redeemedCount: { increment: 1 } },
        });
        if (counted.count === 0) throw new InviteError("quota_exceeded");

        // The double-spend guard: the predicate is re-evaluated against the
        // committed row, so of two racers only the first commits a claim.
        const claimed = await tx.meInvite.updateMany({
          where: { id: invite.id, status: "issued" },
          data: {
            status: "redeemed",
            redeemedAt: new Date(),
            redeemedByUserId: params.userId,
          },
        });
        if (claimed.count === 0) throw new InviteError("already_redeemed");

        const inviter = await tx.user.findUnique({
          where: { id: invite.inviterId },
          select: { name: true },
        });
        return { inviterId: invite.inviterId, inviterName: inviter?.name ?? "" };
      }),
    ),
  );
}

export type InviteInspection =
  | { ok: true; inviterName: string; expiresAt: Date }
  | { ok: false; reason: InviteFailure };

/**
 * Reads a token without claiming it, so the welcome page can refuse before an
 * account exists and name the inviter when it opens. Redeeming happens in the
 * same transaction as the account creation; this is only the pre-flight.
 */
export async function inspectInvite(
  prisma: PrismaClient,
  token: string,
): Promise<InviteInspection> {
  // Public, and the inviter's name crosses a person boundary.
  return runAsSystem("me invitations: inspect", async () => {
    const invite = await prisma.meInvite.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      select: { status: true, expiresAt: true, inviter: { select: { name: true } } },
    });

    if (!invite) return { ok: false, reason: "invalid" };
    if (invite.status === "revoked") return { ok: false, reason: "revoked" };
    if (invite.status === "redeemed") return { ok: false, reason: "already_redeemed" };
    if (invite.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
    return { ok: true, inviterName: invite.inviter.name, expiresAt: invite.expiresAt };
  });
}

export type InviteList = {
  quota: { allocation: number; grantedCount: number; redeemedCount: number };
  invites: Array<{
    id: string;
    /** Only this module writes the column, and only with these three values. */
    status: "issued" | "redeemed" | "revoked";
    createdAt: Date;
    expiresAt: Date;
    redeemedAt: Date | null;
  }>;
};

/**
 * The inviter's meter and their links. `allocation` only seeds the quota row on
 * the first read; the row then owns the number, so the meter never trusts a
 * value the client sent.
 */
export async function listInvites(
  prisma: PrismaClient,
  params: { inviterUserId: string } & Pick<InviteSettings, "allocation">,
): Promise<InviteList> {
  const quota = await prisma.meInviteQuota.upsert({
    where: { userId: params.inviterUserId },
    create: { userId: params.inviterUserId, allocation: params.allocation },
    update: {},
  });
  const invites = await prisma.meInvite.findMany({
    where: { inviterId: params.inviterUserId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, status: true, createdAt: true, expiresAt: true, redeemedAt: true },
  });
  return {
    quota: {
      allocation: quota.allocation,
      grantedCount: quota.grantedCount,
      redeemedCount: quota.redeemedCount,
    },
    invites: invites.map((invite) => ({
      ...invite,
      status: invite.status as InviteList["invites"][number]["status"],
    })),
  };
}

/** Withdraws an unused link. Returns false when it was already claimed or revoked. */
export async function revokeInvite(
  prisma: PrismaClient,
  params: { inviterUserId: string; id: string },
): Promise<boolean> {
  const revoked = await prisma.meInvite.updateMany({
    where: { id: params.id, inviterId: params.inviterUserId, status: "issued" },
    data: { status: "revoked", revokedAt: new Date() },
  });
  return revoked.count > 0;
}
