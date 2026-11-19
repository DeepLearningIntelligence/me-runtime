import { getLogger } from "@rakazo/logging";

/**
 * Meme tools: the two calls a bot uses to put a picture or a captioned text
 * meme in front of someone. The tools decide what is worth sending and refuse
 * honestly when there is nothing; one emitter owns how it reaches the chat.
 */

/** Refusal when a meme has no image at all. */
export const MEME_NO_MEDIA_REFUSAL =
  "A meme needs at least one image (image1 or image2). Nothing was sent.";

/** Refusal when a text meme has no text to render. */
export const MEME_NO_TEXT_REFUSAL = "A text meme needs text to render. Nothing was sent.";

/** Refusal when the caller names a Space other than the run's own. */
export const MEME_SPACE_REFUSAL = "A meme is sent inside the run's own Space. Nothing was sent.";

/** The one way a meme reaches people; the caller supplies the transport. */
export interface MemeMessagingEmitter {
  /**
   * Post one meme. `images` are validated URLs or data images; `caption` is the
   * text an image-less text meme renders. Answers the messaging receipt and the
   * chat message that carries it.
   */
  sendMeme(input: {
    spaceId: string;
    images: string[];
    caption?: string;
  }): Promise<{ receiptId: string; messageId: string; via: "messaging" | "chat" }>;
}

export interface MemeDispatchDeps {
  emitter: MemeMessagingEmitter;
  /** The Space this run works in; the only Space the tool may target. */
  spaceId: string;
}

export type MemeToolName = "me_send_meme" | "me_meme_from_text";

export type MemeResult =
  | {
      ok: true;
      receiptId: string;
      messageId: string;
      via: "messaging" | "chat";
      images: string[];
      caption?: string;
    }
  | { ok: false; error: string };

const DATA_IMAGE_PREFIX = /^data:image\//i;
/** A data image is carried inline, so cap what one call may ship. */
const MAX_DATA_IMAGE_CHARS = 8_000_000;

function cleanedImage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (DATA_IMAGE_PREFIX.test(trimmed)) {
    return trimmed.length <= MAX_DATA_IMAGE_CHARS ? trimmed : null;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

/** The images a call carries, in order, or the honest refusal when none is usable. */
export function resolveMemeImages(args: {
  image1?: unknown;
  image2?: unknown;
}): { ok: true; images: string[] } | { ok: false; error: string } {
  const images = [cleanedImage(args.image1), cleanedImage(args.image2)].filter(
    (image): image is string => image !== null,
  );
  if (!images.length) return { ok: false, error: MEME_NO_MEDIA_REFUSAL };
  return { ok: true, images };
}

/** The text a text meme renders, or the honest refusal when it is blank. */
export function resolveTextMeme(args: {
  text?: unknown;
}): { ok: true; text: string } | { ok: false; error: string } {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) return { ok: false, error: MEME_NO_TEXT_REFUSAL };
  return { ok: true, text };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Dispatch one meme tool call. Refusals carry the reason and send nothing; a
 * transport failure is a refusal too, never a silent success.
 */
export async function dispatchMemeTool(
  toolName: MemeToolName,
  args: Record<string, unknown>,
  deps: MemeDispatchDeps,
): Promise<MemeResult> {
  if (typeof args.spaceId === "string" && args.spaceId.trim() !== deps.spaceId) {
    return { ok: false, error: MEME_SPACE_REFUSAL };
  }
  if (toolName === "me_send_meme") {
    const resolved = resolveMemeImages(args);
    if (!resolved.ok) return resolved;
    try {
      const sent = await deps.emitter.sendMeme({
        spaceId: deps.spaceId,
        images: resolved.images,
      });
      return { ok: true, ...sent, images: resolved.images };
    } catch (error) {
      getLogger().error("meme send failed", { toolName, reason: describeError(error) });
      return { ok: false, error: `The meme could not be sent: ${describeError(error)}` };
    }
  }
  const resolved = resolveTextMeme(args);
  if (!resolved.ok) return resolved;
  try {
    const sent = await deps.emitter.sendMeme({
      spaceId: deps.spaceId,
      images: [],
      caption: resolved.text,
    });
    return { ok: true, ...sent, images: [], caption: resolved.text };
  } catch (error) {
    getLogger().error("text meme send failed", { toolName, reason: describeError(error) });
    return { ok: false, error: `The meme could not be sent: ${describeError(error)}` };
  }
}
