import { expect, it } from "vitest";
import type { StartedDoor } from "./door";
import { decodeDoorRecord, encodeDoorRecord, inviteFingerprint } from "./phone-door-storage";

const DOOR: StartedDoor = {
  nonce: "ME-SAVED1",
  waLink: "https://wa.me/15550001111?text=ME-SAVED1",
  businessNumber: "+1 555 000 1111",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  ttlMs: 600_000,
};

it("discards a saved attempt started without an invitation when an invite opens", () => {
  const saved = encodeDoorRecord(DOOR, undefined);
  expect(decodeDoorRecord(saved, "invite-a")).toBeNull();
});

it("discards a saved attempt for one invitation when another opens", () => {
  const saved = encodeDoorRecord(DOOR, "invite-a");
  expect(decodeDoorRecord(saved, "invite-b")).toBeNull();
  expect(decodeDoorRecord(saved, undefined)).toBeNull();
});

it("keeps the attempt for the same invitation across the round trip", () => {
  const saved = encodeDoorRecord(DOOR, "invite-a");
  expect(decodeDoorRecord(saved, "invite-a")).toEqual(DOOR);
});

it("discards a record saved before the invitation was part of the shape", () => {
  expect(decodeDoorRecord(JSON.stringify({ door: DOOR }), "invite-a")).toBeNull();
  expect(decodeDoorRecord(JSON.stringify(DOOR), "invite-a")).toBeNull();
});

it("discards an expired door even when the invitation matches", () => {
  const expired = { ...DOOR, expiresAt: new Date(Date.now() - 1_000).toISOString() };
  expect(decodeDoorRecord(encodeDoorRecord(expired, "invite-a"), "invite-a")).toBeNull();
});

it("fingerprints stably, distinctly, and as null without an invitation", () => {
  expect(inviteFingerprint(undefined)).toBeNull();
  expect(inviteFingerprint("invite-a")).toBe(inviteFingerprint("invite-a"));
  expect(inviteFingerprint("invite-a")).not.toBe(inviteFingerprint("invite-b"));
  expect(inviteFingerprint("invite-a")).toMatch(/^[0-9a-f]{8}$/);
});
