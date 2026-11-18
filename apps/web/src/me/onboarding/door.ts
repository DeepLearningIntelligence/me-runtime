import { t } from "@lingui/core/macro";
import { BRAND_NAME } from "../brand";

/**
 * The browser half of the phone door (D-RUN-5). The browser keeps the nonce it
 * is given; the server stores only hashes, so nothing here is a secret. The
 * start call carries the invite token the welcome page opened with, because
 * admission is invite-only: the invitations service redeems the hash the door's
 * pending row kept in the same transaction that creates the person, so the
 * token must ride with `start` and nowhere else. The verify call needs no
 * token; the server row already carries it.
 */

const TIMEOUT_MS = 10_000;

/** Why the door refused; the named reasons the phone sign-in routes answer with. */
export type DoorFailureReason =
  | "invalid_input"
  | "whatsapp_not_configured"
  | "identity_key_missing"
  | "invalid_phone"
  | "rate_limited"
  | "nonce_unknown"
  | "code_expired"
  | "already_bound"
  | "phone_mismatch"
  | "code_invalid"
  | "too_many_attempts"
  | "invite_required"
  | "invite_invalid";

export class DoorError extends Error {
  constructor(readonly reason: DoorFailureReason | "unreachable") {
    super(reason);
    this.name = "DoorError";
  }
}

export type StartedDoor = {
  nonce: string;
  /** The wa.me link carrying `ME-<nonce>`; the person taps it and sends the message. */
  waLink: string;
  expiresAt: string;
  ttlMs: number;
};

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new DoorError("unreachable");
  }
  const parsed: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const reason =
      parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string"
        ? parsed.error
        : "invalid_input";
    throw new DoorError(reason as DoorFailureReason);
  }
  if (!parsed || typeof parsed !== "object") throw new DoorError("invalid_input");
  return parsed as T;
}

/** Opens a door. The phone is learned from the WhatsApp message, so it is not asked for here. */
export function startPhoneDoor(input: { inviteToken?: string } = {}): Promise<StartedDoor> {
  return call<StartedDoor>("/api/auth/phone/start", { inviteToken: input.inviteToken });
}

export function verifyPhoneDoor(input: { nonce: string; code: string }): Promise<void> {
  return call<{ ok: true }>("/api/auth/phone/verify", input).then(() => undefined);
}

/** The refusal a door shows, and whether it must stay on screen. */
export type DoorRefusal = { text: string; stays: boolean };

/**
 * The words a refused door shows, folded over the refusal already there. An
 * invite refusal stays: the code is not the problem (F1 keeps it usable), so a
 * later `code_invalid` from the same door must not push the real reason, and
 * its next step, off the screen. Anything else replaces freely.
 */
export function doorRefusal(previous: DoorRefusal | null, error: unknown): DoorRefusal {
  if (previous?.stays) return previous;
  const reason = error instanceof DoorError ? error.reason : "unreachable";
  const stays = reason === "invite_required" || reason === "invite_invalid";
  return { text: doorFailureText(error), stays };
}

/** The words a refused door shows; every refusal names what to do next. */
export function doorFailureText(error: unknown): string {
  const reason = error instanceof DoorError ? error.reason : "unreachable";
  const copy: Record<DoorFailureReason | "unreachable", string> = {
    invite_required: t`${BRAND_NAME} is invite-only right now. Ask the person who invited you for a link, then open it here.`,
    invite_invalid: t`That invite link cannot be used. Ask for a fresh one.`,
    rate_limited: t`Too many attempts from this network. Try again in about 15 minutes.`,
    code_expired: t`This sign-in expired. Start again.`,
    nonce_unknown: t`This sign-in expired. Start again.`,
    too_many_attempts: t`Too many wrong codes. Start again in a few minutes.`,
    code_invalid: t`That code is not right. Check the newest WhatsApp message.`,
    already_bound: t`This code was already used. Start again.`,
    phone_mismatch: t`The code came from a different number. Start again.`,
    invalid_phone: t`That phone number does not look right.`,
    whatsapp_not_configured: t`WhatsApp sign-in is not set up on this server yet.`,
    identity_key_missing: t`Sign-in is not configured on this server yet.`,
    invalid_input: t`Could not read that. Try again.`,
    unreachable: t`Could not reach the server.`,
  };
  return copy[reason];
}
