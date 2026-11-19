import { describe, expect, it } from "vitest";
import { threadSendInput } from "./rpc.js";

describe("threads.send input bounds", () => {
  it("accepts chat text within the length bound", () => {
    const parsed = threadSendInput.safeParse({ botId: "bot-1", text: "a".repeat(100_000) });
    expect(parsed.success).toBe(true);
  });

  it("rejects chat text past the length bound", () => {
    const parsed = threadSendInput.safeParse({ botId: "bot-1", text: "a".repeat(100_001) });
    expect(parsed.success).toBe(false);
  });

  it("accepts a send carrying only dropped links", () => {
    const parsed = threadSendInput.safeParse({
      botId: "bot-1",
      attachedLinks: ["https://example.test/a", "a line of dropped text"],
    });
    expect(parsed.success).toBe(true);
  });

  it("still requires text, an attachment, or a link", () => {
    expect(threadSendInput.safeParse({ botId: "bot-1" }).success).toBe(false);
    expect(threadSendInput.safeParse({ botId: "bot-1", attachedLinks: [] }).success).toBe(false);
  });
});
