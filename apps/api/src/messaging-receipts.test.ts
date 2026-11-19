import type {
  AdapterContext,
  MessagingPlatformDescriptor,
  MessagingReceiptAction,
} from "@rakazo/adapter-kit";
import { createMessagingReceipts, settleMessageReceipt } from "@rakazo/adapters";
import { getLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SLACK_THREAD = "slack:C1:1700000000.000100";
const SLACK_HANDLE = "1700000000.000100";
const WHATSAPP_THREAD = "whatsapp:15551234567";
const WHATSAPP_HANDLE = "wamid.inbound-1";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "",
  userId: "",
  signal: AbortSignal.timeout(2_000),
};

function fakeMessaging() {
  const platforms: MessagingPlatformDescriptor[] = [
    { provider: "slack", capabilities: { direct: true, groups: true, receipt: "reaction" } },
    { provider: "sendblue", capabilities: { direct: true, groups: true, receipt: "typing" } },
    {
      provider: "whatsapp",
      capabilities: { direct: true, groups: false, receipt: ["typing", "reaction"] },
    },
    { provider: "telegram", capabilities: { direct: true, groups: false, receipt: null } },
  ];
  return {
    platforms: () => platforms,
    acknowledge: vi.fn(
      async (
        _threadId: string,
        _handle: string,
        _action: MessagingReceiptAction,
        _context: AdapterContext,
      ) => undefined,
    ),
  };
}

function actions(messaging: ReturnType<typeof fakeMessaging>) {
  return messaging.acknowledge.mock.calls.map(([, , action]) => action);
}

const unhandled = async () => false;

describe("createMessagingReceipts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shows typing immediately for text", () => {
    const messaging = fakeMessaging();
    createMessagingReceipts(messaging).acknowledge("sendblue:dm-1", "h-1", "text", unhandled);

    expect(actions(messaging)).toEqual([{ kind: "typing" }]);
  });

  it("shows typing for text where reactions are also supported", () => {
    const messaging = fakeMessaging();
    createMessagingReceipts(messaging).acknowledge(
      WHATSAPP_THREAD,
      WHATSAPP_HANDLE,
      "text",
      unhandled,
    );

    expect(actions(messaging)).toEqual([{ kind: "typing" }]);
  });

  it.each([
    ["voice", { kind: "reaction", emoji: "👂" }],
    ["image", { kind: "reaction", emoji: "👀" }],
    ["sticker", { kind: "reaction", emoji: "👀" }],
    ["document", { kind: "reaction", emoji: "📄" }],
    ["location", { kind: "reaction", emoji: "📍" }],
    ["other", { kind: "reaction", emoji: "👍" }],
  ] as const)("reacts %s with its emoji", (medium, receipt) => {
    const messaging = fakeMessaging();
    createMessagingReceipts(messaging).acknowledge(
      WHATSAPP_THREAD,
      WHATSAPP_HANDLE,
      medium,
      unhandled,
    );

    expect(actions(messaging)).toEqual([receipt]);
  });

  it("never gives a voice note the image reaction", () => {
    const messaging = fakeMessaging();
    createMessagingReceipts(messaging).acknowledge(
      WHATSAPP_THREAD,
      WHATSAPP_HANDLE,
      "voice",
      unhandled,
    );

    expect(actions(messaging)).not.toContainEqual({ kind: "reaction", emoji: "👀" });
  });

  it("gives text no reaction before the reply", async () => {
    const messaging = fakeMessaging();
    createMessagingReceipts(messaging).acknowledge(
      WHATSAPP_THREAD,
      WHATSAPP_HANDLE,
      "text",
      unhandled,
    );

    expect(actions(messaging)).not.toContainEqual(expect.objectContaining({ kind: "reaction" }));
  });

  it("supports typing and reaction without a delay on WhatsApp", async () => {
    const messaging = fakeMessaging();
    createMessagingReceipts(messaging).acknowledge(
      WHATSAPP_THREAD,
      WHATSAPP_HANDLE,
      "voice",
      unhandled,
    );

    expect(messaging.acknowledge.mock.calls).toHaveLength(1);
  });

  it("keeps Slack's delayed reaction and its emoji", async () => {
    const messaging = fakeMessaging();
    createMessagingReceipts(messaging).acknowledge(SLACK_THREAD, SLACK_HANDLE, "text", unhandled);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(messaging.acknowledge.mock.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(actions(messaging)).toEqual([{ kind: "reaction", emoji: "eyes" }]);
  });

  it("does not react when the reply already went out", async () => {
    const messaging = fakeMessaging();
    const receipts = createMessagingReceipts(messaging);
    receipts.acknowledge(SLACK_THREAD, SLACK_HANDLE, "text", async () => true);
    receipts.acknowledge("slack:C1:1700000000.000200", "1700000000.000200", "text", unhandled);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      messaging.acknowledge.mock.calls.map(([threadId, handle]) => [threadId, handle]),
    ).toEqual([["slack:C1:1700000000.000200", "1700000000.000200"]]);
  });

  it("keeps delayed reactions on workspace-scoped Slack messages", async () => {
    const messaging = fakeMessaging();
    const threadId = "slack~installation-a:C1:1700000000.000100";
    const handle = "Ta:1700000000.000100";
    createMessagingReceipts(messaging).acknowledge(threadId, handle, "text", unhandled);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messaging.acknowledge).toHaveBeenCalledWith(
      threadId,
      handle,
      { kind: "reaction", emoji: "eyes" },
      expect.anything(),
    );
  });

  it("sends nothing once stopped", async () => {
    const messaging = fakeMessaging();
    const receipts = createMessagingReceipts(messaging);
    receipts.acknowledge(SLACK_THREAD, SLACK_HANDLE, "text", unhandled);
    let releaseCheck = () => {};
    receipts.acknowledge(
      "slack:C1:1700000000.000200",
      "1700000000.000200",
      "text",
      () => new Promise((resolve) => (releaseCheck = () => resolve(false))),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    messaging.acknowledge.mockClear();
    receipts.acknowledge("slack:C1:1700000000.000300", "1700000000.000300", "text", unhandled);
    receipts.stop();
    releaseCheck();
    receipts.acknowledge("sendblue:dm-1", "h-1", "text", unhandled);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(messaging.acknowledge).not.toHaveBeenCalled();
  });

  it("logs a failed receipt with its provider and reason", async () => {
    const error = vi.spyOn(getLogger(), "error");
    const messaging = fakeMessaging();
    messaging.acknowledge.mockRejectedValue(new Error("missing_scope"));
    const receipts = createMessagingReceipts(messaging);
    receipts.acknowledge("sendblue:dm-1", "h-1", "text", unhandled);
    receipts.acknowledge(SLACK_THREAD, SLACK_HANDLE, "text", unhandled);
    receipts.acknowledge("slack:C1:1700000000.000200", "1700000000.000200", "text", async () => {
      throw new Error("database unavailable");
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(error.mock.calls.map(([, bindings]) => bindings)).toEqual([
      { provider: "sendblue", reason: "missing_scope" },
      { provider: "slack", reason: "missing_scope" },
      { provider: "slack", reason: "database unavailable" },
    ]);
  });

  it("falls back to typing when the platform has no reaction", () => {
    const messaging = fakeMessaging();
    createMessagingReceipts(messaging).acknowledge("sendblue:dm-1", "h-1", "voice", unhandled);

    expect(actions(messaging)).toEqual([{ kind: "typing" }]);
  });

  it("stays silent and names why when the platform has neither", () => {
    const info = vi.spyOn(getLogger(), "info");
    const messaging = fakeMessaging();
    createMessagingReceipts(messaging).acknowledge("telegram:42", "7", "voice", unhandled);

    expect(messaging.acknowledge).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("messaging receipt skipped", {
      provider: "telegram",
      reason: "platform has no typing or reaction support",
    });
  });

  it("starts the send timeout when the delayed reaction goes out", async () => {
    // Fake timers leave AbortSignal.timeout on the real clock, so route it
    // through the fake one to make an already-expired signal observable.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const messaging = fakeMessaging();
    createMessagingReceipts(messaging).acknowledge(SLACK_THREAD, SLACK_HANDLE, "text", unhandled);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(messaging.acknowledge.mock.calls[0]![3].signal.aborted).toBe(false);
  });
});

describe("settleMessageReceipt", () => {
  it("sends a check when the reply states the outcome", async () => {
    const messaging = fakeMessaging();
    await settleMessageReceipt(
      messaging,
      { threadId: WHATSAPP_THREAD, handle: WHATSAPP_HANDLE, reply: "Done, it is on your desk." },
      context,
    );

    expect(actions(messaging)).toEqual([{ kind: "reaction", emoji: "✅" }]);
  });

  it("sends thinking when the reply asks a question", async () => {
    const messaging = fakeMessaging();
    await settleMessageReceipt(
      messaging,
      { threadId: WHATSAPP_THREAD, handle: WHATSAPP_HANDLE, reply: "Shall I send it now?" },
      context,
    );

    expect(actions(messaging)).toEqual([{ kind: "reaction", emoji: "🤔" }]);
  });

  it("replaces the acknowledgement on the same message", async () => {
    const messaging = fakeMessaging();
    const receipts = createMessagingReceipts(messaging);
    receipts.acknowledge(WHATSAPP_THREAD, WHATSAPP_HANDLE, "voice", unhandled);
    await settleMessageReceipt(
      messaging,
      { threadId: WHATSAPP_THREAD, handle: WHATSAPP_HANDLE, reply: "Here it is." },
      context,
    );

    expect(
      messaging.acknowledge.mock.calls.map(([threadId, handle]) => [threadId, handle]),
    ).toEqual([
      [WHATSAPP_THREAD, WHATSAPP_HANDLE],
      [WHATSAPP_THREAD, WHATSAPP_HANDLE],
    ]);
    expect(actions(messaging)).toEqual([
      { kind: "reaction", emoji: "👂" },
      { kind: "reaction", emoji: "✅" },
    ]);
  });

  it("leaves Slack's one reaction alone", async () => {
    const messaging = fakeMessaging();
    await settleMessageReceipt(
      messaging,
      { threadId: SLACK_THREAD, handle: SLACK_HANDLE, reply: "Done." },
      context,
    );

    expect(messaging.acknowledge).not.toHaveBeenCalled();
  });

  it("does not settle a platform that only types", async () => {
    const messaging = fakeMessaging();
    await settleMessageReceipt(
      messaging,
      { threadId: "sendblue:dm-1", handle: "h-1", reply: "Done." },
      context,
    );

    expect(messaging.acknowledge).not.toHaveBeenCalled();
  });

  it("logs a failed settle with its provider and reason", async () => {
    const error = vi.spyOn(getLogger(), "error");
    const messaging = fakeMessaging();
    messaging.acknowledge.mockRejectedValue(new Error("rate limited"));
    await settleMessageReceipt(
      messaging,
      { threadId: WHATSAPP_THREAD, handle: WHATSAPP_HANDLE, reply: "Done." },
      context,
    );

    expect(error).toHaveBeenCalledWith("messaging receipt error", {
      provider: "whatsapp",
      reason: "rate limited",
    });
  });
});
