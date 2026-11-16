import type { MessagingSurface } from "@rakazo/adapter-kit";
import type { Hono } from "hono";
import type { WhatsAppWebhookRouter } from "./me/whatsapp-router.js";

export const MESSAGING_WEBHOOK_BASE_PATH = "/api/v1/messaging/webhook";

/**
 * Signature verification happens inside the surface's platform adapters; replay safety comes
 * from per-message client nonces downstream. WhatsApp is the one exception at the door: when
 * a router is mounted, it verifies the signature over the raw bytes and routes sign-in
 * nonces before the surface parses anything.
 */
export function mountMessagingWebhookRoutes(
  app: Hono,
  deps: { messaging: MessagingSurface; whatsapp?: WhatsAppWebhookRouter },
) {
  app.all(`${MESSAGING_WEBHOOK_BASE_PATH}/:provider`, async (c) => {
    const provider = c.req.param("provider");
    if (provider === "whatsapp" && deps.whatsapp) {
      const response = await deps.whatsapp.handleWebhook(c.req.raw);
      if (!response) return c.json({ error: "Unknown provider" }, 404);
      return response;
    }
    const response = deps.messaging.handleWebhook(provider, c.req.raw);
    if (!response) return c.json({ error: "Unknown provider" }, 404);
    return response;
  });
  // The pre-multi-platform sendblue path; already-configured dashboards
  // keep delivering without an update.
  app.post("/api/v1/phone/webhook", async (c) => {
    const response = deps.messaging.handleWebhook("sendblue", c.req.raw);
    if (!response) return c.json({ error: "Unknown provider" }, 404);
    return response;
  });
}
