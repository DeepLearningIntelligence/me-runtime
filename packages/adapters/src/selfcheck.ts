import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSkillMd } from "@rakazo/core";

/**
 * Self-check of run outcomes against the person who asked: scans a run's reply
 * for echoes of the user's own words, unresolved markers, and fixes the reply
 * promises without ever recording that anything ran.
 */
export type SelfCheckFindingKind = "user_echo" | "unresolved_marker" | "backtick_without_run";

export type SelfCheckFinding = {
  kind: SelfCheckFindingKind;
  /** Short quoted text around the finding, from the run summary. */
  excerpt: string;
  runId: string;
};

export type SelfCheckRunSummary = {
  runId: string;
  /** The user's own words for the run, as they asked. */
  userText: string;
  /** The run's reply text (assistant text blocks of the run). */
  transcript: string;
  status?: string;
  completedAt?: Date | null;
};

const ECHO_PATTERN = /\b(?:you said|i asked for|as i said|i mentioned|the user said)\b/i;
const UNRESOLVED_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bshould have worked\b/i, label: "should have worked" },
  { re: /\bshould work\b/i, label: "should work" },
  { re: /\bprobab(?:ly|le)?\b/i, label: "probably" },
  { re: /\bunclear\b/i, label: "unclear" },
  { re: /\bnot sure\b/i, label: "not sure" },
  { re: /\bunverified\b/i, label: "unverified" },
];

/** A backtick'd span that reads like a command someone promised to verify by running. */
const COMMAND_LIKE =
  /^(?:cd|npm|pnpm|yarn|npx|node|python3?|curl|wget|make|git|docker|grep|find)\b/i;

const SPAN_PATTERN = /`([^`\n]+)`/g;
const MAX_FINDINGS_PER_RUN = 8;

function excerptOf(text: string, max = 160): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max).trim();
}

function matchExcerpt(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  if (!match) return undefined;
  const before = text.slice(Math.max(0, match.index - 40), match.index).trim();
  const after = text
    .slice(match.index + match[0].length)
    .split(/[\n.!?]/)[0]
    ?.trim();
  return excerptOf(`${before ? `${before} ` : ""}${match[0].trim()}${after ? ` ${after}` : ""}`);
}

export function scanSelfCheckFindings(
  runSummary: SelfCheckRunSummary,
  skills: readonly string[] = [],
): SelfCheckFinding[] {
  const findings: SelfCheckFinding[] = [];
  const transcript = runSummary.transcript ?? "";
  const userText = runSummary.userText ?? "";
  const seen = new Set<string>();
  const push = (kind: SelfCheckFindingKind, excerpt: string) => {
    const text = excerptOf(excerpt);
    if (!text) return;
    const key = `${kind}:${text.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ kind, excerpt: text, runId: runSummary.runId });
  };

  // 1. The user's own words quoted back at them ("you said ...", "I asked for ...").
  const echo = matchExcerpt(transcript, ECHO_PATTERN);
  if (echo) push("user_echo", echo);

  // 2. Unresolved markers, in the reply or in the user's own words.
  for (const { re, label } of UNRESOLVED_PATTERNS) {
    const excerpt = matchExcerpt(transcript, re) ?? matchExcerpt(userText, re);
    if (excerpt) push("unresolved_marker", label);
  }

  // 3. A backtick'd fix with no recorded run: it is not echoed elsewhere in the
  // transcript and no existing skill carries it, so nothing shows anything ran.
  for (const match of transcript.matchAll(SPAN_PATTERN)) {
    const span = (match[1] ?? "").trim();
    if (!span || !COMMAND_LIKE.test(span)) continue;
    const occurrences = transcript.split(span).length - 1;
    if (occurrences > 1) continue;
    if (skills.some((skill) => skill.includes(span))) continue;
    push("backtick_without_run", span);
    if (findings.length >= MAX_FINDINGS_PER_RUN) break;
  }

  return findings.slice(0, MAX_FINDINGS_PER_RUN);
}

/** Runs a skill can be built from: completed, with the user's own words recorded. */
export type MaybeAutoSkillRun = {
  runId: string;
  userText?: string | null;
  status?: string | null;
  completedAt?: Date | null;
};

export const AUTOSKILL_THRESHOLD = 3;
/** The repo's on-disk skills library, beside the SKILL.md files maintainers write. */
export const DEFAULT_SKILLS_DIR = ".agents/skills";

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "for",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "my",
  "me",
  "i",
  "we",
  "you",
  "your",
  "our",
  "their",
  "his",
  "her",
  "its",
  "please",
  "can",
  "could",
  "would",
  "should",
  "will",
  "may",
  "might",
  "now",
  "let",
  "help",
  "hey",
  "hi",
  "hello",
  "thanks",
  "thank",
  "again",
]);

function signatureWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word));
}

/**
 * The (verb, object) signature two runs share when the person asked for the same
 * kind of work. Normalized: lowercase, punctuation and filler words dropped.
 */
export function runSignature(userText: string | null | undefined): string | null {
  const words = signatureWords(userText ?? "");
  if (words.length === 0) return null;
  const [verb, ...rest] = words;
  if (!verb) return null;
  return rest.length > 0 ? `${verb} ${rest.join(" ")}` : verb;
}

function slugForSignature(signature: string): string {
  return signature
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function writeAutoSkillDoc(options: {
  dir: string;
  slug: string;
  signature: string;
  user: string;
  runs: MaybeAutoSkillRun[];
  now: Date;
}): string {
  const { dir, slug, signature, user, runs, now } = options;
  const file = join(dir, slug, "SKILL.md");
  const outcomes = runs.map((run) => `${run.runId} ${run.status ?? "completed"}`);
  const content = buildSkillMd({
    name: slug,
    description: `Repeat "${signature}": reuse this verified recipe when the person asks for the same work again.`,
    body: [
      `# ${signature}`,
      "",
      `Built from ${runs.length} completed runs by ${user}. Treat it as a candidate recipe: check this run's outcome before relying on it, and change it when the work changes.`,
      "",
      `Evidence: ${outcomes.join("; ")}.`,
      "",
    ].join("\n"),
    frontmatter: {
      owner: user,
      provenance: { runIds: runs.map((run) => run.runId) },
      verifiedAt: now.toISOString(),
      evidence: runs.map(
        (run) =>
          `${run.runId} ${run.status ?? "completed"}${
            run.completedAt ? ` (${new Date(run.completedAt).toISOString()})` : ""
          }`,
      ),
    },
  });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  return file;
}

/**
 * When a person has done the same kind of work three or more times, write one
 * verified skill doc and return the one-line suggestion a caller can show them.
 * It never asks, messages, or starts anything on its own, and it returns null
 * below the threshold or when the skill already exists.
 */
export function maybeAutoSkill(
  user: string,
  runs: readonly MaybeAutoSkillRun[],
  options: { now?: Date; dir?: string } = {},
): string | null {
  const groups = new Map<string, MaybeAutoSkillRun[]>();
  for (const run of runs) {
    if (run.status !== "completed") continue;
    if (!run.userText?.trim()) continue;
    const signature = runSignature(run.userText);
    if (!signature) continue;
    const group = groups.get(signature) ?? [];
    group.push(run);
    groups.set(signature, group);
  }

  const candidate = [...groups.entries()]
    .filter(([, group]) => group.length >= AUTOSKILL_THRESHOLD)
    .sort((left, right) => right[1].length - left[1].length)[0];
  if (!candidate) return null;

  const [signature, group] = candidate;
  const dir = options.dir ?? join(process.cwd(), DEFAULT_SKILLS_DIR);
  const slug = slugForSignature(signature);
  if (!slug) return null;
  if (existsSync(join(dir, slug, "SKILL.md"))) return null;

  writeAutoSkillDoc({
    dir,
    slug,
    signature,
    user,
    runs: group,
    now: options.now ?? new Date(),
  });
  return `You do this ${group.length} times; want a skill for ${signature}?`;
}
