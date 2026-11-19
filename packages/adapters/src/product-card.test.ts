import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { FakeWebProvider } from "./fake-web.js";
import { extractProductCardFacts } from "./product-card.js";
import { webFetchFromTool } from "./web-tools.js";

const ctx: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

// A Shopstar product page as readable text: title, vendor, a caption, attributes, price, image.
const SHOPSTAR_PAGE = {
  url: "https://shopstar.example/products/mini-backpack",
  title: "Mini Backpack",
  text: [
    "Mini Backpack",
    "Shopstar",
    "A lightweight everyday pack.",
    "Color: Cream",
    "Material: Recycled nylon",
    "$49.99",
    "https://shopstar.example/images/mini-backpack.jpg",
  ].join("\n"),
  truncated: false,
};

async function fetchPage(page: typeof SHOPSTAR_PAGE) {
  const web = new FakeWebProvider();
  web.fetchResult = page;
  const fetched = await webFetchFromTool(web, ctx, { url: page.url });
  if ("error" in fetched) throw new Error(fetched.error);
  return fetched;
}

describe("product card extraction", () => {
  it("reads title, price and attributes from a Shopstar page fetched by web_fetch", async () => {
    const card = extractProductCardFacts(await fetchPage(SHOPSTAR_PAGE));
    expect(card).not.toBeNull();
    expect(card!.url).toBe(SHOPSTAR_PAGE.url);
    expect(card!.source).toBe(SHOPSTAR_PAGE.url);
    expect(card!.title).toBe("Mini Backpack");
    expect(card!.subtitle).toBe("Shopstar");
    expect(card!.price).toBe("$49.99");
    expect(card!.attributes).toEqual([
      { k: "Color", v: "Cream" },
      { k: "Material", v: "Recycled nylon" },
    ]);
    expect(card!.imageUrl).toBe("https://shopstar.example/images/mini-backpack.jpg");
    expect(Number.isNaN(Date.parse(card!.verifiedAt))).toBe(false);
  });

  it("fails closed when the page states no price", async () => {
    const page = { ...SHOPSTAR_PAGE, text: "Mini Backpack\nColor: Cream" };
    expect(extractProductCardFacts(await fetchPage(page))).toBeNull();
  });

  it("fails closed when the page states no title", async () => {
    const page = { ...SHOPSTAR_PAGE, title: "", text: "  \n " };
    expect(extractProductCardFacts(await fetchPage(page))).toBeNull();
  });

  it("keeps a currency-code price and records the search hit as the source", async () => {
    const page = { ...SHOPSTAR_PAGE, text: "USD 49.99\nColor: Cream" };
    const card = extractProductCardFacts(await fetchPage(page), "https://search.example/hit");
    expect(card!.price).toBe("USD 49.99");
    expect(card!.source).toBe("https://search.example/hit");
  });

  it("leaves out attributes and images the page does not state", async () => {
    const page = { ...SHOPSTAR_PAGE, text: "Mini Backpack\n$49.99" };
    const card = extractProductCardFacts(await fetchPage(page));
    expect(card!.attributes).toEqual([]);
    expect(card!.imageUrl).toBeUndefined();
  });
});
