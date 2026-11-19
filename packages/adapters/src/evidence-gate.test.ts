import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emitGateEvidence, verifyGateEvidence } from "./evidence-gate.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "rakazo-gate-"));
}

describe("gate evidence", () => {
  it("appends validated artifacts and verifies them", async () => {
    const dir = await tempDir();
    try {
      const file = await emitGateEvidence("run_1", "pnpm check", 0, { tests: 3 }, dir);
      await emitGateEvidence("run_2", "pnpm check", 1, {}, dir);
      expect(file).toBe(path.join(dir, "gate.jsonl"));
      await expect(verifyGateEvidence(dir)).resolves.toEqual({
        artifacts: 2,
        ok: true,
        failures: [],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses malformed artifacts before they are written", async () => {
    const dir = await tempDir();
    try {
      await expect(emitGateEvidence("", "pnpm check", 0, {}, dir)).rejects.toThrow(
        "runId is required",
      );
      await expect(emitGateEvidence("run_1", "", 0, {}, dir)).rejects.toThrow("cmd is required");
      await expect(emitGateEvidence("run_1", "pnpm check", 0.5, {}, dir)).rejects.toThrow(
        "exitCode must be an integer",
      );
      await expect(emitGateEvidence("run_1", "pnpm check", 0, { tests: -1 }, dir)).rejects.toThrow(
        "non-negative number",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when there is no evidence", async () => {
    const dir = await tempDir();
    try {
      await expect(verifyGateEvidence(dir)).rejects.toThrow("none_found");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
