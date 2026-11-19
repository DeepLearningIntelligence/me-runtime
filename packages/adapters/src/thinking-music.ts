import type { AdapterContext, MessagingSurface } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";

/**
 * Hold music while a run thinks: a long think gets the typing dots, and once
 * per run a status line says the bot is still there. The surface is the one
 * messaging layer that can show either, so nothing here knows a provider.
 */

/** How long a run may think before the person hears anything about it. */
export const THINKING_HOLD_MUSIC_THRESHOLD_MS = 6_000;

/**
 * The one status message a long think posts. A hyphen, not a dash, per the
 * house copy rule; the emoji carries the "hold music" idea.
 */
export const THINKING_HOLD_MUSIC_STATUS = "🎵 Thinking - hold music on";

/**
 * No hold clip ships with this deployment, so the emission says `music: false`.
 * A clip would be this constant's value; the status line is the whole feature
 * until one lands.
 */
export const HOLD_MUSIC_CLIP: string | null = null;

/** Whether an elapsed think has crossed the hold-music threshold. */
export function shouldEmitThinkingMusic(
  elapsedMs: number,
  thresholdMs: number = THINKING_HOLD_MUSIC_THRESHOLD_MS,
): boolean {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(thresholdMs)) return false;
  return elapsedMs > thresholdMs;
}

/** Where the receipt and status land: the platform thread and its message handle. */
export interface ThinkingMusicTarget {
  threadId: string;
  handle: string;
}

export interface ThinkingMusicDeps {
  /** The messaging layer: typing receipts and one posted status line. */
  messaging: Pick<MessagingSurface, "acknowledge" | "sendToThread">;
  /** The run's platform thread and inbound handle; absent skips the feature. */
  target: ThinkingMusicTarget | null;
  context: AdapterContext;
  thresholdMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface ThinkingMusicEmission {
  /** The typing dots were asked for on this call. */
  typing: boolean;
  /** Set only on the call that posted the once-per-run status line. */
  status: string | null;
  /** Whether an actual clip played; false while no hold clip ships. */
  music: boolean;
}

/** Runs whose status line has already been posted, with the time it was claimed. */
const announcedRuns = new Map<string, number>();
const ANNOUNCED_TTL_MS = 6 * 60 * 60_000;

function pruneAnnouncements(now: number): void {
  for (const [runId, at] of announcedRuns) {
    if (now - at > ANNOUNCED_TTL_MS) announcedRuns.delete(runId);
  }
}

/** Claim the one status line for a run; false when another call already did. */
function claimStatusLine(runId: string, now: number): boolean {
  pruneAnnouncements(now);
  if (announcedRuns.has(runId)) return false;
  announcedRuns.set(runId, now);
  return true;
}

/** Release a claim whose send failed, so a later crossing can try again. */
function releaseStatusLine(runId: string): void {
  announcedRuns.delete(runId);
}

/** Forget a finished run so a reused id (tests, replays) starts clean. */
export function forgetThinkingMusic(runId: string): void {
  announcedRuns.delete(runId);
}

/** Test hook: drop every claimed run. */
export function resetThinkingMusic(): void {
  announcedRuns.clear();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * After `elapsedMs` of thinking, ask for the typing dots and, once per run,
 * post the hold-music status line. Returns null when the think is short or the
 * run has no messaging thread. Failures are logged, never thrown: a receipt is
 * best effort and must not stop the run.
 */
export async function maybeEmitThinkingMusic(
  runId: string,
  elapsedMs: number,
  deps: ThinkingMusicDeps,
): Promise<ThinkingMusicEmission | null> {
  if (!deps.target) return null;
  if (!shouldEmitThinkingMusic(elapsedMs, deps.thresholdMs)) return null;
  const { threadId, handle } = deps.target;
  const now = deps.now ?? Date.now;

  try {
    await deps.messaging.acknowledge(threadId, handle, { kind: "typing" }, deps.context);
  } catch (error) {
    getLogger().error("thinking music typing receipt failed", {
      runId,
      reason: describeError(error),
    });
  }

  if (!claimStatusLine(runId, now())) {
    return { typing: true, status: null, music: HOLD_MUSIC_CLIP !== null };
  }
  try {
    await deps.messaging.sendToThread(
      { threadId, body: THINKING_HOLD_MUSIC_STATUS, idempotencyKey: `thinking-music:${runId}` },
      deps.context,
    );
  } catch (error) {
    releaseStatusLine(runId);
    getLogger().error("thinking music status failed", { runId, reason: describeError(error) });
    return { typing: true, status: null, music: HOLD_MUSIC_CLIP !== null };
  }
  if (!HOLD_MUSIC_CLIP) {
    getLogger().info("thinking music status without a clip", { runId });
  }
  return { typing: true, status: THINKING_HOLD_MUSIC_STATUS, music: HOLD_MUSIC_CLIP !== null };
}
