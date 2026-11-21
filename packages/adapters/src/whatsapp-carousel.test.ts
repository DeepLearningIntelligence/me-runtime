import type { WhatsAppCarouselCard } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { ProductCardFacts } from "./product-card.js";
import {
  productCardsToWhatsAppCarouselCards,
  sendWhatsAppCarousel,
  whatsAppCarouselRecipientFromThreadId,
  whatsAppCarouselRequestBody,
} from "./whatsapp-carousel.js";

const baseProduct: ProductCardFacts = {
  url: "https://shop.example.com/wand",
  title: "Zephyr Wand",
  price: "$49.99",
  attributes: [
    { k: "Color", v: "Birch" },
    { k: "Length", v: "10 inch" },
  ],
  imageUrl: "https://cdn.example.com/wand.jpg",
  source: "https://shop.example.com/wand",
  verifiedAt: "2026-11-21T00:00:00.000Z",
};

describe("productCardsToWhatsAppCarouselCards", () => {
  it("turns image products into cta_url cards in block order", () => {
    const cards = productCardsToWhatsAppCarouselCards([baseProduct, baseProduct]);
    expect(cards).toHaveLength(2);
    expect(cards[0]!.card_index).toBe(0);
    expect(cards[1]!.card_index).toBe(1);
    const card = cards[0]!;
    expect(card.type).toBe("cta_url");
    expect(card.header).toEqual({ type: "image", image: { link: baseProduct.imageUrl } });
    expect(card.body?.text).toContain("Zephyr Wand");
    expect(card.body?.text).toContain("$49.99");
    expect(card.body?.text).toContain("Color: Birch");
    expect(card.action).toEqual({
      name: "cta_url",
      parameters: { display_text: "View product", url: baseProduct.url },
    });
  });

  it("drops products without an image, since a card needs a media header", () => {
    const noImage = { ...baseProduct, imageUrl: undefined };
    expect(productCardsToWhatsAppCarouselCards([noImage, baseProduct])).toHaveLength(1);
  });

  it("caps the carousel at Meta's 10-card limit", () => {
    const products = Array.from({ length: 15 }, (_, index) => ({
      ...baseProduct,
      url: `https://shop.example.com/wand-${index}`,
      imageUrl: `https://cdn.example.com/wand-${index}.jpg`,
    }));
    const cards = productCardsToWhatsAppCarouselCards(products);
    expect(cards).toHaveLength(10);
    expect(cards.map((card) => card.card_index)).toEqual(Array.from({ length: 10 }, (_, i) => i));
  });
});

describe("whatsAppCarouselRecipientFromThreadId", () => {
  it("uses to: for a wa_id", () => {
    expect(whatsAppCarouselRecipientFromThreadId("whatsapp:1234:16505550000")).toEqual({
      to: "16505550000",
    });
  });

  it("uses recipient: for a BSUID, like the vendored adapter", () => {
    expect(whatsAppCarouselRecipientFromThreadId("whatsapp:1234:US.13491208655302741918")).toEqual({
      recipient: "US.13491208655302741918",
    });
  });

  it("falls back to to: when the id has no wa_id half", () => {
    expect(whatsAppCarouselRecipientFromThreadId("whatsapp:")).toEqual({ to: "" });
  });
});

describe("whatsAppCarouselRequestBody", () => {
  it("builds the interactive carousel request with the recipient half", () => {
    const cards: WhatsAppCarouselCard[] = [
      {
        card_index: 0,
        type: "cta_url",
        header: { type: "image", image: { link: "https://cdn.example.com/wand.jpg" } },
        action: {
          name: "cta_url",
          parameters: { display_text: "View product", url: "https://shop.example.com/wand" },
        },
      },
    ];
    expect(whatsAppCarouselRequestBody(cards, "Products:", { to: "16505550000" })).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "16505550000",
      type: "interactive",
      interactive: {
        type: "carousel",
        body: { text: "Products:" },
        action: { cards },
      },
    });
  });
});

describe("sendWhatsAppCarousel", () => {
  it("returns the message id from the Graph API response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 }),
        ),
    );
    const sent = await sendWhatsAppCarousel(
      {
        accessToken: "tok",
        apiUrl: "https://graph.example.com/v25.0",
        phoneNumberId: "1065",
        recipient: { to: "16505550000" },
      },
      [
        {
          card_index: 0,
          type: "cta_url",
          header: { type: "image", image: { link: "https://cdn.example.com/wand.jpg" } },
          action: {
            name: "cta_url",
            parameters: { display_text: "View product", url: "https://shop.example.com/wand" },
          },
        },
        {
          card_index: 1,
          type: "cta_url",
          header: { type: "image", image: { link: "https://cdn.example.com/wand2.jpg" } },
          action: {
            name: "cta_url",
            parameters: { display_text: "View product", url: "https://shop.example.com/wand2" },
          },
        },
      ],
      "Products:",
    );
    expect(sent).toEqual({ messageId: "wamid.1" });
    vi.unstubAllGlobals();
  });

  it("throws when the response has no message id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    await expect(
      sendWhatsAppCarousel(
        {
          accessToken: "tok",
          apiUrl: "https://graph.example.com/v25.0",
          phoneNumberId: "1065",
          recipient: { to: "16505550000" },
        },
        [],
        "Products:",
      ),
    ).rejects.toThrow(/failed/);
    vi.unstubAllGlobals();
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { message: "oops" } }), { status: 500 }),
        ),
    );
    await expect(
      sendWhatsAppCarousel(
        {
          accessToken: "tok",
          apiUrl: "https://graph.example.com/v25.0",
          phoneNumberId: "1065",
          recipient: { to: "16505550000" },
        },
        [],
        "Products:",
      ),
    ).rejects.toThrow(/failed/);
    vi.unstubAllGlobals();
  });
});
