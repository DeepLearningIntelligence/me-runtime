import type { WhatsAppCarouselCard } from "@rakazo/adapter-kit";
import type { ProductCardFacts } from "./product-card.js";

/**
 * WhatsApp interactive media carousel, the Cloud API's `type: "interactive",
 * interactive.type: "carousel"` message: 2 to 10 swipeable cards, each with a
 * media header, body text, and one CTA button. No Meta product catalog is
 * needed, so products and any other rich content fit the same format. Every
 * card uses one CTA style; products all use URL buttons.
 */

/** Meta's product floor, and the display floor when the facts list has one card. */
export const WHATSAPP_CAROUSEL_MIN_CARDS = 2;
/** Meta's own limit: messages carry 2 to 10 cards. */
export const WHATSAPP_CAROUSEL_MAX_CARDS = 10;

/** WhatsApp card bodies stay inside Meta's 160-character per-card budget. */
const WHATSAPP_CARD_BODY_MAX_CHARS = 160;

const WHATSAPP_VIEW_BUTTON_TEXT = "View product";

/** The thread id format the vendored adapter uses: `whatsapp:{phoneId}:{userId}`. */
const WHATSAPP_BSUID_PATTERN = /^[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,128}$/;

/**
 * Products as WhatsApp carousel cards: one per product with an image, capped
 * at Meta's 10-card limit, card index assigned in order. A card without a
 * media header cannot exist in a carousel, so image-less products are
 * dropped here; the caller keeps its text path for them.
 */
export function productCardsToWhatsAppCarouselCards(
  products: ProductCardFacts[],
): WhatsAppCarouselCard[] {
  const cards: WhatsAppCarouselCard[] = [];
  for (const product of products) {
    if (cards.length >= WHATSAPP_CAROUSEL_MAX_CARDS) break;
    if (!product.imageUrl) continue;
    cards.push({
      card_index: cards.length,
      type: "cta_url",
      header: { type: "image", image: { link: product.imageUrl } },
      body: { text: whatsAppCardBody(product) },
      action: {
        name: "cta_url",
        parameters: { display_text: WHATSAPP_VIEW_BUTTON_TEXT, url: product.url },
      },
    });
  }
  return cards;
}

function whatsAppCardBody(product: ProductCardFacts): string {
  const parts = [
    `*${product.title}*`,
    product.price,
    ...product.attributes.map((a) => `${a.k}: ${a.v}`),
  ];
  return parts.filter(Boolean).join("\n").slice(0, WHATSAPP_CARD_BODY_MAX_CHARS);
}

/** The recipient half of a Cloud API message: `to` or a BSUID in `recipient`. */
export type WhatsAppCarouselRecipient = { to: string } | { recipient: string };

/** The thread id format the vendored adapter uses: `whatsapp:{phoneId}:{userId}`. */
export function whatsAppCarouselRecipientFromThreadId(threadId: string): WhatsAppCarouselRecipient {
  const parts = threadId.split(":");
  const userWaId = parts.slice(2).join(":");
  if (!parts[1] || !userWaId) return { to: userWaId };
  return WHATSAPP_BSUID_PATTERN.test(userWaId) ? { recipient: userWaId } : { to: userWaId };
}

export interface WhatsAppCarouselSendTarget {
  accessToken: string;
  /** The adapter's default Graph API origin plus version, v25.0. */
  apiUrl: string;
  phoneNumberId: string;
  recipient: WhatsAppCarouselRecipient;
}

export function whatsAppCarouselRequestBody(
  cards: WhatsAppCarouselCard[],
  bodyText: string,
  recipient: WhatsAppCarouselRecipient,
): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...recipient,
    type: "interactive",
    interactive: {
      type: "carousel",
      body: { text: bodyText },
      action: { cards },
    },
  };
}

/**
 * Posts the carousel to the Cloud API. Throws on any non-2xx or a response
 * without a message id; the delivery lane retries and marks the row failed
 * after its budget, like any other send error.
 */
export async function sendWhatsAppCarousel(
  target: WhatsAppCarouselSendTarget,
  cards: WhatsAppCarouselCard[],
  bodyText: string,
): Promise<{ messageId: string }> {
  const response = await fetch(`${target.apiUrl}/${target.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(whatsAppCarouselRequestBody(cards, bodyText, target.recipient)),
  });
  const payload = (await response.json().catch(() => null)) as {
    messages?: Array<{ id?: unknown }>;
  } | null;
  const messageId = payload?.messages?.[0]?.id;
  if (!response.ok || typeof messageId !== "string") {
    throw new Error(`WhatsApp carousel send failed (HTTP ${response.status})`);
  }
  return { messageId };
}
