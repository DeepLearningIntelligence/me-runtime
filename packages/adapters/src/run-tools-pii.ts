import { getLogger } from "@rakazo/logging";
import type { ToolHandlers } from "./run-tool-gate.js";

/**
 * The signed PII tunnel link. The operator sends the URL over WhatsApp; the
 * person signs in and uploads there, so no credential ever travels in chat.
 */
export const piiTools: ToolHandlers = {
  async me_pii_link(ctx, call) {
    const { deps, run } = ctx;
    if (!deps.issuePiiTunnelLink) {
      // A named refusal, not a made-up link: this process cannot mint one.
      getLogger().warn("me_pii_link is not wired in this process", { "user.id": run.userId });
      return call.finish({
        error:
          "PII upload links are not available in this run. Ask the operator to issue the link from the app.",
      });
    }
    const link = await deps.issuePiiTunnelLink(run.userId);
    return call.finish({
      url: link.url,
      expiresAt: link.expiresAt.toISOString(),
      instructions:
        "Send this link to the person in WhatsApp and ask them to open it. It signs them in and opens the upload page once, then expires in 15 minutes.",
    });
  },
};
