import type { PrismaClient } from "@rakazo/db";
import * as Logging from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FOLLOW_UP_DAILY_CAP,
  DEFAULT_QUIET_HOURS_END,
  DEFAULT_QUIET_HOURS_START,
  FOLLOW_UP_RUN_INSTRUCTION,
  followUpRoutinePrompt,
  followUpRunNonce,
  followUpSilenceReason,
  followUpState,
  localDayStart,
  minuteOfLocalDay,
  parseFollowUpState,
  wakeFollowUp,
} from "./follow-up.js";

const ARMED_AT = new Date("2026-11-19T08:00:00Z");
const SEEN_AT = new Date("2026-11-19T08:00:00Z");
const CHANGED_AT = new Date("2026-11-19T09:00:00Z");
const NOW = new Date("2026-11-19T12:00:00Z");
const SCHEDULED_AT = new Date("2026-11-19T12:00:00Z");

const state = followUpState({ item: { id: "item-1", updatedAt: SEEN_AT }, agreedAt: ARMED_AT });
const preference = {
  followUps: true,
  quietHoursStart: DEFAULT_QUIET_HOURS_START,
  quietHoursEnd: DEFAULT_QUIET_HOURS_END,
  followUpDailyCap: DEFAULT_FOLLOW_UP_DAILY_CAP,
};

function reason(
  overrides: Partial<Parameters<typeof followUpSilenceReason>[0]> = {},
): ReturnType<typeof followUpSilenceReason> {
  return followUpSilenceReason({
    state,
    item: { status: "open", updatedAt: CHANGED_AT },
    preference,
    optedOut: false,
    deliveriesToday: 0,
    now: NOW,
    timezone: "UTC",
    ...overrides,
  });
}

describe("follow-up silence reasons", () => {
  it("speaks when the item changed and every preference allows it", () => {
    expect(reason()).toBeNull();
  });

  it("stays silent for a resolved item", () => {
    expect(reason({ item: { status: "done", updatedAt: CHANGED_AT } })).toBe("resolved");
  });

  it("stays silent for a dismissed follow-up", () => {
    expect(reason({ state: { ...state, status: "dismissed" } })).toBe("dismissed");
  });

  it("stays silent when the item was not updated since it was armed", () => {
    expect(reason({ item: { status: "open", updatedAt: SEEN_AT } })).toBe("unchanged");
  });

  it("stays silent when the person opted out of check-ins", () => {
    expect(reason({ optedOut: true })).toBe("opted_out");
  });

  it("stays silent when the Space turned follow-ups off", () => {
    expect(reason({ preference: { ...preference, followUps: false } })).toBe("preference_off");
  });

  it("stays silent when the follow-up has no recorded agreement", () => {
    expect(reason({ state: { ...state, agreedAt: null } })).toBe("not_opted_in");
  });

  it("stays silent for a missing item", () => {
    expect(reason({ item: null })).toBe("item_missing");
  });

  it("stays silent inside quiet hours, including a window over midnight", () => {
    expect(reason({ now: new Date("2026-11-19T23:30:00Z") })).toBe("quiet_hours");
    expect(reason({ now: new Date("2026-11-19T02:00:00Z") })).toBe("quiet_hours");
    expect(reason({ now: new Date("2026-11-19T12:00:00Z") })).toBeNull();
  });

  it("treats equal quiet-hour bounds as no window", () => {
    expect(
      reason({
        preference: { ...preference, quietHoursStart: 600, quietHoursEnd: 600 },
        now: new Date("2026-11-19T10:00:00Z"),
      }),
    ).toBeNull();
  });

  it("stays silent at the daily cap", () => {
    expect(reason({ deliveriesToday: DEFAULT_FOLLOW_UP_DAILY_CAP })).toBe("over_cap");
  });

  it("reads quiet hours and the day boundary in the person's zone", () => {
    expect(minuteOfLocalDay(new Date("2026-11-19T23:30:00Z"), "Pacific/Auckland")).toBe(12 * 60 + 30);
    expect(localDayStart(new Date("2026-11-19T12:00:00Z"), "Pacific/Auckland").toISOString()).toBe(
      "2026-11-19T11:00:00.000Z",
    );
  });
});

describe("the follow-up turn instruction", () => {
  it("is stored with the item so the run reads it as its prompt", () => {
    const prompt = followUpRoutinePrompt(
      { id: "item-1", title: "Signed lease", notes: "Waiting on the tenant" },
      "Ask whether the lease arrived",
    );
    expect(prompt).toContain(FOLLOW_UP_RUN_INSTRUCTION);
    expect(prompt).toContain("Three sentences maximum.");
    expect(prompt).toContain("cite the receipt or run");
    expect(prompt).toContain("ask one question that moves it forward");
    expect(prompt).toContain("NO_RESPONSE");
    expect(prompt).toContain('The open item is "Signed lease" (item-1).');
  });

  it("round-trips the armed state and rejects a foreign value", () => {
    expect(parseFollowUpState(state)).toEqual(state);
    expect(parseFollowUpState({ itemId: "item-1" })).toBeNull();
    expect(parseFollowUpState(null)).toBeNull();
  });

  it("keys the delivery to the routine, not the attempt", () => {
    expect(followUpRunNonce("routine-1")).toBe("follow_up:routine-1");
    expect(followUpRunNonce("routine-1")).toBe(followUpRunNonce("routine-1"));
  });
});

describe("follow-up delivery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers once across a retried wake", async () => {
    const harness = wakeHarness({ followUpDailyCap: 5 });
    expect(await harness.wake()).toBe(true);
    expect(harness.runs).toHaveLength(1);
    // The routine claim was not visible to the retry, as after a worker restart.
    harness.rearm();
    expect(await harness.wake()).toBe(true);
    expect(harness.runs).toHaveLength(1);
    expect(harness.enqueued).toHaveLength(1);
    expect(harness.info).toHaveBeenCalledWith(
      "follow_up.silent",
      expect.objectContaining({ "followUp.reason": "already_delivered" }),
    );
  });

  it("delivers once when two schedulers race", async () => {
    const harness = wakeHarness();
    await Promise.all([harness.wake(), harness.wake()]);
    expect(harness.runs).toHaveLength(1);
    expect(harness.enqueued).toHaveLength(1);
    expect(harness.events).toHaveLength(1);
  });

  it("sends nothing when the item resolved itself", async () => {
    const harness = wakeHarness({ item: { status: "done", updatedAt: CHANGED_AT } });
    expect(await harness.wake()).toBe(true);
    expect(harness.runs).toHaveLength(0);
    expect(harness.tasks).toHaveLength(0);
    expect(harness.enqueued).toHaveLength(0);
    expect(harness.info).toHaveBeenCalledWith(
      "follow_up.silent",
      expect.objectContaining({ "followUp.reason": "resolved" }),
    );
  });

  it("sends nothing when the person opted out", async () => {
    const harness = wakeHarness({ optedOut: true });
    expect(await harness.wake()).toBe(true);
    expect(harness.runs).toHaveLength(0);
    expect(harness.info).toHaveBeenCalledWith(
      "follow_up.silent",
      expect.objectContaining({ "followUp.reason": "opted_out" }),
    );
  });

  it("sends nothing in quiet hours and says why", async () => {
    const harness = wakeHarness({ now: new Date("2026-11-19T23:30:00Z") });
    expect(await harness.wake()).toBe(true);
    expect(harness.runs).toHaveLength(0);
    expect(harness.info).toHaveBeenCalledWith(
      "follow_up.silent",
      expect.objectContaining({ "followUp.reason": "quiet_hours" }),
    );
  });

  it("sends nothing over the daily cap and says why", async () => {
    const harness = wakeHarness({ deliveriesToday: 1 });
    expect(await harness.wake()).toBe(true);
    expect(harness.runs).toHaveLength(0);
    expect(harness.info).toHaveBeenCalledWith(
      "follow_up.silent",
      expect.objectContaining({ "followUp.reason": "over_cap" }),
    );
  });

  it("sends nothing when the person dismissed it", async () => {
    const harness = wakeHarness({ status: "dismissed" });
    expect(await harness.wake()).toBe(true);
    expect(harness.runs).toHaveLength(0);
    expect(harness.info).toHaveBeenCalledWith(
      "follow_up.silent",
      expect.objectContaining({ "followUp.reason": "dismissed" }),
    );
  });
});

function wakeHarness(
  options: {
    item?: { status: string; updatedAt: Date } | null;
    followUps?: boolean;
    followUpDailyCap?: number;
    optedOut?: boolean;
    deliveriesToday?: number;
    now?: Date;
    status?: "armed" | "dismissed";
  } = {},
) {
  const info = vi.fn();
  const error = vi.fn();
  vi.spyOn(Logging, "getLogger").mockReturnValue({ info, error } as never);
  const row = {
    id: "routine-1",
    spaceId: "space-1",
    botId: "bot-1",
    userId: "user-1",
    threadId: "thread-1",
    active: true,
    nextRunAt: SCHEDULED_AT,
    prompt: "Follow up on the lease.",
    followUp: { ...state, status: options.status ?? "armed" },
  };
  const runs: Array<{ id: string; clientNonce: string }> = [];
  const tasks: Array<{ id: string }> = [];
  const enqueued: string[] = [];
  const events: unknown[] = [];
  const prisma = {
    scratchpadItem: {
      findFirst: async () =>
        options.item === undefined ? { status: "open", updatedAt: CHANGED_AT } : options.item,
    },
    notificationPreference: {
      findUnique: async () => ({
        ...preference,
        ...(options.followUps === undefined ? {} : { followUps: options.followUps }),
        ...(options.followUpDailyCap === undefined
          ? {}
          : { followUpDailyCap: options.followUpDailyCap }),
      }),
    },
    user: { findUnique: async () => ({ timezone: "UTC" }) },
    bot: { findUnique: async () => ({ dailyCheckIns: !options.optedOut }) },
    run: {
      count: async () => options.deliveriesToday ?? runs.length,
      create: async ({ data }: { data: { clientNonce: string } }) => {
        if (runs.some((run) => run.clientNonce === data.clientNonce)) throw { code: "P2002" };
        const run = { id: `run-${runs.length + 1}`, clientNonce: data.clientNonce };
        runs.push(run);
        return { id: run.id };
      },
    },
    task: {
      create: async () => {
        const task = { id: `task-${tasks.length + 1}` };
        tasks.push(task);
        return task;
      },
    },
    routine: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; active?: boolean; nextRunAt?: Date };
        data: { active?: boolean; nextRunAt?: Date | null };
      }) => {
        const matches =
          row.id === where.id &&
          (where.active === undefined || row.active === where.active) &&
          (where.nextRunAt === undefined ||
            row.nextRunAt?.getTime() === where.nextRunAt.getTime());
        if (!matches) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    jobs: {
      enqueue: async (job: { payload: { runId: string } }) => {
        enqueued.push(job.payload.runId);
      },
      cancel: async () => undefined,
      close: async () => undefined,
    },
    events: {
      append: async (event: unknown) => {
        events.push(event);
      },
    },
  } as unknown as Parameters<typeof wakeFollowUp>[0];
  return {
    runs,
    tasks,
    enqueued,
    events,
    info,
    error,
    rearm: () => {
      row.active = true;
      row.nextRunAt = SCHEDULED_AT;
    },
    wake: () =>
      wakeFollowUp(deps, row, {
        scheduledAt: SCHEDULED_AT,
        threadId: "thread-1",
        now: options.now ?? NOW,
      }),
  };
}
