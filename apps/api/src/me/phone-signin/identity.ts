import { createHmac, hkdfSync } from "node:crypto";

/**
 * The one identifier hash.
 *
 * A person is known by their phone number, and the number itself may not be
 * stored: a database read must not become a way to sign in. Only this HMAC is
 * written down, under a key derived from the deployment's `ME_IDENTITY_HASH_KEY`,
 * so rotating the key changes every hash at once and nothing can guess the
 * value behind a stored hash. The key comes from the caller's config, never
 * from a constant in code.
 */

export type IdentifierKind = "phone" | "email";

/** Domain separation: this derived key is for identity values and nothing else. */
const HKDF_INFO = "me.identity.v1";
const KEY_BYTES = 32;

let derived: { source: string; key: Buffer } | undefined;

function hashKey(source: string): Buffer {
  if (derived?.source !== source) {
    derived = {
      source,
      key: Buffer.from(hkdfSync("sha256", source, Buffer.alloc(0), HKDF_INFO, KEY_BYTES)),
    };
  }
  return derived.key;
}

/**
 * One person is one identity, so the same value must land on the same string.
 * A phone is E.164 with no spaces; emails are case-insensitive. Validity is the
 * door's job before a value gets here, not this function's.
 */
export function normaliseIdentifier(kind: IdentifierKind, value: string): string {
  if (kind === "email") return value.trim().toLowerCase();
  return value.replace(/\s+/g, "");
}

/**
 * The kind is inside the signed message as well as the caller's argument, so an
 * email hash and a phone hash of the same text are different values.
 */
export function hashIdentifier(kind: IdentifierKind, key: string, value: string): string {
  return createHmac("sha256", hashKey(key))
    .update(`${kind}:${normaliseIdentifier(kind, value)}`)
    .digest("hex");
}
