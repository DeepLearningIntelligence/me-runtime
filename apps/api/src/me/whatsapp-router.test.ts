import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { WhatsAppRouterDeps } from "./whatsapp-router.js";
import {
  createWhatsAppRouter,
  ME_NONCE_PATTERN,
  signatureValid,
  whatsAppDeepLink,
} from "./whatsapp-router.js";

const WEBHOOK_URL = "https://me.example/api/v1/messaging/webhook/whatsapp";
const APP_SECRET = "test-app-secret";
const BUSINESS_NUMBER = "+1 555 000 1111";
const REPLY = "Your me.io code is 654321";

function signedRequest(body: string): Request {
  const digest = createHmac("sha256", APP_SECRET).update(body).digest("hex");
  return new Request(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${digest}` },
    body,
  });
}

function whatsappBody(text: string, id = "wamid.test1"): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "entry-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: "pn-1" },
              contacts: [{ profile: { name: "Test" }, wa_id: "15550002222" }],
              messages: [
                {
                  from: "15550002222",
                  id,
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

/**
 * The phone sign-in contract the router depends on: a delivery is claimed by its
 * provider message id, and only a claimed delivery answers `handled`. A replay
 * that failed to claim still carries a reply string; the router must refuse it.
 */
function mount() {
  const claimed = new Set<string>();
  const signIn = vi.fn<WhatsAppRouterDeps["signIn"]>(async (input) => {
    if (claimed.has(input.providerMessageId)) return { handled: false, reply: REPLY };
    claimed.add(input.providerMessageId);
    return { handled: true, reply: REPLY };
  });
  const handleWebhook = vi.fn<WhatsAppRouterDeps["messaging"]["handleWebhook"]>(
    // What the real surface does: its own Meta signature check over the exact
    // bytes it receives, using the same verifier the router gates with.
    async (_provider, request) => {
      const bytes = new Uint8Array(await request.clone().arrayBuffer());
      if (!signatureValid(APP_SECRET, request.headers, bytes)) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response("surface handled", { status: 200 });
    },
  );
  const messaging = {
    handleWebhook,
    openDirectThread: vi.fn<WhatsAppRouterDeps["messaging"]["openDirectThread"]>(
      async () => "whatsapp:15550002222",
    ),
    sendToThread: vi.fn<WhatsAppRouterDeps["messaging"]["sendToThread"]>(async () => ({
      handle: "wamid.outbound",
    })),
  };
  const router = createWhatsAppRouter({
    config: {
      whatsappAppSecret: APP_SECRET,
      whatsappBusinessNumber: BUSINESS_NUMBER,
    },
    signIn,
    messaging,
  });
  return { router, signIn, ...messaging };
}

describe("whatsapp router", () => {
  it("routes a sign-in nonce to phone sign-in and never to an agent", async () => {
    const { router, signIn, handleWebhook, sendToThread } = mount();

    const response = await router.handleWebhook(signedRequest(whatsappBody("ME-ABCDEF12")));

    expect(response?.status).toBe(200);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith({
      from: "15550002222",
      body: "ME-ABCDEF12",
      providerMessageId: "wamid.test1",
    });
    // The agent handler is never reached by a sign-in nonce.
    expect(handleWebhook).not.toHaveBeenCalled();
    expect(sendToThread).toHaveBeenCalledTimes(1);
    expect(sendToThread.mock.calls[0]?.[0]).toEqual({
      threadId: "whatsapp:15550002222",
      body: REPLY,
      idempotencyKey: "whatsapp:signin:wamid.test1",
    });
  });

  it("routes a trimmed nonce the same as a bare one", async () => {
    const { router, signIn, handleWebhook } = mount();

    const response = await router.handleWebhook(signedRequest(whatsappBody("  ME-ABCDEF12\n")));

    expect(response?.status).toBe(200);
    expect(signIn).toHaveBeenCalledWith({
      from: "15550002222",
      body: "ME-ABCDEF12",
      providerMessageId: "wamid.test1",
    });
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it("routes ordinary text to the agent and never to sign-in", async () => {
    const { router, signIn, handleWebhook, sendToThread } = mount();
    const body = whatsappBody("hello, find me a grant");

    const response = await router.handleWebhook(signedRequest(body));

    expect(response?.status).toBe(200);
    expect(signIn).not.toHaveBeenCalled();
    expect(sendToThread).not.toHaveBeenCalled();
    expect(handleWebhook).toHaveBeenCalledTimes(1);
    const [provider, forwarded] = handleWebhook.mock.calls[0]!;
    expect(provider).toBe("whatsapp");
    expect(forwarded.method).toBe("POST");
    // The messaging channel receives the delivery unchanged.
    await expect(forwarded.text()).resolves.toBe(body);
  });

  it("answers a replayed provider message id with one reply", async () => {
    const { router, signIn, handleWebhook, sendToThread } = mount();
    const body = whatsappBody("ME-ABCDEF12");

    await router.handleWebhook(signedRequest(body));
    const replay = await router.handleWebhook(signedRequest(body));

    expect(replay?.status).toBe(200);
    // Both deliveries route to sign-in with the same claim key, but only the
    // claimed one produces a reply: no second code, no second reply.
    expect(signIn).toHaveBeenCalledTimes(2);
    expect(signIn.mock.calls[0]?.[0]).toEqual(signIn.mock.calls[1]?.[0]);
    expect(sendToThread).toHaveBeenCalledTimes(1);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it.each(["ME-", "me-abcdef12", "ME-abc123"])("does not route %j to sign-in", async (text) => {
    const { router, signIn, handleWebhook } = mount();

    const response = await router.handleWebhook(signedRequest(whatsappBody(text)));

    expect(response?.status).toBe(200);
    expect(signIn).not.toHaveBeenCalled();
    expect(handleWebhook).toHaveBeenCalledTimes(1);
  });

  it("refuses an unsigned post before the surface parses anything", async () => {
    const { router, signIn, handleWebhook } = mount();
    const unsigned = new Request(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: whatsappBody("ME-ABCDEF12"),
    });

    const response = await router.handleWebhook(unsigned);

    expect(response?.status).toBe(401);
    expect(handleWebhook).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("refuses a mis-signed post before the surface parses anything", async () => {
    const { router, signIn, handleWebhook } = mount();
    const body = whatsappBody("ME-ABCDEF12");
    const forged = new Request(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${createHmac("sha256", "wrong-secret").update(body).digest("hex")}`,
      },
      body,
    });

    const response = await router.handleWebhook(forged);

    expect(response?.status).toBe(401);
    expect(handleWebhook).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("keeps the Meta verify handshake on the surface", async () => {
    const { router, handleWebhook, signIn } = mount();
    handleWebhook.mockImplementation(async (_provider: string, request: Request) => {
      const challenge = new URL(request.url).searchParams.get("hub.challenge");
      return new Response(challenge ?? "", { status: 200 });
    });

    const response = await router.handleWebhook(
      new Request(`${WEBHOOK_URL}?hub.mode=subscribe&hub.challenge=12345`, { method: "GET" }),
    );

    expect(response?.status).toBe(200);
    await expect(response?.text()).resolves.toBe("12345");
    expect(signIn).not.toHaveBeenCalled();
  });

  it("still delivers the agent messages of a webhook that also carried a nonce", async () => {
    const { router, signIn, handleWebhook, sendToThread } = mount();
    const payload = JSON.parse(whatsappBody("ME-ABCDEF12", "wamid.nonce")) as {
      entry: { changes: { value: { messages: unknown[] } }[] }[];
    };
    payload.entry[0]?.changes[0]?.value.messages.push({
      from: "15550002222",
      id: "wamid.chat",
      timestamp: "1700000001",
      type: "text",
      text: { body: "hello, find me a grant" },
    });
    const body = JSON.stringify(payload);

    const response = await router.handleWebhook(signedRequest(body));

    expect(response?.status).toBe(200);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(sendToThread).toHaveBeenCalledTimes(1);
    expect(handleWebhook).toHaveBeenCalledTimes(1);
    const [, forwarded] = handleWebhook.mock.calls[0]!;
    // The surface verified the forward with Meta's own check (the fake answers
    // 401 otherwise), so the router must have re-signed the filtered bytes.
    expect(forwarded.headers.get("x-hub-signature-256")).not.toBe(
      signedRequest(body).headers.get("x-hub-signature-256"),
    );
    const delivered = JSON.parse(await forwarded.text()) as {
      entry: { changes: { value: { messages: { id: string }[] } }[] }[];
    };
    expect(delivered.entry[0]?.changes[0]?.value.messages).toEqual([
      expect.objectContaining({ id: "wamid.chat" }),
    ]);
  });

  it("answers 404 when the surface does not host WhatsApp", async () => {
    const { router, handleWebhook } = mount();
    handleWebhook.mockImplementation((): Promise<Response> | null => null);

    const response = await router.handleWebhook(
      new Request(`${WEBHOOK_URL}?hub.mode=subscribe&hub.challenge=12345`, { method: "GET" }),
    );

    expect(response).toBeNull();
  });

  it("builds the wa.me deep link from the business number or refuses without one", () => {
    expect(whatsAppDeepLink({ whatsappBusinessNumber: BUSINESS_NUMBER }, "ME-ABCDEF12")).toBe(
      "https://wa.me/15550001111?text=ME-ABCDEF12",
    );
    expect(() => whatsAppDeepLink({ whatsappBusinessNumber: undefined }, "ME-ABCDEF12")).toThrow(
      "WHATSAPP_BUSINESS_NUMBER",
    );
  });

  it("anchors the nonce shape the router and phone sign-in share", () => {
    for (const nonce of ["ME-ABCDEF12", "ME-AB12CD", " ME-ZZ99ZZ "]) {
      expect(ME_NONCE_PATTERN.test(nonce.trim())).toBe(true);
    }
    for (const notNonce of ["ME-", "me-abcdef12", "ME-abc123", "ME-12345", "HELLO"]) {
      expect(ME_NONCE_PATTERN.test(notNonce.trim())).toBe(false);
    }
  });
});
