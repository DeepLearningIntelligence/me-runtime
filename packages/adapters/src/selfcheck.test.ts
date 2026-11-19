import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MaybeAutoSkillRun } from "./selfcheck.js";
import { maybeAutoSkill, runSignature, scanSelfCheckFindings } from "./selfcheck.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "selfcheck-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function completed(runId: string, userText: string, status = "completed"): MaybeAutoSkillRun {
  return { runId, userText, status, completedAt: new Date("2026-11-18T10:00:00.000Z") };
}

describe("runSignature", () => {
  it("normalizes the verb and object, dropping filler words", () => {
    expect(runSignature("Please summarize the Q3 sales report")).toBe("summarize q3 sales report");
    expect(runSignature("summarize the Q3 sales report")).toBe("summarize q3 sales report");
    expect(runSignature("Fix the flaky login test")).toBe("fix flaky login test");
  });

  it("keeps different work on different signatures", () => {
    expect(runSignature("summarize the Q3 report")).not.toBe(
      runSignature("fix the login redirect"),
    );
  });

  it("returns null when there is no verb", () => {
    expect(runSignature("")).toBeNull();
    expect(runSignature("please the an")).toBeNull();
  });
});

describe("maybeAutoSkill", () => {
  it("does nothing at two similar completed runs", () => {
    const dir = tempDir();
    const suggestion = maybeAutoSkill(
      "user-1",
      [
        completed("run-1", "summarize the Q3 sales report"),
        completed("run-2", "summarize the Q3 sales report"),
      ],
      { dir, now: new Date("2026-11-19T12:00:00.000Z") },
    );
    expect(suggestion).toBeNull();
    expect(existsSync(join(dir, "summarize-q3-sales-report", "SKILL.md"))).toBe(false);
  });

  it("writes a verified skill doc at three and returns the suggestion", () => {
    const dir = tempDir();
    const suggestion = maybeAutoSkill(
      "user-1",
      [
        completed("run-1", "summarize the Q3 sales report"),
        completed("run-2", "Please summarize the Q3 sales report"),
        completed("run-3", "summarize Q3 sales report"),
      ],
      { dir, now: new Date("2026-11-19T12:00:00.000Z") },
    );
    expect(suggestion).toBe("You do this 3 times; want a skill for summarize q3 sales report?");
    const file = join(dir, "summarize-q3-sales-report", "SKILL.md");
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, "utf8");
    expect(content).toContain("name: summarize-q3-sales-report");
    expect(content).toContain("owner: user-1");
    expect(content).toContain('runIds: ["run-1", "run-2", "run-3"]');
    expect(content).toContain("verifiedAt: 2026-11-19T12:00:00.000Z");
    expect(content).toContain("run-1 completed");
    expect(content).toContain("run-2 completed");
    expect(content).toContain("run-3 completed");
  });

  it("counts only completed runs", () => {
    const dir = tempDir();
    const suggestion = maybeAutoSkill(
      "user-1",
      [
        completed("run-1", "summarize the Q3 sales report"),
        completed("run-2", "summarize the Q3 sales report"),
        completed("run-3", "summarize the Q3 sales report", "failed"),
      ],
      { dir },
    );
    expect(suggestion).toBeNull();
    expect(existsSync(join(dir, "summarize-q3-sales-report", "SKILL.md"))).toBe(false);
  });

  it("picks the group that crosses the threshold, not another run", () => {
    const dir = tempDir();
    const suggestion = maybeAutoSkill(
      "user-1",
      [
        completed("run-1", "fix the login redirect"),
        completed("run-2", "fix the login redirect"),
        completed("run-3", "fix the login redirect"),
        completed("run-4", "summarize the Q3 sales report"),
      ],
      { dir },
    );
    expect(suggestion).toBe("You do this 3 times; want a skill for fix login redirect?");
    expect(existsSync(join(dir, "fix-login-redirect", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, "summarize-q3-sales-report", "SKILL.md"))).toBe(false);
  });

  it("reports the real count above the threshold", () => {
    const dir = tempDir();
    const suggestion = maybeAutoSkill(
      "user-1",
      [
        completed("run-1", "fix the login redirect"),
        completed("run-2", "fix the login redirect"),
        completed("run-3", "fix the login redirect"),
        completed("run-4", "fix the login redirect"),
      ],
      { dir },
    );
    expect(suggestion).toBe("You do this 4 times; want a skill for fix login redirect?");
  });

  it("does not overwrite an existing skill doc", () => {
    const dir = tempDir();
    const runs = [
      completed("run-1", "fix the login redirect"),
      completed("run-2", "fix the login redirect"),
      completed("run-3", "fix the login redirect"),
    ];
    expect(maybeAutoSkill("user-1", runs, { dir })).not.toBeNull();
    expect(maybeAutoSkill("user-1", runs, { dir })).toBeNull();
  });
});

describe("scanSelfCheckFindings", () => {
  it("finds the user's own words quoted back", () => {
    const findings = scanSelfCheckFindings({
      runId: "run-1",
      userText: "export every row to the sheet",
      transcript: "You said the export would include every row, but it did not.",
    });
    expect(findings).toEqual([expect.objectContaining({ kind: "user_echo", runId: "run-1" })]);
  });

  it("finds unresolved markers in the reply and the user's words", () => {
    const reply = scanSelfCheckFindings({
      runId: "run-2",
      userText: "",
      transcript: "I changed the retry loop; it should work now.",
    });
    expect(reply.map((finding) => finding.kind)).toContain("unresolved_marker");
    expect(reply.some((finding) => finding.excerpt.startsWith("should work"))).toBe(true);

    const asked = scanSelfCheckFindings({
      runId: "run-3",
      userText: "this probably never ran",
      transcript: "Done.",
    });
    expect(asked.some((finding) => finding.excerpt.startsWith("probably"))).toBe(true);
  });

  it("finds a backtick'd fix that nothing ran", () => {
    const findings = scanSelfCheckFindings({
      runId: "run-4",
      userText: "",
      transcript: "Apply `pnpm test --filter adapters` and it will pass.",
    });
    expect(findings).toEqual([
      { kind: "backtick_without_run", excerpt: "pnpm test --filter adapters", runId: "run-4" },
    ]);
  });

  it("does not flag a backtick'd command the transcript shows ran", () => {
    const findings = scanSelfCheckFindings({
      runId: "run-5",
      userText: "",
      transcript: "I ran pnpm test --filter adapters.\n\nApply `pnpm test --filter adapters`.",
    });
    expect(findings.filter((finding) => finding.kind === "backtick_without_run")).toHaveLength(0);
  });

  it("does not flag a backtick'd command an existing skill carries", () => {
    const findings = scanSelfCheckFindings(
      {
        runId: "run-6",
        userText: "",
        transcript: "Apply `pnpm test --filter adapters` and it will pass.",
      },
      ["release: runs pnpm test --filter adapters before tagging"],
    );
    expect(findings.filter((finding) => finding.kind === "backtick_without_run")).toHaveLength(0);
  });

  it("returns nothing for a clean, resolved reply", () => {
    expect(
      scanSelfCheckFindings({
        runId: "run-7",
        userText: "fix the login redirect",
        transcript:
          "The redirect now points at /home. The test suite passed and I read the output.",
      }),
    ).toEqual([]);
  });
});
