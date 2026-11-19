import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { MaybeAutoSkillRun, SelfCheckFinding } from "./selfcheck.js";
import { maybeAutoSkill, scanSelfCheckFindings } from "./selfcheck.js";

/** Text the person or bot actually wrote in a message's blocks, in order. */
export function messageText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter(
      (block): block is Extract<MessageBlock, { kind: "text" }> =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { kind?: unknown }).kind === "text",
    )
    .map((block) => (typeof block.text === "string" ? block.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}

const SKILL_TEXT_LIMIT = 50;

/**
 * After a run completes: scan its reply for echoes of the user's words,
 * unresolved markers and promised fixes nothing ran. Returns the findings and
 * logs nothing itself; the caller decides what to surface.
 */
export async function selfCheckRun(
  prisma: PrismaClient,
  input: { runId: string; spaceId: string },
): Promise<SelfCheckFinding[]> {
  const run = await prisma.run.findUnique({
    where: { id: input.runId },
    select: {
      id: true,
      status: true,
      completedAt: true,
      sourceMessageId: true,
      sourceMessage: { select: { blocks: true } },
    },
  });
  if (!run) return [];

  const reply = await prisma.message.findFirst({
    where: { runId: input.runId, role: "bot" },
    orderBy: { seq: "desc" },
    select: { blocks: true },
  });

  // Existing skills are evidence a promised command already ran before.
  const skills = await prisma.agentSkill.findMany({
    where: { spaceId: input.spaceId },
    orderBy: { updatedAt: "desc" },
    take: SKILL_TEXT_LIMIT,
    select: { name: true, description: true },
  });

  return scanSelfCheckFindings(
    {
      runId: run.id,
      userText: messageText(run.sourceMessage?.blocks),
      transcript: messageText(reply?.blocks),
      status: run.status,
      completedAt: run.completedAt,
    },
    skills.map((skill) => `${skill.name} ${skill.description}`),
  );
}

/**
 * The user-message path: after the person's latest run, offer a skill when they
 * have asked for the same work three or more times. Writes the verified doc and
 * returns the suggestion text; it never messages or starts anything itself.
 */
export async function maybeAutoSkillForUser(
  prisma: PrismaClient,
  userId: string,
  options: { now?: Date; dir?: string } = {},
): Promise<string | null> {
  const runs = await prisma.run.findMany({
    where: { userId, status: "completed" },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      status: true,
      completedAt: true,
      sourceMessage: { select: { blocks: true } },
    },
  });
  const mapped: MaybeAutoSkillRun[] = runs.map((run) => ({
    runId: run.id,
    status: run.status,
    completedAt: run.completedAt,
    userText: messageText(run.sourceMessage?.blocks),
  }));
  return maybeAutoSkill(userId, mapped, options);
}
