import { spawnSync } from "node:child_process";
import { emitGateEvidence, verifyGateEvidence } from "../packages/adapters/src/evidence-gate.js";

/**
 * Evidence-gated verification loop (Packet D, QW-2).
 *
 * Runs the gate (`pnpm check`), records what it ran and how it exited, then reads the
 * evidence log back. A failed gate, or evidence that does not carry what it claims, exits
 * non-zero: a run with no evidence is never a pass.
 */

const runId = `check-${process.env.GITHUB_SHA ?? "local"}-${Date.now()}`;
const gate = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["check"], {
  stdio: "inherit",
});
const exitCode = gate.status ?? 1;
const artifact = await emitGateEvidence(runId, "pnpm check", exitCode, {});
console.log(`gate evidence: ${artifact}`);
const summary = await verifyGateEvidence();
console.log(`gate evidence verified: ${summary.artifacts} artifact(s)`);
if (!summary.ok) {
  for (const failure of summary.failures) console.error(`gate evidence: ${failure}`);
}
process.exit(exitCode === 0 && summary.ok ? 0 : 1);
