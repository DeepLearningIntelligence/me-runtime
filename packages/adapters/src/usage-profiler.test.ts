import { describe, expect, it } from "vitest";
import type { UsageEvent } from "./usage-profiler.js";
import { summarizeUsage } from "./usage-profiler.js";

const call = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  provider: "openrouter",
  model: "fixture-model",
  totalTokens: 100,
  costUsd: 0.01,
  ...overrides,
});

describe("summarizeUsage", () => {
  it("ranks provider/model groups by spend and sums calls, tokens and cost", () => {
    const rows = summarizeUsage([
      call({ model: "cheap", costUsd: 0.01, totalTokens: 10 }),
      call({ model: "expensive", costUsd: 0.5, totalTokens: 1_000 }),
      call({ model: "cheap", costUsd: 0.02, totalTokens: 20 }),
    ]);
    expect(
      rows.map(({ rank, provider, model, calls, tokens, unpricedCalls }) => ({
        rank,
        provider,
        model,
        calls,
        tokens,
        unpricedCalls,
      })),
    ).toEqual([
      {
        rank: 1,
        provider: "openrouter",
        model: "expensive",
        calls: 1,
        tokens: 1_000,
        unpricedCalls: 0,
      },
      { rank: 2, provider: "openrouter", model: "cheap", calls: 2, tokens: 30, unpricedCalls: 0 },
    ]);
    expect(rows[0]?.spendUsd).toBeCloseTo(0.5);
    expect(rows[1]?.spendUsd).toBeCloseTo(0.03);
  });

  it("keeps providers apart and splits a model by the source and file it carries", () => {
    const rows = summarizeUsage([
      call({ provider: "openrouter", model: "same", costUsd: 0.01, source: "provider-reported" }),
      call({ provider: "openrouter", model: "same", costUsd: 0.09, source: "provider-reported" }),
      call({ provider: "local", model: "same", costUsd: 0.05 }),
      call({ model: "same", costUsd: 0.03, file: "fixtures/calls.jsonl" }),
    ]);
    expect(
      rows.map(({ rank, provider, model, source, file, calls }) => ({
        rank,
        provider,
        model,
        source,
        file,
        calls,
      })),
    ).toEqual([
      {
        rank: 1,
        provider: "openrouter",
        model: "same",
        source: "provider-reported",
        file: undefined,
        calls: 2,
      },
      { rank: 2, provider: "local", model: "same", source: undefined, file: undefined, calls: 1 },
      {
        rank: 3,
        provider: "openrouter",
        model: "same",
        source: undefined,
        file: "fixtures/calls.jsonl",
        calls: 1,
      },
    ]);
  });

  it("keeps only the top N after ranking, deterministic on ties", () => {
    const rows = summarizeUsage(
      [
        call({ model: "a", costUsd: 1 }),
        call({ model: "b", costUsd: 3 }),
        call({ model: "c", costUsd: 2 }),
        call({ model: "d", costUsd: 2 }),
      ],
      3,
    );
    expect(rows.map((row) => row.model)).toEqual(["b", "c", "d"]);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, 3]);
  });

  it("counts a call without a cost as unpriced instead of free", () => {
    const rows = summarizeUsage([
      call({ costUsd: null }),
      call({ costUsd: 0.25 }),
      call({ costUsd: Number.NaN }),
    ]);
    expect(rows[0]).toMatchObject({ calls: 3, spendUsd: 0.25, unpricedCalls: 2 });
  });

  it("falls back to input plus output tokens when no total was recorded", () => {
    const rows = summarizeUsage([
      call({ totalTokens: null, inputTokens: 10, outputTokens: 5 }),
      call({ totalTokens: 40, inputTokens: 99, outputTokens: 99 }),
      call({ totalTokens: null, inputTokens: null, outputTokens: null }),
    ]);
    expect(rows[0]?.tokens).toBe(55);
  });

  it("returns no rows for no events", () => {
    expect(summarizeUsage([])).toEqual([]);
  });
});
