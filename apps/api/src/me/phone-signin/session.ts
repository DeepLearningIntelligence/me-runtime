import { createHash, randomBytes } from "node:crypto";
import type { Auth } from "@rakazo/auth";
import { CLIENT_IP_HEADER } from "@rakazo/auth";
import type { PrismaClient, SignupPolicyEnv } from "@rakazo/db";
import { bootstrapUserSpace, isUniqueViolation } from "@rakazo/db";

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
 * carries no phone digits, because the number itself is never stored.
 */
export async function signInVerifiedPhone(
  prisma: PrismaClient,
  auth: Auth,
  env: SignupPolicyEnv,
  phoneHash: string,
  request: { ipAddress?: string; userAgent?: string } = {},
): Promise<VerifiedPersonSession> {
  const userId = phoneUserId(phoneHash);
  const found = await prisma.user.findUnique({ where: { id: userId } });
  const context = await auth.$context;
  const user =
    found ??
    (await context.internalAdapter
      .createUser(
        {
          id: userId,
          name: "Phone person",
          email: `phone-${randomBytes(16).toString("hex")}@${PHONE_EMAIL_DOMAIN}`,
        },
        { method: "phone-number" },
      )
      .catch((error: unknown) => {
        if (!isUniqueViolation(error)) throw error;
        // A concurrent first sign-in created the person; join its row.
        return prisma.user.findUniqueOrThrow({ where: { id: userId } });
      }));

  // One membership is what the auth session hook requires; create it before the
  // session so a closed signup policy cannot refuse a verified phone.
  const membership = await prisma.spaceMember.findFirst({
    where: { userId: user.id, space: { deletingAt: null } },
    select: { id: true },
  });
  if (!membership) await bootstrapUserSpace(prisma, user, env);

  const headers = new Headers();
  if (request.userAgent) headers.set("user-agent", request.userAgent);
  if (request.ipAddress) headers.set(CLIENT_IP_HEADER, request.ipAddress);
  const issued = await auth.issueSession(user.id, { headers });
  return { userId: user.id, token: issued.token, expiresAt: issued.expiresAt };
}
