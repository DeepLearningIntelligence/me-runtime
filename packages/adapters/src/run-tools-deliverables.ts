import { getLogger } from "@rakazo/logging";
import {
  deliverableSlug,
  normalizeDeliverableBlocks,
  publishDeliverable,
  publishVisualPack,
} from "./deliverables.js";
import { publishMessage } from "./run-messages.js";
import type { ToolHandlers } from "./run-tool-gate.js";

const DELIVERABLE_KINDS = new Set(["white_paper", "report"]);

/** Pages, reports and the Visual Pack message that carries their research blocks. */
export const deliverableTools: ToolHandlers = {
  async me_deliverable(ctx, call) {
    const { args } = call;
    const kind = typeof args.kind === "string" ? args.kind : "";
    if (!DELIVERABLE_KINDS.has(kind)) {
      return call.finish({ error: "kind must be white_paper or report" });
    }
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) return call.finish({ error: "title is required" });
    if (title.length > 200) return call.finish({ error: "title must be at most 200 characters" });
    if (!deliverableSlug(title)) {
      return call.finish({ error: "title must contain at least one letter or digit" });
    }
    const requestedSpace = typeof args.spaceId === "string" ? args.spaceId.trim() : "";
    if (requestedSpace && requestedSpace !== ctx.run.spaceId) {
      // A run only publishes into its own space; never let the model cross spaces.
      return call.finish({ error: "spaceId must be this run's space" });
    }
    const blocks = normalizeDeliverableBlocks(args.blocks);
    const published = publishDeliverable({
      spaceId: ctx.run.spaceId,
      kind: kind as "white_paper" | "report",
      title,
      owner: ctx.run.userId,
      provenance: {
        runId: ctx.runId,
        botId: ctx.bot.id,
        spaceId: ctx.run.spaceId,
      },
      blocks,
    });

    let visualPack: { published: boolean } | undefined;
    if (blocks.length > 0) {
      try {
        const sent = await publishVisualPack(
          (visualBlocks) => publishMessage(ctx.deps, ctx.run, "bot", visualBlocks),
          { title, pageUrl: published.pageUrl, blocks },
        );
        visualPack = { published: sent.published };
      } catch (error) {
        // The page is already written; a failed Visual Pack must not claim it is missing.
        getLogger().warn("deliverable.visual_pack_failed", {
          "run.id": ctx.runId,
          "space.id": ctx.run.spaceId,
          error,
        });
        visualPack = { published: false };
      }
    }

    return call.finish({
      pageUrl: published.pageUrl,
      browserPreview: published.browserPreview,
      filePath: published.filePath,
      ...(visualPack ? { visualPack } : {}),
    });
  },
};
