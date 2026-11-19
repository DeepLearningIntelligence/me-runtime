import { describe, expect, it, vi } from "vitest";
import type { GpsLocationRow } from "./gps-tools.js";
import { dispatchGpsTool, GPS_NO_LOCATION_REASON, gpsResultFrom } from "./gps-tools.js";
import { dispatchMemeTool, MEME_NO_MEDIA_REFUSAL, MEME_NO_TEXT_REFUSAL } from "./meme-tools.js";

describe("me_gps", () => {
  const now = new Date("2026-11-19T12:00:00.000Z");

  function reader(row: GpsLocationRow | null) {
    return { latestLocation: vi.fn(async () => row) };
  }

  it("returns the last location with its age in whole minutes", async () => {
    const receipts = reader({
      latitude: 40.7128,
      longitude: -74.006,
      label: "New York",
      capturedAt: new Date("2026-11-19T11:54:30.000Z"),
    });
    await expect(
      dispatchGpsTool({ spaceId: "space-1" }, { receipts, spaceId: "space-1", now }),
    ).resolves.toEqual({
      available: true,
      location: { latitude: 40.7128, longitude: -74.006, label: "New York" },
      staleMinutes: 5,
      capturedAt: "2026-11-19T11:54:30.000Z",
    });
    expect(receipts.latestLocation).toHaveBeenCalledWith({ spaceId: "space-1" });
  });

  it("counts a fresh location as 0 stale minutes and omits a missing label", () => {
    expect(
      gpsResultFrom(
        {
          latitude: 1,
          longitude: 2,
          label: null,
          capturedAt: new Date("2026-11-19T11:59:40.000Z"),
        },
        now,
      ),
    ).toEqual({
      available: true,
      location: { latitude: 1, longitude: 2 },
      staleMinutes: 0,
      capturedAt: "2026-11-19T11:59:40.000Z",
    });
  });

  it("answers not available with no_location_captured when the table is empty", async () => {
    const receipts = reader(null);
    await expect(
      dispatchGpsTool({ spaceId: "space-1" }, { receipts, spaceId: "space-1", now }),
    ).resolves.toEqual({
      available: false,
      reason: GPS_NO_LOCATION_REASON,
    });
    expect(GPS_NO_LOCATION_REASON).toBe("no_location_captured");
  });

  it("refuses to read another Space", async () => {
    const receipts = reader({
      latitude: 1,
      longitude: 2,
      label: null,
      capturedAt: now,
    });
    await expect(
      dispatchGpsTool({ spaceId: "other-space" }, { receipts, spaceId: "space-1", now }),
    ).resolves.toEqual({ available: false, reason: GPS_NO_LOCATION_REASON });
    expect(receipts.latestLocation).not.toHaveBeenCalled();
  });
});

describe("meme tools", () => {
  function emitter() {
    return {
      sendMeme: vi.fn(async () => ({
        receiptId: "receipt-1",
        messageId: "message-1",
        via: "chat" as const,
      })),
    };
  }

  it("sends one or two images and returns the receipt and message", async () => {
    const e = emitter();
    await expect(
      dispatchMemeTool(
        "me_send_meme",
        {
          spaceId: "space-1",
          image1: "https://example.test/a.png",
          image2: "data:image/png;base64,AAAA",
        },
        { emitter: e, spaceId: "space-1" },
      ),
    ).resolves.toEqual({
      ok: true,
      receiptId: "receipt-1",
      messageId: "message-1",
      via: "chat",
      images: ["https://example.test/a.png", "data:image/png;base64,AAAA"],
    });
    expect(e.sendMeme).toHaveBeenCalledWith({
      spaceId: "space-1",
      images: ["https://example.test/a.png", "data:image/png;base64,AAAA"],
    });
  });

  it("refuses a meme with no media instead of sending silently", async () => {
    const e = emitter();
    await expect(
      dispatchMemeTool("me_send_meme", { spaceId: "space-1" }, { emitter: e, spaceId: "space-1" }),
    ).resolves.toEqual({ ok: false, error: MEME_NO_MEDIA_REFUSAL });
    expect(e.sendMeme).not.toHaveBeenCalled();
  });

  it("refuses a text meme with no text", async () => {
    const e = emitter();
    await expect(
      dispatchMemeTool(
        "me_meme_from_text",
        { spaceId: "space-1", text: "   " },
        { emitter: e, spaceId: "space-1" },
      ),
    ).resolves.toEqual({ ok: false, error: MEME_NO_TEXT_REFUSAL });
    expect(e.sendMeme).not.toHaveBeenCalled();
  });

  it("sends a text meme with its caption and returns the receipt", async () => {
    const e = emitter();
    await expect(
      dispatchMemeTool(
        "me_meme_from_text",
        { spaceId: "space-1", text: "when the build goes green" },
        { emitter: e, spaceId: "space-1" },
      ),
    ).resolves.toMatchObject({
      ok: true,
      receiptId: "receipt-1",
      messageId: "message-1",
      caption: "when the build goes green",
      images: [],
    });
    expect(e.sendMeme).toHaveBeenCalledWith({
      spaceId: "space-1",
      images: [],
      caption: "when the build goes green",
    });
  });

  it("refuses another Space without touching the emitter", async () => {
    const e = emitter();
    await expect(
      dispatchMemeTool(
        "me_send_meme",
        { spaceId: "other-space", image1: "https://example.test/a.png" },
        { emitter: e, spaceId: "space-1" },
      ),
    ).resolves.toMatchObject({ ok: false });
    expect(e.sendMeme).not.toHaveBeenCalled();
  });

  it("turns a transport failure into an honest refusal", async () => {
    const e = { sendMeme: vi.fn(async () => Promise.reject(new Error("chat down"))) };
    await expect(
      dispatchMemeTool(
        "me_send_meme",
        { spaceId: "space-1", image1: "https://example.test/a.png" },
        { emitter: e, spaceId: "space-1" },
      ),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("chat down") });
  });
});
