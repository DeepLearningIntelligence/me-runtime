import type { ThreadEvents } from "@rakazo/db";

/**
 * AI guardrails (Packet D, QW-2): the per-(Space, day) canary call budget.
 *
 * One authority: the budget key and the count live here. Each canary call spends one
 * unit of its Space's day; when the cap is spent, the call is refused by name and the
 * refusal is recorded as an `ai.canary.exceeded` event, so a runaway loop is loud in
 * history instead of quietly starving everything else that Space runs.
 */

/** The canary calls one Space may make in a UTC day. */
export const AI_CANARY_BUDGET_PER_DAY = 1000;

/** The event a refused canary call records. */
export const AI_CANARY_EXCEEDED_EVENT = "ai.canary.exceeded" as const;

/** The refusal key a spent budget names in the message. */
export const AI_CANARY_REFUSAL = "ai.canary.exceeded";

/** Counts keyed by `<spaceId>:<day>`; a new day starts a fresh key, so no reset job is owed. */
const canaryCounts = new Map<string, { day: string; count: number }>();

/** The UTC day a call belongs to, so the budget resets at midnight UTC. */
export function canaryDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function canaryBudgetKey(spaceId: string, day: string): string {
  return `${spaceId}:${day}`;
}

/** Canary calls this Space has used today (UTC). */
export function canaryUsed(spaceId: string, now: Date = new Date()): number {
  return canaryCounts.get(canaryBudgetKey(spaceId, canaryDayKey(now)))?.count ?? 0;
}

/** Test and restart seam: forget every count. */
export function resetCanaryBudget(): void {
  canaryCounts.clear();
}

export interface CanaryGuardDeps {
  /** The event layer the refusal is recorded through. */
  events: Pick<ThreadEvents, "append">;
}

export interface CanaryCall {
  spaceId: string;
  threadId: string;
  botId: string;
  runId?: string;
  /** The tool or step this call names; the refusal quotes it. */
  name: string;
}

export interface CanaryGuardOptions {
  /** Overrides the deployment default; tests and per-deployment limits use it. */
  perDay?: number;
  now?: Date;
}

/**
 * Consumes one canary call for the Space's day. Returns undefined when the call may
 * proceed; when the cap is already spent, records `ai.canary.exceeded` and returns the
 * named refusal. Callers must stop the named call: a refusal is never a silent degrade.
 */
export async function guardCanaryCall(
  deps: CanaryGuardDeps,
  call: CanaryCall,
  options: CanaryGuardOptions = {},
): Promise<string | undefined> {
  const budget = options.perDay ?? AI_CANARY_BUDGET_PER_DAY;
  if (!Number.isInteger(budget) || budget < 0)
    throw new Error("The AI canary budget must be a non-negative integer");
  const now = options.now ?? new Date();
  const day = canaryDayKey(now);
  const key = canaryBudgetKey(call.spaceId, day);
  const used = canaryCounts.get(key)?.count ?? 0;
  if (used >= budget) {
    await deps.events.append({
      spaceId: call.spaceId,
      threadId: call.threadId,
      botId: call.botId,
      ...(call.runId === undefined ? {} : { runId: call.runId }),
      type: AI_CANARY_EXCEEDED_EVENT,
      payload: { name: call.name, spaceId: call.spaceId, day, used, budget },
    });
    return `Canary call "${call.name}" refused: this Space's AI canary budget is spent for today (${AI_CANARY_REFUSAL}).`;
  }
  canaryCounts.set(key, { day, count: used + 1 });
  return undefined;
}
