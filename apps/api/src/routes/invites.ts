import { ORPCError } from "@orpc/server";
import {
  INVITE_FAILURE_MESSAGE,
  inspectInvite,
  issueInvite,
  listInvites,
  revokeInvite,
} from "../me/invitations/invitations.js";
import type { RouterContext } from "./context.js";

/** Person-to-person invites (ME-RUN-001 D-RUN-7): the meter, minting, and the welcome page's pre-flight. */
export function invitesRoutes(ctx: RouterContext) {
  const { deps, os, authed } = ctx;
  // The deployment's defaults; the config module owns the numbers themselves.
  const settings = () => ({
    allocation: deps.env.inviteAllocation,
    ttlDays: deps.env.inviteTtlDays,
  });

  return {
    invites: {
      issue: authed.invites.issue.handler(async ({ context }) => {
        const issued = await issueInvite(deps.prisma, {
          inviterUserId: context.actor.userId,
          ...settings(),
        });
        return { ...issued, expiresAt: issued.expiresAt.toISOString() };
      }),
      list: authed.invites.list.handler(async ({ context }) => {
        const { quota, invites } = await listInvites(deps.prisma, {
          inviterUserId: context.actor.userId,
          allocation: settings().allocation,
        });
        return {
          quota,
          invites: invites.map((invite) => ({
            ...invite,
            createdAt: invite.createdAt.toISOString(),
            expiresAt: invite.expiresAt.toISOString(),
            redeemedAt: invite.redeemedAt?.toISOString() ?? null,
          })),
        };
      }),
      revoke: authed.invites.revoke.handler(async ({ context, input }) => {
        const revoked = await revokeInvite(deps.prisma, {
          inviterUserId: context.actor.userId,
          id: input.id,
        });
        if (!revoked) {
          throw new ORPCError("BAD_REQUEST", { message: "Already claimed or withdrawn." });
        }
        return { ok: true as const };
      }),
      /** Public: the welcome page names the inviter before anyone signs in. */
      inspect: os.invites.inspect.handler(async ({ input }) => {
        const inspection = await inspectInvite(deps.prisma, input.token);
        if (!inspection.ok) {
          return { ...inspection, message: INVITE_FAILURE_MESSAGE[inspection.reason] };
        }
        return { ...inspection, expiresAt: inspection.expiresAt.toISOString() };
      }),
    },
  };
}
