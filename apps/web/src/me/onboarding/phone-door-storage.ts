import type { StartedDoor } from "./door";

/**
 * One saved phone-door record, scoped to the invitation that started it.
 *
 * The record stores a fingerprint, never the token itself, and carries a
 * version. A record written before the invitation was part of the shape has no
 * context to verify, so it is discarded rather than restored: restoring it is
 * how a code for an uninvited attempt used to resurface on an invite link.
 */
const RECORD_VERSION = 2;

export const DOOR_STORAGE_KEY = "me.phone-door";

/** A short stable key for the invitation. Scoping only, not a secret or a check. */
export function inviteFingerprint(inviteToken: string | undefined): string | null {
  if (!inviteToken) return null;
  let hash = 0x811c9dc5;
  for (let index = 0; index < inviteToken.length; index += 1) {
    hash ^= inviteToken.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function isStartedDoor(value: unknown): value is StartedDoor {
  if (typeof value !== "object" || value === null) return false;
  const door = value as Partial<StartedDoor>;
  return (
    typeof door.nonce === "string" &&
    typeof door.waLink === "string" &&
    typeof door.businessNumber === "string" &&
    typeof door.expiresAt === "string" &&
    typeof door.ttlMs === "number"
  );
}

export function encodeDoorRecord(door: StartedDoor, inviteToken: string | undefined): string {
  return JSON.stringify({
    v: RECORD_VERSION,
    inviteFingerprint: inviteFingerprint(inviteToken),
    door,
  });
}

export function decodeDoorRecord(
  raw: string,
  inviteToken: string | undefined,
  now: number = Date.now(),
): StartedDoor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as { v?: unknown; inviteFingerprint?: unknown; door?: unknown };
  if (record.v !== RECORD_VERSION) return null;
  if (inviteFingerprint(inviteToken) !== record.inviteFingerprint) return null;
  if (!isStartedDoor(record.door)) return null;
  if (Date.parse(record.door.expiresAt) <= now) return null;
  return record.door;
}
