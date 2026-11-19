import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  MessagingCapabilities,
  MessagingMedium,
  MessagingReceipt,
  MessagingReceiptAction,
  MessagingSurface,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { providerOfThreadId } from "./chat-sdk-surface.js";

/**
 * Reaction-only platforms keep their reaction for a late reply: a fast reply
 * is its own acknowledgement.
 */
const REACTION_ONLY_DELAY_MS = 60_000;

/** The reaction-only platforms' existing reaction. */
const LATE_REACTION = "eyes";

/**
 * One acknowledgement per inbound message, chosen by what the person sent.
 * Text gets the typing dots; every other medium gets the reaction that names
 * it. The reply replaces it with the outcome.
 */
const MEDIUM_ACKNOWLEDGEMENT: Record<MessagingMedium, MessagingReceiptAction> = {
  text: { kind: "typing" },
  voice: { kind: "reaction", emoji: "👂" },
  image: { kind: "reaction", emoji: "👀" },
  sticker: { kind: "reaction", emoji: "👀" },
  document: { kind: "reaction", emoji: "📄" },
  location: { kind: "reaction", emoji: "📍" },
  other: { kind: "reaction", emoji: "👍" },
};

const SETTLED = { statement: "✅", question: "🤔" } as const;

const RECEIPT_TIMEOUT_MS = 2_000;

export interface MessagingReceipts {
  acknowledge(
    threadId: string,
    handle: string,
    medium: MessagingMedium,
    handled: () => Promise<boolean>,
  ): void;
  stop(): void;
}

/** A reply that ends in a question mark asks the person a question. */
function replyOutcome(reply: string): keyof typeof SETTLED {
  return /\?\s*$/.test(reply.trim()) ? "question" : "statement";
}

function supportedReceipts(capabilities: MessagingCapabilities | undefined): Set<MessagingReceipt> {
  const receipt = capabilities?.receipt;
  if (!receipt) return new Set();
  return new Set(typeof receipt === "string" ? [receipt] : receipt);
}

/**
 * The acknowledgement the medium wants, degraded to typing when the platform
 * only has typing, or nothing when it has neither.
 */
function acknowledgement(
  receipts: Set<MessagingReceipt>,
  medium: MessagingMedium,
): MessagingReceiptAction | null {
  const chosen = MEDIUM_ACKNOWLEDGEMENT[medium];
  if (chosen.kind === "typing") return receipts.has("typing") ? chosen : null;
  if (receipts.has("reaction")) return chosen;
  return receipts.has("typing") ? { kind: "typing" } : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logFailure(provider: string, error: unknown): void {
  getLogger().error("messaging receipt error", { provider, reason: describeError(error) });
}

/**
 * The reply is out: replace its acknowledgement with the outcome on the same
 * message. Only platforms that show typing and reactions settle this way;
 * reaction-only platforms keep their one delayed reaction.
 */
export async function settleMessageReceipt(
  messaging: Pick<MessagingSurface, "platforms" | "acknowledge">,
  input: { threadId: string; handle: string; reply: string },
  context: AdapterContext,
): Promise<void> {
  const provider = providerOfThreadId(input.threadId);
  const receipts = supportedReceipts(
    messaging.platforms().find((platform) => platform.provider === provider)?.capabilities,
  );
  if (!receipts.has("typing") || !receipts.has("reaction")) return;
  try {
    await messaging.acknowledge(
      input.threadId,
      input.handle,
      { kind: "reaction", emoji: SETTLED[replyOutcome(input.reply)] },
      {
        ...context,
        operationId: `messaging.settle:${randomUUID()}`,
        signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS),
      },
    );
  } catch (error) {
    logFailure(provider, error);
  }
}

export function createMessagingReceipts(
  messaging: Pick<MessagingSurface, "platforms" | "acknowledge">,
): MessagingReceipts {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;

  const send = async (
    threadId: string,
    handle: string,
    action: MessagingReceiptAction,
  ): Promise<void> => {
    const operationId = `messaging.acknowledge:${randomUUID()}`;
    await messaging.acknowledge(threadId, handle, action, {
      operationId,
      traceId: operationId,
      spaceId: "",
      userId: "",
      signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS),
    });
  };

  return {
    acknowledge(threadId, handle, medium, handled) {
      if (stopped) return;
      const provider = providerOfThreadId(threadId);
      const platforms = messaging.platforms().find((platform) => platform.provider === provider);
      const receipts = supportedReceipts(platforms?.capabilities);
      if (receipts.has("reaction") && !receipts.has("typing")) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          (async () => {
            if ((await handled()) || stopped) return;
            await send(threadId, handle, { kind: "reaction", emoji: LATE_REACTION });
          })().catch((error) => logFailure(provider, error));
        }, REACTION_ONLY_DELAY_MS);
        timer.unref?.();
        timers.add(timer);
        return;
      }
      const action = acknowledgement(receipts, medium);
      if (!action) {
        getLogger().info("messaging receipt skipped", {
          provider,
          reason: "platform has no typing or reaction support",
        });
        return;
      }
      send(threadId, handle, action).catch((error) => logFailure(provider, error));
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
