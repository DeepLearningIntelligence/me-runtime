import type { PrismaClient } from "@rakazo/db";
import { isUniqueViolation, runAsSystem } from "@rakazo/db";
import {
  CODE_TTL_MS,
  constantTimeEqualsHex,
  MAX_CODE_ATTEMPTS,
  MAX_PENDING_PER_IP,
  newCode,
  newNonce,
  RATE_WINDOW_MS,
  sha256Hex,
  signinNonceFromBody,
} from "./codes.js";
import { hashIdentifier, normaliseIdentifier } from "./identity.js";

/**
 * The phone sign-in authority, over `me_phone_signins` and
 * `me_phone_signin_messages`.
 *
 * The door has three steps, and every guard lives here rather than with a caller:
 *
 * - `start` opens a door: a pending row holding only the nonce's hash. The phone
 *   is not known yet, so no code exists; the caller builds the `wa.me` link
 *   carrying `ME-<nonce>` with the router's deep-link builder, after checking
 *   the business number is configured, so no row outlives an undeliverable door.
 * - `handleInbound` binds: a signed WhatsApp webhook hands over one message.
 *   Text matching `^ME-[A-Z0-9]{6,}$` binds the nonce to the sender's phone and
 *   mints a six-digit code, stored only as its hash. Anything else returns
 *   `not_signin` so the router can pass it to the agent conversation. The
 *   provider message id is claimed in the same transaction as the work, so a
 *   replayed delivery never mints a second code, and a bound nonce never binds
 *   again.
 * - `verify` redeems: code and pending token are compared in constant time, the
 *   redemption is single use, wrong guesses are charged to the row, the sixth
 *   attempt is refused by name, and a code minted for one phone can never
 *   verify another because the row keeps the phone hash it was bound with.
 *
 * No key, nonce or code is ever logged; the caller delivers the reply text.
 */

export type PhoneSigninConfig = {
  /** The deployment's identity-hash key; the door refuses without it. */
  identityHashKey: string | undefined;
  /** Tests pin the present moment; production reads the clock. */
  now?: () => number;
};

export type PhoneSigninFailure =
  | "identity_key_missing"
  | "invalid_phone"
  | "rate_limited"
  | "not_signin"
  | "nonce_unknown"
  | "code_expired"
  | "already_bound"
  | "phone_mismatch"
  | "code_invalid"
  | "too_many_attempts";

export class PhoneSigninError extends Error {
  constructor(readonly reason: PhoneSigninFailure) {
    super(reason);
    this.name = "PhoneSigninError";
  }
}

export type StartedSignin = {
  /** The `ME-<nonce>` value. The browser keeps it; only its hash is stored. */
  nonce: string;
  expiresAt: Date;
};

export type InboundMessage = {
  /** The sender's E.164 number, as the verified webhook delivered it. */
  from: string;
  body: string;
  providerMessageId: string;
};

export type InboundOutcome =
  | { reply: string }
  | {
      reply: null;
      reason:
        | "replayed"
        | "identity_key_missing"
        | "nonce_unknown"
        | "code_expired"
        | "already_bound"
        | "phone_mismatch";
    };

export type VerifiedPhone = {
  /** The bound phone's HMAC; the caller turns it into a person and a session. */
  phoneHash: string;
};

const PROVIDER = "whatsapp";

function requirePhoneValue(phone: string): string {
  const normalised = normaliseIdentifier("phone", phone);
  if (!/^\+[1-9]\d{6,14}$/.test(normalised)) throw new PhoneSigninError("invalid_phone");
  return normalised;
}

/**
 * Opens a door. The phone may be empty: the number is learned from the WhatsApp
 * message. Nothing is created when the door cannot be delivered, and one
 * address cannot farm pending rows.
 */
export async function start(
  prisma: PrismaClient,
  config: PhoneSigninConfig,
  input: { phone?: string; ipAddress?: string } = {},
): Promise<StartedSignin> {
  if (!config.identityHashKey) throw new PhoneSigninError("identity_key_missing");

  const phoneHash = input.phone
    ? hashIdentifier("phone", config.identityHashKey, requirePhoneValue(input.phone))
    : null;
  const now = nowOf(config);
  const ipAddress = input.ipAddress?.trim() || null;
  if (ipAddress) {
    const recent = await prisma.mePhoneSignin.count({
      where: { ipAddress, createdAt: { gt: new Date(now - RATE_WINDOW_MS) } },
    });
    if (recent >= MAX_PENDING_PER_IP) throw new PhoneSigninError("rate_limited");
  }

  const nonce = newNonce();
  const expiresAt = new Date(now + CODE_TTL_MS);
  await prisma.mePhoneSignin.create({
    data: { nonceHash: sha256Hex(nonce), phoneHash, expiresAt, ipAddress },
  });
  return {
    nonce,
    expiresAt,
  };
}

/**
 * One inbound message, routed here only when it might be sign-in. The provider
 * message id is claimed inside the same transaction as the bind, so Meta's
 * retries land on an already-claimed message instead of minting a second code.
 * An outcome without a reply is still a processed message: its claim stands.
 */
export async function handleInbound(
  prisma: PrismaClient,
  config: PhoneSigninConfig,
  message: InboundMessage,
): Promise<InboundOutcome | null> {
  const nonce = signinNonceFromBody(message.body);
  if (!nonce) return null;
  if (!config.identityHashKey) throw new PhoneSigninError("identity_key_missing");

  const senderHash = hashIdentifier(
    "phone",
    config.identityHashKey,
    normaliseIdentifier("phone", message.from),
  );
  const now = nowOf(config);
  const nonceHash = sha256Hex(nonce);

  return runAsSystem("bind phone sign-in nonce", () =>
    prisma.$transaction(async (tx): Promise<InboundOutcome | null> => {
      // The claim is the work's replay guard: a retried delivery finds its own
      // claim and stops here, whatever became of the first attempt.
      try {
        await tx.mePhoneSigninMessage.create({
          data: { provider: PROVIDER, providerMessageId: message.providerMessageId },
        });
      } catch (error) {
        if (isUniqueViolation(error)) return { reply: null, reason: "replayed" };
        throw error;
      }

      const row = await tx.mePhoneSignin.findUnique({ where: { nonceHash } });
      if (!row) return { reply: null, reason: "nonce_unknown" };
      if (row.boundAt) return { reply: null, reason: "already_bound" };
      if (row.expiresAt.getTime() <= now) return { reply: null, reason: "code_expired" };
      // A door opened for one phone refuses a different sender; the row keeps
      // the phone hash it was opened with, so the code can only ever belong to
      // that phone.
      if (row.phoneHash && row.phoneHash !== senderHash)
        return { reply: null, reason: "phone_mismatch" };

      const code = newCode();
      // The conditional update is the bind: a concurrent delivery for the same
      // nonce matches nothing and mints nothing.
      const bound = await tx.mePhoneSignin.updateMany({
        where: { nonceHash, boundAt: null, expiresAt: { gt: new Date(now) } },
        data: {
          phoneHash: senderHash,
          boundAt: new Date(now),
          codeHash: sha256Hex(code),
        },
      });
      if (bound.count !== 1) return { reply: null, reason: "already_bound" };
      return { reply: code };
    }),
  );
}

/**
 * Redeems a code once, in constant time, and returns the phone it was minted
 * for. Refusals are named; a wrong guess is charged to the row it belongs to.
 */
export async function verify(
  prisma: PrismaClient,
  config: PhoneSigninConfig,
  input: { nonce: string; code: string },
): Promise<VerifiedPhone> {
  const now = nowOf(config);
  const nonceHash = sha256Hex(input.nonce.trim());
  const row = await prisma.mePhoneSignin.findUnique({ where: { nonceHash } });
  if (!row) throw new PhoneSigninError("nonce_unknown");
  if (row.expiresAt.getTime() <= now) throw new PhoneSigninError("code_expired");
  if (row.attempts >= MAX_CODE_ATTEMPTS) throw new PhoneSigninError("too_many_attempts");
  if (!row.boundAt || !row.codeHash) throw new PhoneSigninError("code_invalid");

  if (!constantTimeEqualsHex(row.codeHash, sha256Hex(input.code.trim()))) {
    await prisma.mePhoneSignin.update({
      where: { id: row.id },
      data: { attempts: { increment: 1 } },
    });
    throw new PhoneSigninError("code_invalid");
  }

  // Single use: a concurrent redemption matches nothing.
  const claimed = await prisma.mePhoneSignin.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: new Date(now) },
  });
  if (claimed.count !== 1) throw new PhoneSigninError("code_invalid");
  if (!row.phoneHash) throw new PhoneSigninError("code_invalid");
  return { phoneHash: row.phoneHash };
}

function nowOf(config: PhoneSigninConfig): number {
  return (config.now ?? Date.now)();
}
