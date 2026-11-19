import type { AdapterContext } from "@rakazo/adapter-kit";
import { messagingDeliverJob } from "@rakazo/adapter-kit";
import type { ChatAlert } from "@rakazo/contracts";
import { wallClock } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import type { ExecutorDeps } from "./executor-deps.js";
import { DEFAULT_FOLLOW_UP_PREFERENCE, inQuietHours, minuteOfLocalDay } from "./follow-up.js";
import { insertOutboundRows } from "./messaging-delivery.js";

/** What a heartbeat returns: the tier it judged, the nudges it delivered, and why it stayed silent. */
export type PersonalizeHeartbeatSilent = "quiet_hours" | "over_cap" | "disabled" | "no_channel";

/** The audience branch: new people are acclimating, legacy people have used 3+ surfaces. */
export type PersonalizeNudgeTier = "new" | "legacy";

export type PersonalizeNudgeCategory =
  | "acclimation_new"
  | "audacity"
  | "collaboration"
  | "opportunistic";

/**
 * The capability surfaces a person has used, counted for the adoption tier: 3 or more are
 * legacy. What counts as used is the engine's READ: routine rows, runs that delegated work
 * to a bot or agent, connected messaging identities, and open scratchpad items.
 */
export type PersonalizeSurface = "routines" | "delegation" | "messaging" | "saved_list";

export interface PersonalizeNudge {
  /** `pzn:<tier>:<category>`; stable so a dismissal of the same nudge stays stopped. */
  id: string;
  tier: PersonalizeNudgeTier;
  category: PersonalizeNudgeCategory;
  /** A question the user can answer; the engine never acts on it. */
  text: string;
  dismissable: true;
}

export interface PersonalizeHeartbeatResult {
  tier: PersonalizeNudgeTier;
  surfaces: PersonalizeSurface[];
  nudges: PersonalizeNudge[];
  silent: PersonalizeHeartbeatSilent | null;
}

/** The PersonalizeME heartbeat's default budget: at most 2 nudges per tick. */
export const PERSONALIZE_MAX_NUDGES = 2;

export interface PersonalizeHeartbeatOptions {
  /** How many nudges the tick may deliver; defaults to PERSONALIZE_MAX_NUDGES. */
  maxNudges?: number;
  /** Where the nudge notices go, when the run provides one. */
  target?: { botId: string; threadId: string };
}

export type PersonalizeDeps = Pick<ExecutorDeps, "prisma" | "memory" | "events" | "jobs">;

/** The heartbeat policy: the follow-up preferences plus its own toggle, sharing one daily cap. */
export const DEFAULT_PERSONALIZE_PREFERENCE = {
  ...DEFAULT_FOLLOW_UP_PREFERENCE,
  heartbeats: true,
};

export type PersonalizeReceipt = {
  trigger: string;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
};

export type PersonalizePeer = {
  provider: string;
  address: string;
};

const ADOPTION_PATH = "personalize/adoption";
const DISMISSALS_PATH = "personalize/dismissals";
const DELIVERED_PATH = "personalize/delivered";

/** Triggers that mean the user delegated work to a bot or an agent. */
const DELEGATION_TRIGGERS = new Set(["routine", "bot_message", "spawn", "follow_up"]);

const AdoptionSchema = z.object({
  version: z.literal(1),
  tier: z.enum(["new", "legacy"]),
  at: z.string().datetime(),
});

const DismissalSchema = z.object({
  nudgeId: z.string().min(1),
  reason: z.string().min(1),
  at: z.string().datetime(),
});

const DismissalsSchema = z.object({
  version: z.literal(1),
  dismissals: z.array(DismissalSchema),
});

const DeliveredSchema = z.object({
  version: z.literal(1),
  byDay: z.record(z.string(), z.array(z.string())),
});

function docContent(documents: readonly { path: string; content: string }[], path: string) {
  return documents.find((doc) => doc.path === path)?.content ?? null;
}

function parseJson<T>(content: string | null, schema: z.ZodType<T>): T | null {
  if (content === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** 3 or more distinct surfaces used, and the person is legacy; below that they are new. */
export function derivePersonalizeTier(
  surfaces: readonly PersonalizeSurface[],
): PersonalizeNudgeTier {
  return surfaces.length >= 3 ? "legacy" : "new";
}

/** The distinct capability surfaces the engine's READ found the person has used. */
export function derivePersonalizeSurfaces(input: {
  routineCount: number;
  delegatingRuns: number;
  messagingIdentities: number;
  savedListCount: number;
}): PersonalizeSurface[] {
  const surfaces = new Set<PersonalizeSurface>();
  if (input.routineCount > 0) surfaces.add("routines");
  if (input.delegatingRuns > 0) surfaces.add("delegation");
  if (input.messagingIdentities > 0) surfaces.add("messaging");
  if (input.savedListCount > 0) surfaces.add("saved_list");
  return [...surfaces];
}

function acclamationNewText(input: {
  receipts: PersonalizeReceipt[];
  routineCount: number;
}): string {
  if (input.receipts.length > 0) {
    const count = input.receipts.length;
    return `You have ${count} recent action${count === 1 ? "" : "s"}. Want to run another funding search?`;
  }
  if (input.routineCount > 0) return "You have a routine on file. Want me to run it now?";
  return "Your GFIN connection is on. Your first funding search is up. Want to run it?";
}

function audacityText(input: {
  receipts: PersonalizeReceipt[];
  routineCount: number;
  now: Date;
}): string {
  const last = input.receipts[0];
  if (!last) {
    return input.routineCount > 0
      ? "Your routine hasn't run lately. Want me to run it now?"
      : "You haven't started with a funding search. Want to run one?";
  }
  const completed = last.completedAt ?? last.createdAt;
  const daysAgo = Math.max(0, Math.round((input.now.getTime() - completed.getTime()) / 86_400_000));
  return `You haven't asked recently. Your last activity was ${daysAgo} day${daysAgo === 1 ? "" : "s"} ago. Want to run another funding search?`;
}

function collaborationText(input: { peers: PersonalizePeer[] }): string {
  const [peer] = input.peers;
  const who = peer ? peer.address || peer.provider : "a peer";
  return `You've connected with ${who}. Want me to ask about what came up?`;
}

function opportunisticText(input: { savedCount: number }): string {
  if (input.savedCount > 0) {
    return `You have ${input.savedCount} item${input.savedCount === 1 ? "" : "s"} on your saved list. Want me to review the top one?`;
  }
  return "A saved opportunity looks time-sensitive. Want me to review it?";
}

function buildNudges(input: {
  tier: PersonalizeNudgeTier;
  receipts: PersonalizeReceipt[];
  routineCount: number;
  peers: PersonalizePeer[];
  savedCount: number;
  dismissed: ReadonlySet<string>;
  delivered: ReadonlySet<string>;
  maxNudges: number;
  now: Date;
}): PersonalizeNudge[] {
  const nudges: PersonalizeNudge[] = [];
  const offer = (category: PersonalizeNudgeCategory, text: string) => {
    const id = `pzn:${input.tier}:${category}`;
    if (!input.dismissed.has(id) && !input.delivered.has(id)) {
      nudges.push({ id, tier: input.tier, category, text, dismissable: true });
    }
  };
  if (input.tier === "new") {
    offer("acclimation_new", acclamationNewText(input));
    if (input.savedCount > 0) {
      offer("opportunistic", opportunisticText({ savedCount: input.savedCount }));
    }
  } else {
    offer("audacity", audacityText(input));
    if (input.peers.length > 0) offer("collaboration", collaborationText({ peers: input.peers }));
    if (input.savedCount > 0) {
      offer("opportunistic", opportunisticText({ savedCount: input.savedCount }));
    }
  }
  return nudges.slice(0, Math.max(0, input.maxNudges));
}

function heartbeatContext(spaceId: string, userId: string): AdapterContext {
  return {
    operationId: "personalize-heartbeat",
    traceId: spaceId,
    spaceId,
    userId,
    signal: new AbortController().signal,
  };
}

async function deliverHeartbeatNudges(
  deps: PersonalizeDeps,
  input: {
    spaceId: string;
    userId: string;
    nudges: PersonalizeNudge[];
    target?: { botId: string; threadId: string };
  },
): Promise<void> {
  if (!input.target) return;
  for (const nudge of input.nudges) {
    try {
      const alert: ChatAlert = {
        kind: "help",
        title: nudge.text,
        body: `PersonalizeME - ${nudge.category}`,
        spaceId: input.spaceId,
        botId: input.target.botId,
        threadId: input.target.threadId,
      };
      await deps.events.publishChatAlert?.(input.userId, alert);
    } catch (error) {
      getLogger().error("personalize.deliver", error);
    }
  }
}

/**
 * Queues one DM per nudge on the person's connected channel. The row goes through the same
 * outbox every channel drains, so the provider is the identity's, never a branch here; the
 * day and nudge in the key make a second tick the same day a no-op.
 */
async function queueMessagingNudges(
  deps: PersonalizeDeps,
  input: {
    spaceId: string;
    userId: string;
    dayKey: string;
    identityId: string;
    nudges: PersonalizeNudge[];
  },
): Promise<void> {
  await insertOutboundRows(
    deps.prisma,
    { identityId: input.identityId },
    input.nudges.map((nudge) => ({
      idempotencyKey: `personalize:${input.spaceId}:${input.userId}:${input.dayKey}:${nudge.id}`,
      kind: "dm",
      identityId: input.identityId,
      body: nudge.text,
    })),
  );
  await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
    // The row is durable; job reconciliation repairs a missed drain wake.
    getLogger().error("personalize.deliver_enqueue", error);
  });
}

async function recordDeliveries(
  deps: PersonalizeDeps,
  context: AdapterContext,
  input: { dayKey: string; ids: string[] },
): Promise<void> {
  const memory = await deps.memory.read({ scope: "user" }, context);
  const delivered = parseJson(docContent(memory.documents, DELIVERED_PATH), DeliveredSchema) ?? {
    version: 1 as const,
    byDay: {},
  };
  const byDay = { ...delivered.byDay };
  byDay[input.dayKey] = [...new Set([...(byDay[input.dayKey] ?? []), ...input.ids])];
  await deps.memory.commit(
    { scope: "user", path: DELIVERED_PATH, content: JSON.stringify({ version: 1, byDay }) },
    context,
  );
}

/**
 * The PersonalizeME heartbeat: READ the person's routine status, receipts and adoption
 * level, then DELIVER up to `maxNudges` question nudges, never actions. Quiet hours and
 * the daily cap come from the same preference the follow-up machinery uses.
 */
export async function runPersonalizeHeartbeat(
  deps: PersonalizeDeps,
  space: { id: string },
  user: { id: string; timezone: string | null },
  date: Date,
  options: PersonalizeHeartbeatOptions = {},
): Promise<PersonalizeHeartbeatResult> {
  const now = date;
  const timezone = user.timezone ?? "UTC";
  const context = heartbeatContext(space.id, user.id);

  const memory = await deps.memory.read({ scope: "user" }, context);
  const [preference, routines, runs, identities, items] = await Promise.all([
    deps.prisma.notificationPreference.findUnique({
      where: { spaceId_userId: { spaceId: space.id, userId: user.id } },
      select: {
        heartbeats: true,
        quietHoursStart: true,
        quietHoursEnd: true,
        followUpDailyCap: true,
      },
    }),
    deps.prisma.routine.findMany({ where: { spaceId: space.id, userId: user.id } }),
    deps.prisma.run.findMany({
      where: { spaceId: space.id, userId: user.id },
      orderBy: [{ createdAt: "desc" }],
      take: 2,
      select: { trigger: true, status: true, createdAt: true, completedAt: true },
    }),
    deps.prisma.messagingIdentity.findMany({
      where: { spaceId: space.id, userId: user.id },
      orderBy: [{ createdAt: "desc" }],
      select: { id: true, provider: true, address: true },
    }),
    deps.prisma.scratchpadItem.findMany({
      where: { spaceId: space.id, userId: user.id, status: { in: ["open", "parked"] } },
      select: { id: true },
    }),
  ]);
  const policy = preference ?? DEFAULT_PERSONALIZE_PREFERENCE;

  const surfaces = derivePersonalizeSurfaces({
    routineCount: routines.length,
    delegatingRuns: runs.filter((run) => DELEGATION_TRIGGERS.has(run.trigger)).length,
    messagingIdentities: identities.length,
    savedListCount: items.length,
  });
  const tier = derivePersonalizeTier(surfaces);
  const adoption = parseJson(docContent(memory.documents, ADOPTION_PATH), AdoptionSchema);
  if (!adoption || adoption.tier !== tier) {
    await deps.memory.commit(
      {
        scope: "user",
        path: ADOPTION_PATH,
        content: JSON.stringify({ version: 1, tier, at: now.toISOString() }),
      },
      context,
    );
  }

  const silence = (reason: PersonalizeHeartbeatSilent): PersonalizeHeartbeatResult => {
    getLogger().info("personalize.silent", {
      "personalize.reason": reason,
      "space.id": space.id,
      "user.id": user.id,
    });
    return { tier, surfaces, nudges: [], silent: reason };
  };

  if (!policy.heartbeats) return silence("disabled");
  if (inQuietHours(minuteOfLocalDay(now, timezone), policy.quietHoursStart, policy.quietHoursEnd)) {
    return silence("quiet_hours");
  }

  const dayKey = wallClock(now, timezone).slice(0, 10);
  const deliveredToday = parseJson(docContent(memory.documents, DELIVERED_PATH), DeliveredSchema);
  const deliveredTodayIds = new Set(deliveredToday?.byDay[dayKey] ?? []);
  const remainingToday = policy.followUpDailyCap - deliveredTodayIds.size;
  if (remainingToday <= 0) return silence("over_cap");

  // The person's newest connected channel is the target; the routine's thread is the web chat.
  const channel = identities[0] ?? null;
  if (!channel && !options.target) return silence("no_channel");

  const dismissed = new Set(
    (
      parseJson(docContent(memory.documents, DISMISSALS_PATH), DismissalsSchema)?.dismissals ?? []
    ).map((dismissal) => dismissal.nudgeId),
  );
  const nudges = buildNudges({
    tier,
    receipts: runs,
    routineCount: routines.length,
    peers: identities,
    savedCount: items.length,
    dismissed,
    delivered: deliveredTodayIds,
    maxNudges: Math.min(options.maxNudges ?? PERSONALIZE_MAX_NUDGES, remainingToday),
    now,
  });
  if (nudges.length > 0) {
    if (channel) {
      await queueMessagingNudges(deps, {
        spaceId: space.id,
        userId: user.id,
        dayKey,
        identityId: channel.id,
        nudges,
      });
    }
    await deliverHeartbeatNudges(deps, {
      spaceId: space.id,
      userId: user.id,
      nudges,
      target: options.target,
    });
    await recordDeliveries(deps, context, {
      dayKey,
      ids: nudges.map((nudge) => nudge.id),
    });
  }
  return { tier, surfaces, nudges, silent: null };
}

/** Store a nudge dismissal with its reason; the reason never leaves memory. */
export async function dismissPersonalizeNudge(
  deps: PersonalizeDeps,
  space: { id: string },
  user: { id: string },
  input: { nudgeId: string; reason: string },
): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) throw new Error("A dismissal reason is required for a PersonalizeME nudge.");
  const context = heartbeatContext(space.id, user.id);
  const memory = await deps.memory.read({ scope: "user" }, context);
  const current = parseJson(docContent(memory.documents, DISMISSALS_PATH), DismissalsSchema) ?? {
    version: 1 as const,
    dismissals: [],
  };
  const dismissals = current.dismissals.some((dismissal) => dismissal.nudgeId === input.nudgeId)
    ? current.dismissals
    : [...current.dismissals, { nudgeId: input.nudgeId, reason, at: new Date().toISOString() }];
  await deps.memory.commit(
    { scope: "user", path: DISMISSALS_PATH, content: JSON.stringify({ version: 1, dismissals }) },
    context,
  );
}
