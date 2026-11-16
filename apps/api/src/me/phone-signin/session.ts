import { createHash, randomBytes } from "node:crypto";
import type { Auth } from "@rakazo/auth";
import { CLIENT_IP_HEADER } from "@rakazo/auth";
import type { PrismaClient, SignupPolicyEnv } from "@rakazo/db";
import { bootstrapUserSpace, isUniqueViolation, runAsSystem } from "@rakazo/db";
import { redeemInviteByHash } from "../invitations/invitations.js";
import { PhoneSigninError } from "./service.js";

/** The undeliverable email domain a phone-created person carries until onboarding connects one. */
export const PHONE_EMAIL_DOMAIN = "phone.invalid";

/**
 * The fork's own person and session, reached from a verified phone.
 *
 * One phone hash is one person: the user id is derived from the hash, so a
 * concurrent first sign-in for the same phone converges on the same row. The
 * person's email is synthetic under an undeliverable domain, because a phone
 * person has no mailbox yet and must never be asserted one; onboarding (packet
 * H) collects a real address later. The workspace is bootstrapped before the
 * session is issued, so the auth session hook finds an admitted member instead
 * of a closed signup, and the session itself is issued through the auth
 * layer's `issueSession`, which runs the same hooks as every sign-in.
 *
 * Admission has one owner: the invitations service. Creating the person through
 * the phone door requires the valid invitation the door was opened with, and
 * its redemption commits or rolls back with the person it admits; a person who
 * already exists signs in again without one.
 */

export type VerifiedPersonSession = {
  userId: string;
  /** The raw session token for the cookie; never logged. */
  token: string;
  expiresAt: Date;
};

/** The person id a phone hash belongs to; stable across processes. */
export function phoneUserId(phoneHash: string): string {
  return `${createHash("sha256")
    .update(JSON.stringify(["me-phone", phoneHash]))
    .digest("hex")}-phone`;
}

/**
 * Finds or creates the person for a verified phone and issues their session.
 * The display name is neutral until onboarding collects the person's name; it
 * carries no phone digits, because the number itself is never stored. The
 * invite hash is the one the pending row carried: null admits only a person
 * who already exists.
 */
export async function signInVerifiedPhone(
  prisma: PrismaClient,
  auth: Auth,
  env: SignupPolicyEnv,
  phoneHash: string,
  request: { ipAddress?: string; userAgent?: string } = {},
  inviteTokenHash?: string | null,
): Promise<VerifiedPersonSession> {
  const userId = phoneUserId(phoneHash);
  const found = await prisma.user.findUnique({ where: { id: userId } });
  if (!found && !inviteTokenHash) throw new PhoneSigninError("invite_required");

  const user =
    found ??
    (await runAsSystem("phone sign-in: admit the invited person", () =>
      prisma.$transaction(async (tx) => {
        // False when a concurrent first sign-in created the person first: join
        // its row and leave this link unspent, exactly like a returning person.
        let createdHere = true;
        const created = await tx.user
          .create({
            data: {
              id: userId,
              name: "Phone person",
              email: `phone-${randomBytes(16).toString("hex")}@${PHONE_EMAIL_DOMAIN}`,
            },
          })
          .catch(async (error: unknown) => {
            if (!isUniqueViolation(error)) throw error;
            createdHere = false;
            return tx.user.findUniqueOrThrow({ where: { id: userId } });
          });
        // One invite, one account: the redemption is in the same transaction
        // that creates the person, so a lost claim rolls back with the person.
        if (createdHere) {
          await redeemInviteByHash(tx, { tokenHash: inviteTokenHash!, userId });
        }

        // One membership is what the auth session hook requires; create it
        // before the session so a closed signup policy cannot refuse a
        // verified, invited phone.
        const membership = await tx.spaceMember.findFirst({
          where: { userId: created.id, space: { deletingAt: null } },
          select: { id: true },
        });
        if (!membership) await bootstrapUserSpace(tx, created, env);
        return created;
      }),
    ));

  const headers = new Headers();
  if (request.userAgent) headers.set("user-agent", request.userAgent);
  if (request.ipAddress) headers.set(CLIENT_IP_HEADER, request.ipAddress);
  const issued = await auth.issueSession(user.id, { headers });
  return { userId: user.id, token: issued.token, expiresAt: issued.expiresAt };
}
