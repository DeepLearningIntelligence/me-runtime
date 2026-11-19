import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_CANARY_BUDGET_PER_DAY,
  AI_CANARY_EXCEEDED_EVENT,
  canaryUsed,
  guardCanaryCall,
  resetCanaryBudget,
} from "./ai-guardrail.js";

const NOW = new Date("2026-11-19T12:00:00.000Z");
const NEXT_DAY = new Date("2026-11-20T00:00:01.000Z");

const call = {
  spaceId: "space_1",
  threadId: "thread_1",
  botId: "bot_1",
  runId: "run_1",
  name: "render_plot",
};

function fakeEvents() {
  return { append: vi.fn(async () => ({ id: "evt_1" }) as never) };
}

describe("the per-Space AI canary budget", () => {
  beforeEach(() => resetCanaryBudget());

  it("defaults to 1,000 canary calls per Space per day", () => {
    expect(AI_CANARY_BUDGET_PER_DAY).toBe(1000);
  });

  it("allows the day's budget, then refuses the next call by name and records it", async () => {
    const events = fakeEvents();
    for (let index = 0; index < AI_CANARY_BUDGET_PER_DAY; index += 1)
      await expect(guardCanaryCall({ events }, call, { now: NOW })).resolves.toBeUndefined();
    expect(canaryUsed("space_1", NOW)).toBe(AI_CANARY_BUDGET_PER_DAY);

    const refusal = await guardCanaryCall({ events }, call, { now: NOW });
    expect(refusal).toContain("render_plot");
    expect(refusal).toContain(AI_CANARY_EXCEEDED_EVENT);
    expect(events.append).toHaveBeenCalledTimes(1);
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AI_CANARY_EXCEEDED_EVENT,
        spaceId: "space_1",
        threadId: "thread_1",
        botId: "bot_1",
        runId: "run_1",
      }),
    );
  });

  it("counts each Space and each day separately", async () => {
    const events = fakeEvents();
    expect(await guardCanaryCall({ events }, call, { now: NOW, perDay: 1 })).toBeUndefined();
    expect(
      await guardCanaryCall({ events }, { ...call, spaceId: "space_2" }, { now: NOW, perDay: 1 }),
    ).toBeUndefined();
    expect(
      await guardCanaryCall({ events }, call, { now: NEXT_DAY, perDay: 1 }),
    ).toBeUndefined();
    expect(await guardCanaryCall({ events }, call, { now: NOW, perDay: 1 })).toContain(
      "ai.canary.exceeded",
    );
    expect(events.append).toHaveBeenCalledTimes(1);
  });

  it("refuses a budget that is not a non-negative integer", async () => {
    await expect(
      guardCanaryCall({ events: fakeEvents() }, call, { now: NOW, perDay: -1 }),
    ).rejects.toThrow("non-negative integer");
  });
});
