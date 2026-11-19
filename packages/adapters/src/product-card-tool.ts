import type { MessageBlock } from "@rakazo/contracts";
import { normalizedHttpUrl } from "@rakazo/core/egress";
import { extractProductCardFacts } from "./product-card.js";
import type { RunContext } from "./run-context.js";
import { publishMessage } from "./run-messages.js";
import type { ToolCall } from "./run-tool-gate.js";
import { webFetchFromTool, webSearchFromTool } from "./web-tools.js";

const READ_FAILURE = "could not read the product";

/**
 * Builds a product card from a product page and posts it to the thread. The page is the caller's
 * `url` (site-gated by the tool gate) or the first search hit for `product`; the facts come from
 * the page itself, and anything short of a title and a price posts nothing.
 */
export async function productCardFromTool(ctx: RunContext, call: ToolCall) {
  const { providers, context } = ctx;
  const product = String(call.args.product ?? "").trim();
  if (!product) return { error: "product is required" };
  let url = normalizedHttpUrl(String(call.args.url ?? "").trim());
  let source = url;
  if (!url) {
    const found = await webSearchFromTool(providers.web, context, { query: product });
    if ("error" in found) return { error: READ_FAILURE };
    const hit = found.results?.find((result) => normalizedHttpUrl(result.url));
    if (!hit) return { error: READ_FAILURE };
    url = normalizedHttpUrl(hit.url)!;
    source = url;
    // The search index chose this URL, not text in this run, so later fetches of it are trusted.
    ctx.trust.searchResultUrls.add(url);
  }
  const fetched = await webFetchFromTool(providers.web, context, { url });
  if ("error" in fetched) return { error: READ_FAILURE };
  const facts = extractProductCardFacts(fetched, source);
  if (!facts) return { error: READ_FAILURE };
  const block: MessageBlock = {
    kind: "product_card",
    url: facts.url,
    title: facts.title,
    ...(facts.subtitle ? { subtitle: facts.subtitle } : {}),
    price: facts.price,
    attributes: facts.attributes,
    ...(facts.imageUrl ? { imageUrl: facts.imageUrl } : {}),
    source: facts.source,
    verifiedAt: facts.verifiedAt,
  };
  await publishMessage(ctx.deps, ctx.run, "bot", [block]);
  return { productCard: block };
}
