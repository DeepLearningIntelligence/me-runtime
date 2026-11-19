import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The evidence-gated verification loop (Packet D, QW-2).
 *
 * Every gate run appends one artifact to `docs/evidence/gate/`, and `pnpm verify:evidence`
 * reads the log back and refuses an artifact that does not carry what it claims. Evidence
 * is append-only: a run's record is never rewritten, so the log is what happened, in order.
 */

/** The one file every gate run appends to; one artifact per line. */
export const GATE_EVIDENCE_FILE = "gate.jsonl";

/** One artifact: what the gate ran, how it exited, and the counts it produced. */
export interface GateEvidence {
  runId: string;
  cmd: string;
  exitCode: number;
  counts: Record<string, number>;
  at: string;
}

/** Named refusals: a malformed artifact or a missing log is never read as a pass. */
export type GateEvidenceErrorKey = "gate_evidence_invalid" | "gate_evidence_missing";

export class GateEvidenceError extends Error {
  constructor(
    readonly key: GateEvidenceErrorKey,
    message: string,
  ) {
    super(message);
    this.name = "GateEvidenceError";
  }
}

/**
 * The repository's `docs/evidence/gate/` directory, resolved from this module rather than
 * the working directory, so a package script and a root script write the same place.
 */
export function gateEvidenceDir(): string {
  return fileURLToPath(new URL("../../../docs/evidence/gate/", import.meta.url));
}

function invalid(message: string): GateEvidenceError {
  return new GateEvidenceError("gate_evidence_invalid", message);
}

/** Validates one artifact before it is written; a bad record is never appended. */
export function gateArtifact(
  runId: string,
  cmd: string,
  exitCode: number,
  counts: Record<string, number>,
  at: Date = new Date(),
): GateEvidence {
  const trimmedRun = typeof runId === "string" ? runId.trim() : "";
  if (trimmedRun === "") throw invalid("runId is required");
  const trimmedCmd = typeof cmd === "string" ? cmd.trim() : "";
  if (trimmedCmd === "") throw invalid("cmd is required");
  if (!Number.isInteger(exitCode)) throw invalid("exitCode must be an integer");
  if (typeof counts !== "object" || counts === null || Array.isArray(counts))
    throw invalid("counts must be an object");
  for (const [key, count] of Object.entries(counts)) {
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0)
      throw invalid(`count ${key} must be a non-negative number`);
  }
  return { runId: trimmedRun, cmd: trimmedCmd, exitCode, counts: { ...counts }, at: at.toISOString() };
}

/** Appends one validated artifact; returns the file it landed in. */
export async function emitGateEvidence(
  runId: string,
  cmd: string,
  exitCode: number,
  counts: Record<string, number>,
  dir: string = gateEvidenceDir(),
  at: Date = new Date(),
): Promise<string> {
  const artifact = gateArtifact(runId, cmd, exitCode, counts, at);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, GATE_EVIDENCE_FILE);
  await appendFile(file, `${JSON.stringify(artifact)}\n`, "utf8");
  return file;
}

export interface GateEvidenceSummary {
  artifacts: number;
  ok: boolean;
  failures: string[];
}

function artifactFailure(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "artifact is not an object";
  const record = value as Record<string, unknown>;
  if (typeof record.runId !== "string" || record.runId.trim() === "") return "runId is missing";
  if (typeof record.cmd !== "string" || record.cmd.trim() === "") return "cmd is missing";
  if (!Number.isInteger(record.exitCode)) return "exitCode is not an integer";
  const counts = record.counts;
  if (typeof counts !== "object" || counts === null || Array.isArray(counts))
    return "counts is missing";
  for (const [key, count] of Object.entries(counts as Record<string, unknown>)) {
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0)
      return `count ${key} is not a non-negative number`;
  }
  if (typeof record.at !== "string" || Number.isNaN(Date.parse(record.at)))
    return "at is not a timestamp";
  return undefined;
}

/**
 * Reads the gate log back. A missing or empty log is a named failure, never a pass;
 * every artifact must carry the shape `emitGateEvidence` writes.
 */
export async function verifyGateEvidence(dir: string = gateEvidenceDir()): Promise<GateEvidenceSummary> {
  const file = path.join(dir, GATE_EVIDENCE_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new GateEvidenceError(
      "gate_evidence_missing",
      `no gate evidence at ${file} (none_found)`,
    );
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0)
    throw new GateEvidenceError("gate_evidence_missing", `the gate evidence file is empty (none_found)`);
  const failures: string[] = [];
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      failures.push(`line ${index + 1}: not JSON`);
      continue;
    }
    const failure = artifactFailure(parsed);
    if (failure) failures.push(`line ${index + 1}: ${failure}`);
  }
  return { artifacts: lines.length, ok: failures.length === 0, failures };
}
