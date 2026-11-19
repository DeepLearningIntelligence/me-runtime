import type { MemoryStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import {
  ensurePersonalizeHeartbeatRoutine,
  isPersonalizeHeartbeatRoutine,
  PERSONALIZE_HEARTBEAT_CRON,
  PERSONALIZE_HEARTBEAT_MARKER,
  wakePersonalizeHeartbeat,
} from "./personalize-routine.js";

function memoryStore(): MemoryStore {
  const docs = new Map<string, string>();
  return {
    read: async () => ({
      documents: [...docs.entries()].map(([path, content]) => ({
        id: path,
        path,
        content,
        revision: 1,
      })),
    }),
    commit: async (request: { path: string; content: string }) => {
      docs.set(request.path, request.content);
      return { id: request.path, path: request.path, revision: 1, content: request.content };
    },
  } as unknown as MemoryStore;
}

type Identity = { id: string; provider: string; address: string };
type RoutineRow = { id: string; nextRunAt: Date | null; active: boolean; lastRunAt: Date | null };

function routineHarness(
  options: { identities?: Identity[]; timezone?: string | null; routineRow?: RoutineRow } = {},
) {
  const identities = options.identities ?? [];
  const routineRow: RoutineRow = options.routineRow ?? {
    id: "routine-1",
    nextRunAt: null,
    active: true,
    lastRunAt: null,
  };
  const created: Array<Record<string, unknown>> = [];
  const enqueued: Array<{ name: string; payload: unknown }> = [];
  const outbound: Array<{ idempotencyKey: string; body: string }> = [];
  let existing: { id: string; nextRunAt: Date | null } | null = null;

  const prisma = {
    user: {
      findUnique: async () => ({ id: "user-1", timezone: options.timezone ?? "UTC" }),
    },
    notificationPreference: { findUnique: async () => null },
    messagingIdentity: {
      findMany: async () => identities,
      findFirst: async () => (identities[0] ? { botId: "bot-1" } : null),
      findUnique: async ({ where }: { where: { id: string } }) => {
        const found = identities.find((identity) => identity.id === where.id);
        return found
          ? {
              ...found,
              userId: "user-1",
              spaceId: "space-1",
              dmThreadId: `${found.provider}:dm`,
              outboundSinceInbound: 0,
            }
          : null;
      },
      update: async () => ({}),
    },
    bot: {
      findFirst: async () =>
        identities.length ? { id: "bot-1", thread: { id: "thread-1" } } : null,
    },
    routine: {
      findMany: async () => [],
      findFirst: async () => existing,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        existing = {
          id: "routine-1",
          nextRunAt: (data.nextRunAt as Date | null | undefined) ?? null,
        };
        return { id: "routine-1" };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; active?: boolean; nextRunAt?: Date | null };
        data: Partial<RoutineRow>;
      }) => {
        const matchesNextRun =
          where.nextRunAt === undefined ||
          (where.nextRunAt === null
            ? routineRow.nextRunAt === null
            : routineRow.nextRunAt?.getTime() === where.nextRunAt.getTime());
        const matches =
          routineRow.id === where.id &&
          (where.active === undefined || routineRow.active === where.active) &&
          matchesNextRun;
        if (!matches) return { count: 0 };
        Object.assign(routineRow, data);
        return { count: 1 };
      },
    },
    scratchpadItem: { findMany: async () => [] },
    run: { findMany: async () => [] },
    messagingOutbound: {
      aggregate: async () => ({ _max: { createdAt: null } }),
      createMany: async ({ data }: { data: Array<{ idempotencyKey: string; body: string }> }) => {
        for (const row of data) {
          if (!outbound.some((current) => current.idempotencyKey === row.idempotencyKey)) {
            outbound.push(row);
          }
        }
        return { count: data.length };
      },
      findMany: async () => [],
      findFirst: async () => null,
      updateMany: async () => ({ count: 0 }),
    },
    space: { findUnique: async () => ({ deletingAt: null }) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    $queryRaw: async () => [],
    $executeRaw: async () => 1,
  };

  const jobs = {
    enqueue: async (job: { name: string; payload: unknown }) => {
      enqueued.push(job);
    },
    cancel: async () => undefined,
    close: async () => undefined,
  };
  const events = { publishChatAlert: async () => undefined };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    jobs,
    events,
    memory: memoryStore(),
  } as unknown as Parameters<typeof wakePersonalizeHeartbeat>[0];

  return {
    deps,
    ensureDeps: { prisma: prisma as unknown as PrismaClient, jobs },
    created,
    enqueued,
    outbound,
    routineRow,
  };
}

/** Two channels for one person: WhatsApp and Slack. */
const TWO_CHANNELS: Identity[] = [
  { id: "identity-whatsapp", provider: "whatsapp", address: "+15550100" },
  { id: "identity-slack", provider: "slack", address: "U123" },
];

describe("the PersonalizeME heartbeat routine", () => {
  it("marks only the heartbeat marker, never another routine", () => {
    expect(isPersonalizeHeartbeatRoutine(PERSONALIZE_HEARTBEAT_MARKER)).toBe(true);
    expect(isPersonalizeHeartbeatRoutine({ version: 1, kind: "follow-up" })).toBe(false);
    expect(isPersonalizeHeartbeatRoutine({})).toBe(false);
    expect(isPersonalizeHeartbeatRoutine(null)).toBe(false);
  });

  it("keeps one daily schedule per person, not one per channel", async () => {
    const h = routineHarness({ identities: TWO_CHANNELS });
    const first = await ensurePersonalizeHeartbeatRoutine(h.ensureDeps, {
      spaceId: "space-1",
      userId: "user-1",
    });
    const second = await ensurePersonalizeHeartbeatRoutine(h.ensureDeps, {
      spaceId: "space-1",
      userId: "user-1",
    });

    expect(first).toEqual({ id: "routine-1", created: true });
    expect(second).toEqual({ id: "routine-1", created: false });
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      name: "PersonalizeME",
      active: true,
      notify: false,
      crons: [PERSONALIZE_HEARTBEAT_CRON],
      timezone: "UTC",
      botId: "bot-1",
      threadId: "thread-1",
      personalize: PERSONALIZE_HEARTBEAT_MARKER,
    });
    expect(h.enqueued.filter((job) => job.name === "routine.wakeup")).toHaveLength(1);
  });

  it("schedules the tick in the person's own zone", async () => {
    const h = routineHarness({ identities: TWO_CHANNELS, timezone: "Pacific/Auckland" });
    await ensurePersonalizeHeartbeatRoutine(h.ensureDeps, {
      spaceId: "space-1",
      userId: "user-1",
    });
    expect(h.created[0]).toMatchObject({ timezone: "Pacific/Auckland" });
    const nextRunAt = h.created[0]!.nextRunAt as Date;
    // 09:00 in Auckland (UTC+13 in November) is 20:00 UTC the evening before.
    expect(nextRunAt.getUTCHours()).toBe(20);
    expect(nextRunAt.getUTCMinutes()).toBe(0);
  });

  it("wakes the engine once, advances the schedule, and queues the next tick", async () => {
    const scheduledAt = new Date("2026-11-19T09:00:00Z");
    const h = routineHarness({
      identities: TWO_CHANNELS,
      routineRow: {
        id: "routine-1",
        nextRunAt: scheduledAt,
        active: true,
        lastRunAt: null,
      },
    });
    await wakePersonalizeHeartbeat(
      h.deps,
      {
        id: "routine-1",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        timezone: "UTC",
        crons: [PERSONALIZE_HEARTBEAT_CRON],
      },
      { scheduledAt, botThreadId: "thread-1" },
    );

    expect(h.outbound).toHaveLength(1);
    const nextRunAt = h.routineRow.nextRunAt;
    expect(nextRunAt && nextRunAt.getTime() > scheduledAt.getTime()).toBe(true);
    expect(nextRunAt?.getUTCHours()).toBe(9);
    expect(h.routineRow.lastRunAt).not.toBeNull();
    expect(h.enqueued.filter((job) => job.name === "routine.wakeup")).toHaveLength(1);
    expect(h.enqueued.filter((job) => job.name === "messaging.deliver")).toHaveLength(1);
  });
});
