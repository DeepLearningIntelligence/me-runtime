import { runContinueJob } from "@rakazo/adapter-kit";
import { wallClock, zonedDateTime } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { isUniqueViolation } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import type { ExecutorDeps } from "./executor-deps.js";

export const FOLLOW_UP_NONCE_PREFIX = "follow_up:";
export const FOLLOW_UP_STATE_VERSION = 1 as const;
export const DEFAULT_QUIET_HOURS_START = 22 * 60;
export const DEFAULT_QUIET_HOURS_END = 7 * 60;
export const DEFAULT_FOLLOW_UP_DAILY_CAP = 1;

/**
 * The whole turn's guidance for a follow-up run. The item is already checked before this run
 * starts, and it checks again because the state can change while the turn waits its turn.
 */
export const FOLLOW_UP_RUN_INSTRUCTION =
  "This is a follow-up on one open item. Check the current state of the item and whether the person still wants the follow-up. If it is resolved, dismissed, unchanged since it was last updated, or outside their delivery preferences, stay silent and reply exactly NO_RESPONSE. Otherwise say what happened or what is blocked, cite the receipt or run, and ask one question that moves it forward. Three sentences maximum.";

export const FollowUpStateSchema = z.object({
  version: z.literal(FOLLOW_UP_STATE_VERSION),
  itemId: z.string().min(1),
  /** When the person agreed to this follow-up; null means it was never opted into. */
  agreedAt: z.string().datetime().nullable(),
  /** The item's updatedAt when the follow-up was armed. */
  seenUpdatedAt: z.string().datetime(),
  status: z.enum(["armed", "dismissed"]),
});
export type FollowUpState = z.infer<typeof FollowUpStateSchema>;

export type FollowUpPreference = {
  followUps: boolean;
  quietHoursStart: number;
  quietHoursEnd: number;
  followUpDailyCap: number;
};

export const DEFAULT_FOLLOW_UP_PREFERENCE: Readonly<FollowUpPreference> = {
  followUps: true,
  quietHoursStart: DEFAULT_QUIET_HOURS_START,
  quietHoursEnd: DEFAULT_QUIET_HOURS_END,
  followUpDailyCap: DEFAULT_FOLLOW_UP_DAILY_CAP,
};

export type FollowUpSilenceReason =
  | "not_opted_in"
  | "dismissed"
  | "opted_out"
  | "preference_off"
  | "item_missing"
  | "resolved"
  | "unchanged"
  | "quiet_hours"
  | "over_cap";

export function parseFollowUpState(value: unknown): FollowUpState | null {
  const parsed = FollowUpStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function followUpRunNonce(routineId: string): string {
  return `${FOLLOW_UP_NONCE_PREFIX}${routineId}`;
}

export function followUpRoutinePrompt(
  item: { id: string; title: string; notes: string },
  requested: string,
): string {
  const notes = item.notes.trim();
  return [
    FOLLOW_UP_RUN_INSTRUCTION,
    `The open item is "${item.title}" (${item.id}).`,
    notes ? `Its last note: ${notes}` : undefined,
    "Read the item with scratchpad_list before you reply.",
    "",
    "What the person asked you to check:",
    requested.trim(),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/** The start of the person's local day, for the daily follow-up cap. */
export function localDayStart(now: Date, timezone: string): Date {
  const day = wallClock(now, timezone).slice(0, 10);
  return zonedDateTime(`${day}T00:00:00`, timezone) ?? new Date(now.getTime());
}

export function minuteOfLocalDay(now: Date, timezone: string): number {
  const wall = wallClock(now, timezone);
  const hour = Number(wall.slice(11, 13));
  const minute = Number(wall.slice(14, 16));
  return hour * 60 + minute;
}

/** A quiet window that wraps midnight keeps both sides of the clock. Equal bounds mean none. */
export function inQuietHours(minute: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/**
 * Why this follow-up must stay silent, or null when it may speak. Every reason is enforced
 * here, before a run is created, so a silent follow-up costs no model call and leaves a log.
 */
export function followUpSilenceReason(input: {
  state: FollowUpState;
  item: { status: string; updatedAt: Date } | null;
  preference: FollowUpPreference | null;
  optedOut: boolean;
  deliveriesToday: number;
  now: Date;
  timezone: string;
}): FollowUpSilenceReason | null {
  const { state, item, preference, optedOut, deliveriesToday, now, timezone } = input;
  // A person with no row gets the same policy the row would have: the database defaults are
  // the product's defaults, not a bypass. Reading them only when a row exists let a consented
  // follow-up speak during quiet hours and ignored the daily cap entirely.
  const policy = preference ?? DEFAULT_FOLLOW_UP_PREFERENCE;
  if (!state.agreedAt) return "not_opted_in";
  if (state.status === "dismissed") return "dismissed";
  if (optedOut) return "opted_out";
  if (!policy.followUps) return "preference_off";
  if (!item) return "item_missing";
  if (item.status === "done") return "resolved";
  if (item.updatedAt.getTime() <= Date.parse(state.seenUpdatedAt)) return "unchanged";
  if (
    inQuietHours(
      minuteOfLocalDay(now, timezone),
      policy.quietHoursStart,
      policy.quietHoursEnd,
    )
  ) {
    return "quiet_hours";
  }
  if (deliveriesToday >= policy.followUpDailyCap) return "over_cap";
  return null;
}

type FollowUpRoutine = {
  id: string;
  spaceId: string;
  botId: string;
  userId: string;
  prompt: string;
  followUp: unknown;
};

type FollowUpDeps = Pick<ExecutorDeps, "prisma" | "jobs" | "now"> & {
  events: Pick<ExecutorDeps["events"], "append">;
};

function logSilent(routineId: string, itemId: string, reason: FollowUpSilenceReason | string) {
  getLogger().info("follow_up.silent", {
    "followUp.id": routineId,
    "followUp.itemId": itemId,
    "followUp.reason": reason,
  });
}

/**
 * Deliver a follow-up exactly once, or log why it stays silent. The routine claim advances
 * its row, and the run's (spaceId, clientNonce) key makes a second delivery impossible even
 * when a retried job or two schedulers reach this point together.
 */
export async function wakeFollowUp(
  deps: FollowUpDeps,
  routine: FollowUpRoutine,
  input: { scheduledAt: Date; threadId: string; now?: Date },
): Promise<boolean> {
  const state = parseFollowUpState(routine.followUp);
  if (!state) return false;
  const now = input.now ?? deps.now?.() ?? new Date();
  const [item, preference, user, bot] = await Promise.all([
    deps.prisma.scratchpadItem.findFirst({
      where: { id: state.itemId, spaceId: routine.spaceId, botId: routine.botId },
      select: { status: true, updatedAt: true },
    }),
    deps.prisma.notificationPreference.findUnique({
      where: { spaceId_userId: { spaceId: routine.spaceId, userId: routine.userId } },
      select: {
        followUps: true,
        quietHoursStart: true,
        quietHoursEnd: true,
        followUpDailyCap: true,
      },
    }),
    deps.prisma.user.findUnique({
      where: { id: routine.userId },
      select: { timezone: true },
    }),
    deps.prisma.bot.findUnique({
      where: { id: routine.botId },
      select: { dailyCheckIns: true },
    }),
  ]);
  const timezone = user?.timezone ?? "UTC";
  const policy = preference ?? DEFAULT_FOLLOW_UP_PREFERENCE;
  const deliveriesToday = await deps.prisma.run.count({
    where: {
      userId: routine.userId,
      clientNonce: { startsWith: FOLLOW_UP_NONCE_PREFIX },
      createdAt: { gte: localDayStart(now, timezone) },
    },
  });
  const reason = followUpSilenceReason({
    state,
    item,
    preference: policy,
    optedOut: !bot?.dailyCheckIns,
    deliveriesToday,
    now,
    timezone,
  });
  if (reason) {
    await deps.prisma.routine.updateMany({
      where: { id: routine.id, active: true, nextRunAt: input.scheduledAt },
      data: { active: false, nextRunAt: null },
    });
    logSilent(routine.id, state.itemId, reason);
    return true;
  }

  let run: { id: string };
  try {
    const outcome = await deps.prisma.$transaction(async (tx) => {
      // One follow-up at a time for one person. The count and the claim must see each
      // other, or two routines each count zero deliveries and both speak on the same day.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"follow_up:" + routine.userId}))`;
      const claimed = await tx.routine.updateMany({
        where: { id: routine.id, active: true, nextRunAt: input.scheduledAt },
        data: { active: false, nextRunAt: null, lastRunAt: now },
      });
      if (claimed.count !== 1) return "claimed_elsewhere" as const;
      const delivered = await tx.run.count({
        where: {
          userId: routine.userId,
          clientNonce: { startsWith: FOLLOW_UP_NONCE_PREFIX },
          createdAt: { gte: localDayStart(now, timezone) },
        },
      });
      if (delivered >= policy.followUpDailyCap) return "over_cap" as const;
      const task = await tx.task.create({
        data: {
          spaceId: routine.spaceId,
          botId: routine.botId,
          threadId: input.threadId,
          userId: routine.userId,
          prompt: routine.prompt,
          status: "queued",
        },
      });
      return tx.run.create({
        data: {
          spaceId: routine.spaceId,
          botId: routine.botId,
          threadId: input.threadId,
          taskId: task.id,
          userId: routine.userId,
          status: "queued",
          trigger: "routine",
          routineId: routine.id,
          clientNonce: followUpRunNonce(routine.id),
        },
        select: { id: true },
      });
    });
    if (typeof outcome === "string") {
      logSilent(routine.id, state.itemId, outcome);
      return true;
    }
    run = outcome;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // The run committed before the routine claim was cleared; the key stops the second send.
    await deps.prisma.routine.updateMany({
      where: { id: routine.id, active: true },
      data: { active: false, nextRunAt: null },
    });
    logSilent(routine.id, state.itemId, "already_delivered");
    return true;
  }
  try {
    await deps.jobs.enqueue(runContinueJob(run.id));
  } catch (error) {
    // The queued run is durable; reconciliation repairs a missed wake.
    getLogger().error("follow_up.enqueue", error);
  }
  try {
    await deps.events.append({
      spaceId: routine.spaceId,
      threadId: input.threadId,
      botId: routine.botId,
      type: "routine.fired",
      payload: { routineId: routine.id, scheduledFor: input.scheduledAt.toISOString() },
    });
  } catch {
    // The run is already queued even if the thread signal fails.
  }
  return true;
}

/** The routine row a follow-up is armed from, with the consent the caller must hold. */
export function followUpState(input: {
  item: { id: string; updatedAt: Date };
  agreedAt: Date;
}): FollowUpState {
  return {
    version: FOLLOW_UP_STATE_VERSION,
    itemId: input.item.id,
    agreedAt: input.agreedAt.toISOString(),
    seenUpdatedAt: input.item.updatedAt.toISOString(),
    status: "armed",
  };
}

export async function followUpItemForArming(
  prisma: Pick<PrismaClient, "scratchpadItem">,
  input: { itemId: string; spaceId: string; botId: string },
) {
  return prisma.scratchpadItem.findFirst({
    where: {
      id: input.itemId,
      spaceId: input.spaceId,
      botId: input.botId,
      status: { in: ["open", "parked"] },
    },
    select: { id: true, title: true, notes: true, updatedAt: true },
  });
}
