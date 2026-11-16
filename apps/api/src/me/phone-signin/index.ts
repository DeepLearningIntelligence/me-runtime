import type { PrismaClient } from "@rakazo/db";
import type { WhatsAppSignInHandler } from "../whatsapp-router.js";
import type { PhoneSigninConfig } from "./service.js";
import { handleInbound } from "./service.js";

export {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  SIGNIN_NONCE_PATTERN,
  signinNonceFromBody,
} from "./codes.js";
export { hashIdentifier, normaliseIdentifier } from "./identity.js";
export {
  handleInbound as handleInboundMessage,
  type InboundMessage,
  type PhoneSigninConfig,
  PhoneSigninError,
  type StartedSignin,
  start,
  type VerifiedPhone,
  verify,
} from "./service.js";
export { PHONE_EMAIL_DOMAIN, phoneUserId, signInVerifiedPhone } from "./session.js";

/**
 * The handler the WhatsApp webhook router calls (D-RUN-6). It adapts the
 * service's outcome to the router's contract: a message this module does not
 * claim is not sign-in, and only a claimed message carries a reply, so Meta's
 * replay of one provider message id produces neither a second code nor a
 * second reply.
 */
export function whatsAppSignInHandler(
  prisma: PrismaClient,
  config: PhoneSigninConfig,
): WhatsAppSignInHandler {
  return async ({ from, body, providerMessageId }) => {
    const outcome = await handleInbound(prisma, config, { from, body, providerMessageId });
    return outcome === null
      ? { handled: false }
      : { handled: true, reply: outcome.reply ?? undefined };
  };
}
