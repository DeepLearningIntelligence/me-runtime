import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineWakeupJob } from "@rakazo/adapter-kit";
import { nextRoutineRunDateAcross } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, spaceTakesWork } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import type { ExecutorDeps } from "./executor-deps.js";
import { runPersonalizeHeartbeat } from "./personalize.js";

/** The one daily tick: 09:00 in the person's own zone, like a routine's local schedule. */
export const PERSONALIZE_HEARTBEAT_CRON = "0 9 * * *";

const PersonalizeHeartbeatMarkerSchema = z.object({
  version: z.literal(1),
  kind: z.literal("heartbeat"),
});

/** The marker a routine row carries when it is the person's PersonalizeME heartbeat. */
export const PERSONALIZE_HEARTBEAT_MARKER = {
  version: 1,
  kind: "heartbeat",
} as const;

export function isPersonalizeHeartbeatRoutine(value: unknown): boolean {
  return PersonalizeHeartbeatMarkerSchema.safeParse(value).success;
}

type HeartbeatBot = {
  id: string;
  thread: { id: string } | null;
};

/**
 * Finds or creates the one heartbeat routine per person per Space. It rides the existing
 * routine scheduler, so connected channels never multiply the schedule; the delivery target
 * is resolved when it ticks.
 */
export async function ensurePersonalizeHeartbeatRoutine(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  input: { spaceId: string; userId: string },
): Promise<{ id: string; created: boolean } | null> {
  const [user, identity, fallbackBot] = await Promise.all([
    deps.prisma.user.findUnique({
      where: { id: input.userId },
      select: { timezone: true },
    }),
    deps.prisma.messagingIdentity.findFirst({
      where: { spaceId: input.spaceId, userId: input.userId },
      orderBy: [{ createdAt: "desc" }],
      select: { botId: true },
    }),
    deps.prisma.bot.findFirst({
      where: { spaceId: input.spaceId, userId: input.userId, archivedAt: null },
      orderBy: [{ createdAt: "asc" }],
      select: { id: true, thread: { select: { id: true } } },
    }),
  ]);
  const bot: HeartbeatBot | null = identity
    ? await deps.prisma.bot.findFirst({
        where: {
          id: identity.botId,
          spaceId: input.spaceId,
          userId: input.userId,
          archivedAt: null,
        },
        select: { id: true, thread: { select: { id: true } } },
      })
    : fallbackBot;
  if (!bot) return null;

  const timezone = user?.timezone ?? "UTC";
  const nextRunAt = nextRoutineRunDateAcross(
    [PERSONALIZE_HEARTBEAT_CRON],
    new Date(),
    new Date(),
    timezone,
  );

  const outcome = await deps.prisma.$transaction(async (tx) => {
    // One schedule per person whatever channels they have, even when two requests race.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`personalize-routine:${input.spaceId}:${input.userId}`}))`;
    const existing = await tx.routine.findFirst({
      where: {
        spaceId: input.spaceId,
        userId: input.userId,
        personalize: { not: Prisma.DbNull },
      },
      select: { id: true, nextRunAt: true },
    });
    if (existing) return { id: existing.id, created: false, nextRunAt: existing.nextRunAt };
    const routine = await tx.routine.create({
      data: {
        spaceId: input.spaceId,
        botId: bot.id,
        threadId: bot.thread?.id ?? null,
        userId: input.userId,
        name: "PersonalizeME",
        prompt:
          "Runs the daily PersonalizeME heartbeat: reads your context and asks up to two nudges.",
        crons: [PERSONALIZE_HEARTBEAT_CRON],
        timezone,
        active: true,
        notify: false,
        personalize: PERSONALIZE_HEARTBEAT_MARKER,
        nextRunAt,
      },
      select: { id: true },
    });
    return { id: routine.id, created: true, nextRunAt };
  });

  // Job reconciliation repairs a missed wakeup for an active routine, so this is best effort.
  if (outcome.created && outcome.nextRunAt) {
    await deps.jobs.enqueue(routineWakeupJob(outcome.id, outcome.nextRunAt)).catch((error) => {
      getLogger().error("personalize.routine_wakeup", error);
    });
  }
  return { id: outcome.id, created: outcome.created };
}

/**
 * One heartbeat occurrence. Delivery runs first because the engine's delivered keys make a
 * retried tick a no-op; the routine claim then advances the schedule and queues the next one.
 */
export async function wakePersonalizeHeartbeat(
  deps: Pick<ExecutorDeps, "prisma" | "jobs" | "events" | "memory">,
  routine: {
    id: string;
    spaceId: string;
    userId: string;
    botId: string;
    timezone: string;
    crons: string[];
  },
  input: { scheduledAt: Date; botThreadId: string | null },
): Promise<void> {
  const user = await deps.prisma.user.findUnique({
    where: { id: routine.userId },
    select: { id: true, timezone: true },
  });
  if (!user) return;
  await runPersonalizeHeartbeat(
    deps,
    { id: routine.spaceId },
    { id: user.id, timezone: user.timezone },
    input.scheduledAt,
    input.botThreadId ? { target: { botId: routine.botId, threadId: input.botThreadId } } : {},
  );

  const now = new Date();
  const nextRunAt = nextRoutineRunDateAcross(
    routine.crons,
    input.scheduledAt,
    now,
    routine.timezone,
  );
  const claimed = await deps.prisma.$transaction(async (tx) => {
    if (!(await spaceTakesWork(tx, routine.spaceId))) return false;
    const updated = await tx.routine.updateMany({
      where: { id: routine.id, active: true, nextRunAt: input.scheduledAt },
      data: { lastRunAt: now, ...(nextRunAt ? { nextRunAt } : { active: false }) },
    });
    return updated.count === 1;
  });
  if (!claimed) return;
  if (nextRunAt) {
    await deps.jobs.enqueue(routineWakeupJob(routine.id, nextRunAt)).catch((error) => {
      getLogger().error("personalize.routine_wakeup", error);
    });
  }
}
