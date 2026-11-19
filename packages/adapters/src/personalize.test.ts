import type {
  AdapterContext,
  MemoryCommitRequest,
  MemoryReadRequest,
  MemoryRevision,
  MemorySnapshot,
  MemoryStore,
  MessagingSurface,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import type { MessagingDeliveryDeps } from "./messaging-delivery.js";
import { deliverMessagingOutbound } from "./messaging-delivery.js";
import type { PersonalizeDeps } from "./personalize.js";
import {
  derivePersonalizeSurfaces,
  derivePersonalizeTier,
  dismissPersonalizeNudge,
  PERSONALIZE_MAX_NUDGES,
  runPersonalizeHeartbeat,
} from "./personalize.js";
import { PERSONALIZE_HEARTBEAT_INSTRUCTION, userTurnInstructions } from "./run-instructions.js";

const SPACE = { id: "space-1" };
const USER = { id: "user-1", timezone: "UTC" };
const NOW = new Date("2026-11-19T12:00:00Z");
const DEFAULT_PREFERENCE = {
  heartbeats: true,
  quietHoursStart: 1320,
  quietHoursEnd: 420,
  followUpDailyCap: 2,
};
const SLACK_IDENTITY = {
  id: "identity-slack",
  provider: "slack",
  address: "U123",
  dmThreadId: "slack:C1:T1",
};
const WHATSAPP_IDENTITY = {
  id: "identity-whatsapp",
  provider: "whatsapp",
  address: "+15550100",
  dmThreadId: "whatsapp:dm-1",
};

function context(spaceId = SPACE.id, userId = USER.id): AdapterContext {
  return {
    operationId: "test",
    traceId: spaceId,
    spaceId,
    userId,
    signal: new AbortController().signal,
  };
}

interface FakeMemory {
  store: MemoryStore;
  docs: Map<string, { path: string; content: string; revision: number }>;
  doc: (path: string) => { path: string; content: string; revision: number } | undefined;
}

function fakeMemory(): FakeMemory {
  const docs = new Map<string, { path: string; content: string; revision: number }>();
  const read = async (
    _request: MemoryReadRequest,
    _context: AdapterContext,
  ): Promise<MemorySnapshot> => ({
    documents: [...docs.values()].map((doc) => ({
      id: doc.path,
      path: doc.path,
      content: doc.content,
      revision: doc.revision,
    })),
  });
  const commit = async (
    request: MemoryCommitRequest,
    _context: AdapterContext,
  ): Promise<MemoryRevision> => {
    const revision = (docs.get(request.path)?.revision ?? 0) + 1;
    const doc = { path: request.path, content: request.content, revision };
    docs.set(request.path, doc);
    return { id: doc.path, path: doc.path, revision, content: doc.content };
  };
  return {
    store: { read, commit } as unknown as MemoryStore,
    docs,
    doc: (path) => docs.get(path),
  };
}

type FakeIdentity = {
  id: string;
  provider: string;
  address: string;
  dmThreadId?: string;
};

type FakePrismaOptions = {
  preference?: {
    heartbeats?: boolean;
    quietHoursStart: number;
    quietHoursEnd: number;
    followUpDailyCap: number;
  } | null;
  routines?: Array<Record<string, unknown>>;
  runs?: Array<{ trigger: string; status: string; createdAt: Date; completedAt: Date | null }>;
  identities?: FakeIdentity[];
  items?: Array<{ id: string }>;
};

type OutboundRow = {
  id: string;
  idempotencyKey: string;
  kind: string;
  identityId: string | null;
  threadId: string | null;
  body: string;
  status: string;
  providerHandle: string | null;
  createdAt: Date;
};

function fakePrisma(options: FakePrismaOptions = {}) {
  const outbound: OutboundRow[] = [];
  const identities = options.identities ?? [];
  const prisma = {
    notificationPreference: { findUnique: async () => options.preference ?? null },
    routine: { findMany: async () => options.routines ?? [] },
    run: {
      findMany: async () =>
        [...(options.runs ?? [])]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, 2),
    },
    messagingIdentity: {
      findMany: async () => identities,
      findUnique: async ({ where }: { where: { id: string } }) => {
        const found = identities.find((identity) => identity.id === where.id);
        if (!found) return null;
        return {
          ...found,
          userId: USER.id,
          spaceId: SPACE.id,
          outboundSinceInbound: 0,
          dmThreadId: found.dmThreadId ?? "provider:dm",
        };
      },
      update: async () => ({}),
    },
    scratchpadItem: { findMany: async () => options.items ?? [] },
    user: { findUnique: async () => ({ deactivatedAt: null }) },
    message: { findUnique: async () => null },
    messagingOutbound: {
      aggregate: async () => ({
        _max: { createdAt: outbound.at(-1)?.createdAt ?? null },
      }),
      createMany: async ({
        data,
      }: {
        data: Array<Partial<OutboundRow> & { idempotencyKey: string }>;
      }) => {
        for (const row of data) {
          if (outbound.some((existing) => existing.idempotencyKey === row.idempotencyKey)) {
            continue;
          }
          outbound.push({
            id: row.idempotencyKey,
            idempotencyKey: row.idempotencyKey,
            kind: row.kind ?? "dm",
            identityId: row.identityId ?? null,
            threadId: row.threadId ?? null,
            body: row.body ?? "",
            status: "pending",
            providerHandle: null,
            createdAt: row.createdAt ?? new Date(),
          });
        }
        return { count: data.length };
      },
      findMany: async ({ where }: { where?: { status?: string } } = {}) =>
        outbound.filter((row) => !where?.status || row.status === where.status),
      findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        // These tests queue one conversation and never leave a blocking row behind.
        if (where && "OR" in where) return null;
        if (where && typeof where.id === "string") {
          return outbound.find((row) => row.id === where.id) ?? null;
        }
        const identityId = where?.identityId;
        return (
          outbound.find(
            (row) =>
              row.status === "pending" &&
              (typeof identityId !== "string" || row.identityId === identityId),
          ) ?? null
        );
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id?: string; status?: string };
        data: Partial<OutboundRow>;
      }) => {
        const matches = outbound.filter(
          (row) =>
            (where.id === undefined || row.id === where.id) &&
            (where.status === undefined || row.status === where.status),
        );
        for (const row of matches) Object.assign(row, data);
        return { count: matches.length };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    $queryRaw: async () => [],
    $executeRaw: async () => 1,
  };
  return { client: prisma as unknown as PrismaClient, outbound };
}

function harness(options: FakePrismaOptions = {}) {
  const memory = fakeMemory();
  const fake = fakePrisma(options);
  const published: Array<{ userId: string; alert: Record<string, unknown> }> = [];
  const enqueued: unknown[] = [];
  const events = {
    publishChatAlert: async (userId: string, alert: Record<string, unknown>) => {
      published.push({ userId, alert });
    },
  };
  const jobs = {
    enqueue: async (job: unknown) => {
      enqueued.push(job);
    },
    cancel: async () => undefined,
    close: async () => undefined,
  };
  const deps = {
    prisma: fake.client,
    memory: memory.store,
    events,
    jobs,
  } as unknown as PersonalizeDeps;
  return { deps, memory, published, enqueued, outbound: fake.outbound, client: fake.client };
}

function deliveryDeps(client: PrismaClient, sent: Array<{ threadId: string; body: string }>) {
  const surface = {
    platforms: () => [],
    sendToThread: async (request: { threadId: string; body: string }) => {
      sent.push(request);
      return { handle: "handle-1" };
    },
  } as unknown as MessagingSurface;
  return {
    prisma: client,
    messaging: surface,
    events: {
      sendUserMessage: async () => ({
        messageId: "message-1",
        seq: 1,
        taskId: null,
        runId: null,
      }),
      notify: async () => undefined,
    },
    jobs: { enqueue: async () => undefined },
    artifacts: { get: async () => new Uint8Array() },
  } as unknown as MessagingDeliveryDeps;
}

describe("adoption tier derivation", () => {
  it("is new below three distinct surfaces and legacy at three", () => {
    expect(derivePersonalizeTier([])).toBe("new");
    expect(derivePersonalizeTier(["routines", "delegation"])).toBe("new");
    expect(derivePersonalizeTier(["routines", "delegation", "messaging"])).toBe("legacy");
    expect(derivePersonalizeTier(["routines", "delegation", "messaging", "saved_list"])).toBe(
      "legacy",
    );
  });

  it("collects the surfaces the person has used from the READ", () => {
    expect(
      derivePersonalizeSurfaces({
        routineCount: 1,
        delegatingRuns: 2,
        messagingIdentities: 0,
        savedListCount: 0,
      }),
    ).toEqual(["routines", "delegation"]);
    expect(
      derivePersonalizeSurfaces({
        routineCount: 0,
        delegatingRuns: 0,
        messagingIdentities: 2,
        savedListCount: 1,
      }),
    ).toEqual(["messaging", "saved_list"]);
    expect(
      derivePersonalizeSurfaces({
        routineCount: 0,
        delegatingRuns: 0,
        messagingIdentities: 0,
        savedListCount: 0,
      }),
    ).toEqual([]);
  });
});

describe("runPersonalizeHeartbeat", () => {
  it("acclimates a brand-new person whose adoption level is empty", async () => {
    const h = harness();
    expect(h.memory.doc("personalize/adoption")).toBeUndefined();
    const result = await runPersonalizeHeartbeat(h.deps, SPACE, USER, NOW, {
      target: { botId: "bot-1", threadId: "thread-1" },
    });
    expect(result.tier).toBe("new");
    expect(result.surfaces).toEqual([]);
    expect(result.silent).toBeNull();
    expect(result.nudges).toHaveLength(1);
    expect(result.nudges[0]).toMatchObject({
      id: "pzn:new:acclimation_new",
      tier: "new",
      category: "acclimation_new",
      dismissable: true,
    });
    expect(result.nudges[0]!.text).toBe(
      "Your GFIN connection is on. Your first funding search is up. Want to run it?",
    );
    const adoption = h.memory.doc("personalize/adoption");
    expect(adoption && JSON.parse(adoption.content)).toMatchObject({ version: 1, tier: "new" });
  });

  it("keeps every nudge a question and within the budget", async () => {
    const brandNew = await runPersonalizeHeartbeat(harness().deps, SPACE, USER, NOW, {
      target: { botId: "bot-1", threadId: "thread-1" },
    });
    const legacy = await runPersonalizeHeartbeat(harness(legacyOptions()).deps, SPACE, USER, NOW);
    const nudges = [...brandNew.nudges, ...legacy.nudges];
    expect(nudges.length).toBeGreaterThan(0);
    expect(legacy.nudges.length).toBeLessThanOrEqual(PERSONALIZE_MAX_NUDGES);
    for (const nudge of nudges) expect(nudge.text.trim().endsWith("?")).toBe(true);
  });

  it("respects the caller's nudge budget", async () => {
    const h = harness(legacyOptions());
    const one = await runPersonalizeHeartbeat(h.deps, SPACE, USER, NOW, { maxNudges: 1 });
    expect(one.nudges).toEqual([expect.objectContaining({ category: "audacity" })]);
  });

  it("offers a legacy person audacity and collaboration, capped at the budget", async () => {
    const h = harness(legacyOptions());
    const result = await runPersonalizeHeartbeat(h.deps, SPACE, USER, NOW);
    expect(result.tier).toBe("legacy");
    expect(result.surfaces).toEqual(["routines", "delegation", "messaging", "saved_list"]);
    expect(result.nudges.map((nudge) => nudge.category)).toEqual(["audacity", "collaboration"]);
    expect(result.nudges[0]!.text).toContain("You haven't asked recently");
    expect(result.nudges[1]!.text).toContain("+15550100");
  });

  it("stays silent inside quiet hours", async () => {
    const h = harness();
    const result = await runPersonalizeHeartbeat(
      h.deps,
      SPACE,
      USER,
      new Date("2026-11-19T23:30:00Z"),
    );
    expect(result.silent).toBe("quiet_hours");
    expect(result.nudges).toEqual([]);
  });

  it("stays silent once the daily cap is reached", async () => {
    const h = harness();
    await h.memory.store.commit(
      {
        scope: "user",
        path: "personalize/delivered",
        content: JSON.stringify({
          version: 1,
          byDay: { "2026-11-19": ["pzn:new:acclimation_new"] },
        }),
      },
      context(),
    );
    const result = await runPersonalizeHeartbeat(h.deps, SPACE, USER, NOW);
    expect(result.silent).toBe("over_cap");
    expect(result.nudges).toEqual([]);
  });

  it("stays silent when the heartbeat toggle is off", async () => {
    const h = harness({
      preference: { ...DEFAULT_PREFERENCE, heartbeats: false },
      identities: [SLACK_IDENTITY],
    });
    const result = await runPersonalizeHeartbeat(h.deps, SPACE, USER, NOW);
    expect(result.silent).toBe("disabled");
    expect(result.nudges).toEqual([]);
    expect(h.outbound).toEqual([]);
  });

  it("records no_channel when the person has no deliverable channel", async () => {
    const h = harness();
    const result = await runPersonalizeHeartbeat(h.deps, SPACE, USER, NOW);
    expect(result.silent).toBe("no_channel");
    expect(result.nudges).toEqual([]);
    expect(h.outbound).toEqual([]);
  });

  it("queues the nudge on the person's connected channel", async () => {
    const h = harness({ preference: DEFAULT_PREFERENCE, identities: [SLACK_IDENTITY] });
    const result = await runPersonalizeHeartbeat(h.deps, SPACE, USER, NOW);
    expect(h.outbound).toHaveLength(1);
    expect(h.outbound[0]).toMatchObject({
      identityId: "identity-slack",
      kind: "dm",
      body: result.nudges[0]!.text,
    });
    expect(h.outbound[0]!.idempotencyKey).toContain("2026-11-19");
    expect(h.enqueued).toHaveLength(1);
  });

  it("sends the queued nudge through the messaging surface for a Slack channel", async () => {
    const h = harness({ preference: DEFAULT_PREFERENCE, identities: [SLACK_IDENTITY] });
    const result = await runPersonalizeHeartbeat(h.deps, SPACE, USER, NOW);
    const sent: Array<{ threadId: string; body: string }> = [];
    await deliverMessagingOutbound(deliveryDeps(h.client, sent), {}, context());
    expect(sent).toEqual([{ threadId: "slack:C1:T1", body: result.nudges[0]!.text }]);
  });

  it("delivers once on a second tick the same day", async () => {
    const h = harness({ preference: DEFAULT_PREFERENCE, identities: [SLACK_IDENTITY] });
    const target = { botId: "bot-1", threadId: "thread-1" };
    const first = await runPersonalizeHeartbeat(h.deps, SPACE, USER, NOW, { target });
    expect(first.nudges).toHaveLength(1);
    const second = await runPersonalizeHeartbeat(h.deps, SPACE, USER, NOW, { target });
    expect(second.nudges).toEqual([]);
    expect(h.outbound).toHaveLength(1);
    expect(h.published).toHaveLength(1);
  });
});

describe("dismissing a nudge", () => {
  it("stores the reason in memory and stops offering the nudge", async () => {
    const h = harness();
    await dismissPersonalizeNudge(h.deps, SPACE, USER, {
      nudgeId: "pzn:new:acclimation_new",
      reason: "Too pushy, not now",
    });
    const dismissals = h.memory.doc("personalize/dismissals");
    expect(dismissals && JSON.parse(dismissals.content)).toEqual({
      version: 1,
      dismissals: [
        {
          nudgeId: "pzn:new:acclimation_new",
          reason: "Too pushy, not now",
          at: expect.any(String),
        },
      ],
    });
    const result = await runPersonalizeHeartbeat(h.deps, SPACE, USER, NOW, {
      target: { botId: "bot-1", threadId: "thread-1" },
    });
    expect(result.nudges).toEqual([]);
  });

  it("requires a non-empty reason", async () => {
    const h = harness();
    await expect(
      dismissPersonalizeNudge(h.deps, SPACE, USER, {
        nudgeId: "pzn:new:acclimation_new",
        reason: "   ",
      }),
    ).rejects.toThrow("A dismissal reason is required");
  });
});

describe("delivering a heartbeat", () => {
  it("publishes the in-app notice and records the delivery for the daily cap", async () => {
    const h = harness({ preference: DEFAULT_PREFERENCE });
    const result = await runPersonalizeHeartbeat(h.deps, SPACE, USER, NOW, {
      target: { botId: "bot-1", threadId: "thread-1" },
    });
    expect(result.nudges).toHaveLength(1);
    expect(h.published).toHaveLength(1);
    expect(h.published[0]).toMatchObject({
      userId: "user-1",
      alert: {
        kind: "help",
        title: result.nudges[0]!.text,
        spaceId: "space-1",
        botId: "bot-1",
        threadId: "thread-1",
      },
    });
    const delivered = h.memory.doc("personalize/delivered");
    expect(delivered && JSON.parse(delivered.content)).toEqual({
      version: 1,
      byDay: { "2026-11-19": ["pzn:new:acclimation_new"] },
    });
  });
});

/** A legacy person: routines, a delegated run, a connected peer, and saved items. */
function legacyOptions(): FakePrismaOptions {
  return {
    preference: DEFAULT_PREFERENCE,
    routines: [{}],
    runs: [
      {
        trigger: "bot_message",
        status: "completed",
        createdAt: new Date("2026-11-01T10:00:00Z"),
        completedAt: new Date("2026-11-01T10:05:00Z"),
      },
    ],
    identities: [WHATSAPP_IDENTITY],
    items: [{ id: "item-1" }, { id: "item-2" }],
  };
}

describe("the heartbeat paragraph in the system prompt", () => {
  it("is appended to the run instructions", () => {
    const instructions = userTurnInstructions({
      botInstructions: "",
      groupContext: undefined,
      messagingContext: undefined,
      redactedMemoryContext: undefined,
      redactedScratchpadContext: undefined,
      hasHistoricalContext: false,
      computerInstruction: "",
      pageBrowserAllowed: false,
      workspaceInstruction: "",
      agentEnvironmentInstruction: undefined,
      botDirectory: undefined,
      pluginLine: undefined,
      agentSkillsLine: undefined,
      taughtSkillsLine: undefined,
      replyGuidance: "",
    });
    expect(instructions).toContain(PERSONALIZE_HEARTBEAT_INSTRUCTION);
    expect(PERSONALIZE_HEARTBEAT_INSTRUCTION).toContain("PersonalizeME");
    expect(PERSONALIZE_HEARTBEAT_INSTRUCTION).toContain("acclimation");
  });
});
