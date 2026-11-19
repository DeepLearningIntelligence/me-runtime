// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DoorError, doorFailureText, doorRefusal, startPhoneDoor, verifyPhoneDoor } from "./door";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonReply(status: number, body: unknown) {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  return Promise.resolve(response);
}

it("sends the invite token with the start call, because admission is invite-only", async () => {
  fetchMock.mockReturnValue(
    jsonReply(200, {
      ok: true,
      nonce: "ME-ABC123",
      waLink: "https://wa.me/15550001?text=ME-ABC123",
      businessNumber: "+1 555 000 1111",
      expiresAt: "2026-11-17T00:10:00.000Z",
      ttlMs: 600_000,
    }),
  );
  const started = await startPhoneDoor({ inviteToken: "tok_en1" });
  expect(started.nonce).toBe("ME-ABC123");
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe("/api/auth/phone/start");
  expect(JSON.parse(String(init?.body))).toEqual({ inviteToken: "tok_en1" });
});

it("opens a door with no token when a returning person signs in", async () => {
  fetchMock.mockReturnValue(
    jsonReply(200, {
      ok: true,
      nonce: "N",
      waLink: "w",
      businessNumber: "n",
      expiresAt: "",
      ttlMs: 1,
    }),
  );
  await startPhoneDoor();
  expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({});
});

it("sends the nonce and code with the verify call and nothing else", async () => {
  fetchMock.mockReturnValue(jsonReply(200, { ok: true }));
  await verifyPhoneDoor({ nonce: "ME-ABC123", code: "123456" });
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe("/api/auth/phone/verify");
  expect(JSON.parse(String(init?.body))).toEqual({ nonce: "ME-ABC123", code: "123456" });
});

it("carries the verify answer's WhatsApp link state, unnamed servers included", async () => {
  fetchMock.mockReturnValue(jsonReply(200, { ok: true, whatsapp: "linked" }));
  await expect(verifyPhoneDoor({ nonce: "ME-ABC123", code: "123456" })).resolves.toEqual({
    whatsapp: "linked",
  });
  fetchMock.mockReturnValue(jsonReply(200, { ok: true }));
  await expect(verifyPhoneDoor({ nonce: "ME-ABC123", code: "123456" })).resolves.toEqual({
    whatsapp: "not_attempted",
  });
});

it("carries the business number the server configured", async () => {
  fetchMock.mockReturnValue(
    jsonReply(200, {
      ok: true,
      nonce: "ME-ABC123",
      waLink: "https://wa.me/15550001?text=ME-ABC123",
      businessNumber: "+1 555 000 1111",
      expiresAt: "2026-11-17T00:10:00.000Z",
      ttlMs: 600_000,
    }),
  );
  const started = await startPhoneDoor({ inviteToken: "tok_en1" });
  expect(started.businessNumber).toBe("+1 555 000 1111");
});

it("refuses by the server's named reason", async () => {
  fetchMock.mockReturnValue(jsonReply(403, { error: "invite_required" }));
  const refusal = startPhoneDoor();
  await expect(refusal).rejects.toThrow(DoorError);
  await refusal.catch((error: unknown) => {
    expect((error as DoorError).reason).toBe("invite_required");
    expect(doorFailureText(error)).toContain("invite-only");
  });
});

it("names an unreachable server instead of guessing", async () => {
  fetchMock.mockReturnValue(Promise.reject(new Error("offline")));
  await expect(startPhoneDoor()).rejects.toThrow(DoorError);
});

it("keeps an invite refusal on screen over a later code refusal", () => {
  const invited = doorRefusal(null, new DoorError("invite_required"));
  expect(invited.stays).toBe(true);
  expect(invited.text).toContain("invite-only");

  // A later code_invalid from the same door changes nothing on screen.
  expect(doorRefusal(invited, new DoorError("code_invalid"))).toBe(invited);

  // A non-invite refusal is replaced freely.
  const coded = doorRefusal(null, new DoorError("code_invalid"));
  expect(coded.stays).toBe(false);
  expect(coded.text).toContain("not right");
  expect(doorRefusal(coded, new DoorError("code_expired")).text).toContain("expired");
});
