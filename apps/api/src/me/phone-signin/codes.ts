import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/**
 * The one-time secrets of the phone door, and nothing else.
 *
 * Only hashes are stored: a database read cannot sign in. The comparison is
 * constant time. The door stays open ten minutes and a code is charged five
 * attempts at most, exactly as the brief names them.
 */

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
/** Rows one client address may open per rate window, so the door cannot be farmed. */
export const MAX_PENDING_PER_IP = 10;
export const RATE_WINDOW_MS = 15 * 60_000;

/** No ambiguous glyphs (0/O, 1/I/L, U/V): the nonce travels as WhatsApp text. */
const NONCE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const NONCE_LENGTH = 12;

export const SIGNIN_NONCE_PATTERN = /^ME-[A-Z0-9]{6,}$/;

export function newNonce(): string {
  let nonce = "";
  for (let i = 0; i < NONCE_LENGTH; i += 1) {
    nonce += NONCE_ALPHABET[randomInt(NONCE_ALPHABET.length)];
  }
  return `ME-${nonce}`;
}

/** Six digits from a CSPRNG, not a counter and not `Math.random`. */
export function newCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Compares two hex digests without leaking where they differ. A null stored
 * hash is a row whose code was never minted, which is never a match.
 */
export function constantTimeEqualsHex(
  stored: string | null | undefined,
  presented: string,
): boolean {
  if (!stored) return false;
  const left = Buffer.from(stored, "hex");
  const right = Buffer.from(presented, "hex");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The only message text that reaches sign-in. Anything else belongs to the
 * agent conversation and this module never sees it. Leading and trailing
 * whitespace is transport noise; the pattern itself stays exact.
 */
export function signinNonceFromBody(body: string): string | null {
  const candidate = body.trim();
  return SIGNIN_NONCE_PATTERN.test(candidate) ? candidate : null;
}
