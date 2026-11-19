import type { WebFetchResult } from "@rakazo/adapter-kit";
import { normalizedHttpUrl } from "@rakazo/core/egress";

/** Facts a product card shows. Every one is read from the page, never chosen by a model. */
export interface ProductCardFacts {
  url: string;
  title: string;
  subtitle?: string;
  price: string;
  attributes: Array<{ k: string; v: string }>;
  imageUrl?: string;
  source: string;
  verifiedAt: string;
}

const MAX_ATTRIBUTES = 12;
const SUBTITLE_MAX_CHARS = 120;
const PRICE_WITH_SYMBOL = /\$\s?\d[\d,]*(?:\.\d+)?/;
const PRICE_WITH_CODE = /\b(?:USD|EUR|GBP|CAD|AUD|JPY)\s?\d[\d,]*(?:\.\d+)?/i;
// "Color: Cream", as a readable page's attribute lines are normalized.
const ATTRIBUTE_LINE = /^([A-Z][A-Za-z]*(?: [A-Za-z]+){0,4})[ \t]*:[ \t]*(\S.{0,158})$/;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const IMAGE_PATH = /\.(?:jpe?g|png|webp|gif|avif|svg)$/i;

/**
 * Reads a product card from a fetched page. Returns null unless the page states both a title and
 * a price: a card may not guess either. Attributes, subtitle and image are kept only when the page
 * states them, and `source` records the page the facts were read from.
 */
export function extractProductCardFacts(
  result: WebFetchResult,
  source: string = result.url,
): ProductCardFacts | null {
  const url = normalizedHttpUrl(result.url);
  if (!url) return null;
  const text = result.text ?? "";
  const title = (result.title ?? "").trim() || firstLine(text);
  if (!title) return null;
  const price = text.match(PRICE_WITH_SYMBOL)?.[0] ?? text.match(PRICE_WITH_CODE)?.[0];
  if (!price) return null;
  const attributes = findAttributes(text);
  const subtitle = findSubtitle(text, title);
  const imageUrl = findImageUrl(text);
  return {
    url,
    title: title.slice(0, 200),
    ...(subtitle ? { subtitle: subtitle.slice(0, 200) } : {}),
    price: price.trim().slice(0, 200),
    attributes,
    ...(imageUrl ? { imageUrl } : {}),
    source: normalizedHttpUrl(source) ?? url,
    verifiedAt: new Date().toISOString(),
  };
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function findAttributes(text: string): Array<{ k: string; v: string }> {
  const found: Array<{ k: string; v: string }> = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const match = raw.trim().match(ATTRIBUTE_LINE);
    if (!match) continue;
    const k = match[1]!.trim();
    const v = match[2]!.trim();
    // A price line is not an attribute.
    if (!/[A-Za-z]/.test(v)) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ k: k.slice(0, 80), v: v.slice(0, 160) });
    if (found.length === MAX_ATTRIBUTES) break;
  }
  return found;
}

function findSubtitle(text: string, title: string): string | undefined {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.length > SUBTITLE_MAX_CHARS) continue;
    if (line === title) continue;
    if (/\d/.test(line)) continue;
    if (line.startsWith("http")) continue;
    if (line.endsWith(":")) continue;
    if (ATTRIBUTE_LINE.test(line)) continue;
    return line;
  }
  return undefined;
}

function findImageUrl(text: string): string | undefined {
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const candidate = normalizedHttpUrl((match[0] ?? "").replace(/[.,;:!?)\]}]+$/, ""));
    if (!candidate) continue;
    const path = candidate.split(/[?#]/, 1)[0] ?? "";
    if (IMAGE_PATH.test(path)) return candidate;
  }
  return undefined;
}
