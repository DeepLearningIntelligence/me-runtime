import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  forgetThinkingMusic,
  HOLD_MUSIC_CLIP,
  maybeEmitThinkingMusic,
  resetThinkingMusic,
  shouldEmitThinkingMusic,
  THINKING_HOLD_MUSIC_STATUS,
  THINKING_HOLD_MUSIC_THRESHOLD_MS,
} from "./thinking-music.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

function fakes() {
  const acknowledge = vi.fn(async () => undefined);
  const sendToThread = vi.fn(async () => ({ handle: "out-1" }));
  return {
    messaging: { acknowledge, sendToThread },
    acknowledge,
    sendToThread,
  };
}

describe("thinking hold music threshold", () => {
  it("stays quiet at and below the default threshold", () => {
    expect(shouldEmitThinkingMusic(0)).toBe(false);
    expect(shouldEmitThinkingMusic(THINKING_HOLD_MUSIC_THRESHOLD_MS)).toBe(false);
    expect(shouldEmitThinkingMusic(THINKING_HOLD_MUSIC_THRESHOLD_MS - 1)).toBe(false);
  });

  it("fires only past the threshold, including a custom one", () => {
    expect(shouldEmitThinkingMusic(THINKING_HOLD_MUSIC_THRESHOLD_MS + 1)).toBe(true);
    expect(shouldEmitThinkingMusic(1_001, 1_000)).toBe(true);
    expect(shouldEmitThinkingMusic(1_000, 1_000)).toBe(false);
  });

  it("refuses non-finite input", () => {
    expect(shouldEmitThinkingMusic(Number.NaN)).toBe(false);
    expect(shouldEmitThinkingMusic(Number.POSITIVE_INFINITY)).toBe(false);
    expect(shouldEmitThinkingMusic(5_000, Number.NaN)).toBe(false);
  });
});

describe("maybeEmitThinkingMusic", () => {
  const target = { threadId: "slack~a:C1:1.001", handle: "1.001" };

  it("returns null below the threshold without touching the messaging layer", async () => {
    const f = fakes();
    await expect(
      maybeEmitThinkingMusic("run-1", 5_999, {
        messaging: f.messaging,
        target,
        context,
      }),
    ).resolves.toBeNull();
    expect(f.acknowledge).not.toHaveBeenCalled();
    expect(f.sendToThread).not.toHaveBeenCalled();
  });

  it("returns null when the run has no messaging thread", async () => {
    const f = fakes();
    await expect(
      maybeEmitThinkingMusic("run-1", 60_000, {
        messaging: f.messaging,
        target: null,
        context,
      }),
    ).resolves.toBeNull();
    expect(f.acknowledge).not.toHaveBeenCalled();
    expect(f.sendToThread).not.toHaveBeenCalled();
  });

  it("asks for typing dots and posts the status line once per run", async () => {
    resetThinkingMusic();
    const f = fakes();
    const deps = { messaging: f.messaging, target, context };

    const first = await maybeEmitThinkingMusic("run-1", 6_001, deps);
    expect(first).toEqual({
      typing: true,
      status: THINKING_HOLD_MUSIC_STATUS,
      music: HOLD_MUSIC_CLIP !== null,
    });
    expect(f.acknowledge).toHaveBeenCalledWith(
      target.threadId,
      target.handle,
      { kind: "typing" },
      context,
    );
    expect(f.sendToThread).toHaveBeenCalledTimes(1);
    expect(f.sendToThread).toHaveBeenCalledWith(
      {
        threadId: target.threadId,
        body: THINKING_HOLD_MUSIC_STATUS,
        idempotencyKey: "thinking-music:run-1",
      },
      context,
    );

    const second = await maybeEmitThinkingMusic("run-1", 9_000, deps);
    expect(second).toEqual({
      typing: true,
      status: null,
      music: HOLD_MUSIC_CLIP !== null,
    });
    expect(f.acknowledge).toHaveBeenCalledTimes(2);
    expect(f.sendToThread).toHaveBeenCalledTimes(1);
  });

  it("keeps the status line per run, not per thread", async () => {
    resetThinkingMusic();
    const f = fakes();
    const deps = { messaging: f.messaging, target, context };
    await maybeEmitThinkingMusic("run-a", 7_000, deps);
    await maybeEmitThinkingMusic("run-b", 7_000, deps);
    expect(f.sendToThread).toHaveBeenCalledTimes(2);
  });

  it("logs a failed status send and lets a later crossing retry", async () => {
    resetThinkingMusic();
    const f = fakes();
    f.sendToThread.mockRejectedValueOnce(new Error("platform down"));
    const deps = { messaging: f.messaging, target, context };

    const failed = await maybeEmitThinkingMusic("run-1", 7_000, deps);
    expect(failed).toEqual({
      typing: true,
      status: null,
      music: HOLD_MUSIC_CLIP !== null,
    });

    const retried = await maybeEmitThinkingMusic("run-1", 8_000, deps);
    expect(retried?.status).toBe(THINKING_HOLD_MUSIC_STATUS);
    expect(f.sendToThread).toHaveBeenCalledTimes(2);
  });

  it("forgets a finished run on request", async () => {
    resetThinkingMusic();
    const f = fakes();
    const deps = { messaging: f.messaging, target, context };
    await maybeEmitThinkingMusic("run-1", 7_000, deps);
    forgetThinkingMusic("run-1");
    await maybeEmitThinkingMusic("run-1", 7_000, deps);
    expect(f.sendToThread).toHaveBeenCalledTimes(2);
  });

  it("ships with music off while no hold clip exists", () => {
    expect(HOLD_MUSIC_CLIP).toBeNull();
  });
});
