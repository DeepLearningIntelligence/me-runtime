import { createHmac, timingSafeEqual } from "node:crypto";
import type { AdapterContext, MessagingSurface } from "@rakazo/adapter-kit";
import { MESSAGING_WEBHOOK_MAX_BODY_BYTES } from "@rakazo/adapters";
import { readBoundedBytes } from "../http-body.js";

/**
 * One inbound WhatsApp webhook decides exactly once (D-RUN-6): the signature is
 * verified over the raw body bytes before any parse, then a trimmed body that
 * looks like a sign-in nonce goes to phone sign-in and never reaches an agent;
 * every other message goes to the existing messaging channel unchanged.
 */
export const ME_NONCE_PATTERN = /^ME-[A-Z0-9]{6,}$/;

const SIGNATURE_HEADER = "x-hub-signature-256";
const SIGNATURE_SCHEME = "sha256";

/** Bounds the sign-in reply send so the webhook still answers Meta promptly. */
const SIGNIN_REPLY_TIMEOUT_MS = 10_000;

/**
 * Phone sign-in's single entry (`me/phone-signin`). `handled` must be true only
 * when the provider message id was claimed in the same transaction as the work,
 * so a Meta replay is a no-op; the router sends `reply` only when `handled` is
 * true, so a replay never produces a second code or a second reply.
 */
export type WhatsAppSignInHandler = (input: {
  from: string;
  body: string;
  providerMessageId: string;
}) => Promise<{ handled: boolean; reply?: string }>;

export interface WhatsAppRouterConfig {
  whatsappAppSecret: string | undefined;
  /** The business line people text; also the number wa.me deep links point at. */
  whatsappBusinessNumber: string | undefined;
}

export interface WhatsAppRouterDeps {
  config: WhatsAppRouterConfig;
  signIn: WhatsAppSignInHandler;
  /** The existing messaging surface: agent delivery and the sign-in reply sender. */
  messaging: Pick<MessagingSurface, "handleWebhook" | "openDirectThread" | "sendToThread">;
}

export interface WhatsAppWebhookRouter {
  /**
   * Runs first for WhatsApp webhook requests. Returns the response to send, or
   * null when the surface does not host WhatsApp (the caller answers 404).
   */
  handleWebhook(request: Request): Promise<Response | null>;
}

export function createWhatsAppRouter(deps: WhatsAppRouterDeps): WhatsAppWebhookRouter {
  return {
    async handleWebhook(request) {
      if (request.method !== "POST") return dispatch(deps.messaging, request);
      if (!deps.config.whatsappAppSecret) return null;
      const bytes = await readBoundedBytes(request, MESSAGING_WEBHOOK_MAX_BODY_BYTES);
      if (bytes === null) return new Response("Payload too large", { status: 413 });
      if (!signatureValid(deps.config.whatsappAppSecret, request.headers, bytes)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const payload = parsePayload(bytes);
      const messages = inboundMessages(payload);
      const nonces = nonceMessages(messages);
      // Identical bytes re-sign to the same header, so every forward carries a
      // signature the surface's own check accepts.
      if (nonces.length === 0)
        return dispatch(
          deps.messaging,
          forwardedRequest(request, deps.config.whatsappAppSecret, bytes),
        );
      const nonceIds = new Set(nonces.map((message) => message.id));
      for (const message of nonces) {
        const result = await deps.signIn({
          from: message.from,
          body: message.body,
          providerMessageId: message.id,
        });
        // Only a delivery the handler claimed gets a reply, so Meta's retry of
        // the same message id is answered without a second code or reply.
        if (result.handled && result.reply) {
          await sendSignInReply(deps.messaging, message.from, result.reply, message.id);
        }
      }
      const rest = messages.filter((message) => !nonceIds.has(message.id));
      // A webhook can batch messages: the agent ones must still be delivered,
      // but stripped of the sign-in nonces so none of them reaches an agent.
      if (rest.length > 0) {
        const clone = structuredClone(payload) as Record<string, unknown> | undefined;
        stripMessages(clone, nonceIds);
        // The forwarded bytes differ from what Meta signed, so the surface's own
        // signature check would answer 401 to the original header: re-sign the
        // exact bytes we forward with the same app secret we verified with.
        return dispatch(
          deps.messaging,
          forwardedRequest(request, deps.config.whatsappAppSecret, encode(clone)),
        );
      }
      return Response.json({ ok: true });
    },
  };
}

/** The wa.me deep link a person taps to send `nonce` to the business line. */
export function whatsAppDeepLink(
  config: Pick<WhatsAppRouterConfig, "whatsappBusinessNumber">,
  nonce: string,
): string {
  if (!config.whatsappBusinessNumber) {
    throw new Error("WHATSAPP_BUSINESS_NUMBER is not configured; cannot build a wa.me deep link");
  }
  const digits = config.whatsappBusinessNumber.replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(nonce)}`;
}

async function dispatch(
  messaging: WhatsAppRouterDeps["messaging"],
  request: Request,
): Promise<Response | null> {
  return await messaging.handleWebhook("whatsapp", request);
}

/**
 * The one verifier for a Meta WhatsApp webhook delivery, over the exact bytes.
 * Exported so the surface layer and this module's tests check a forwarded
 * delivery with the same function that gates the inbound one.
 */
export function signatureValid(appSecret: string, headers: Headers, bytes: Uint8Array): boolean {
  const header = headers.get(SIGNATURE_HEADER);
  if (!header) return false;
  const separator = header.indexOf("=");
  if (separator < 0 || header.slice(0, separator) !== SIGNATURE_SCHEME) return false;
  const digest = header.slice(separator + 1);
  const expected = createHmac(SIGNATURE_SCHEME, appSecret).update(bytes).digest("hex");
  // timingSafeEqual needs equal lengths; a wrong length is already a mismatch.
  return (
    digest.length === expected.length &&
    timingSafeEqual(Buffer.from(digest.toLowerCase()), Buffer.from(expected))
  );
}

/** The header value Meta itself would send for these bytes. */
function signatureFor(appSecret: string, bytes: Uint8Array): string {
  return `${SIGNATURE_SCHEME}=${createHmac(SIGNATURE_SCHEME, appSecret).update(bytes).digest("hex")}`;
}

function parsePayload(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

interface InboundWhatsAppMessage {
  from: string;
  id: string;
  body: string | undefined;
}

/** The inbound text messages of a Cloud API webhook payload, across all entries. */
function inboundMessages(payload: unknown): InboundWhatsAppMessage[] {
  const messages: InboundWhatsAppMessage[] = [];
  for (const entry of arrayField(asRecord(payload), "entry")) {
    for (const change of arrayField(asRecord(entry), "changes")) {
      for (const item of arrayField(asRecord(asRecord(change)?.value), "messages")) {
        const record = asRecord(item);
        const from = stringField(record, "from");
        const id = stringField(record, "id");
        if (!from || !id) continue;
        // The wa.me door sends the nonce as a plain text body; button and
        // interactive replies carry no nonce.
        messages.push({ from, id, body: stringField(asRecord(record?.text), "body") });
      }
    }
  }
  return messages;
}

/**
 * A request the router can still hand to the surface after it has read the body
 * itself: identical bytes, identical headers except the signature, which is
 * recomputed over the exact forwarded bytes. A batch the router filtered no
 * longer matches what Meta signed, so forwarding the original header would make
 * the surface's own check refuse the delivery.
 */
function forwardedRequest(request: Request, appSecret: string, bytes: Uint8Array): Request {
  const headers = new Headers(request.headers);
  headers.set(SIGNATURE_HEADER, signatureFor(appSecret, bytes));
  // A fresh Uint8Array over the same bytes is a BodyInit the Request accepts.
  return new Request(request.url, {
    method: request.method,
    headers,
    body: new Uint8Array(bytes),
  });
}

/**
 * The same webhook payload with the sign-in nonces removed, so the messaging
 * channel receives exactly the messages that are its own.
 */
function stripMessages(payload: Record<string, unknown> | undefined, nonceIds: Set<string>): void {
  for (const entry of arrayField(payload, "entry")) {
    for (const change of arrayField(asRecord(entry), "changes")) {
      const value = asRecord(asRecord(change)?.value);
      if (!value) continue;
      value.messages = arrayField(value, "messages").filter(
        (item) => !nonceIds.has(stringField(asRecord(item), "id") ?? ""),
      );
    }
  }
}

function encode(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

async function sendSignInReply(
  messaging: WhatsAppRouterDeps["messaging"],
  from: string,
  reply: string,
  providerMessageId: string,
): Promise<void> {
  const context: AdapterContext = {
    operationId: `whatsapp.signin:${providerMessageId}`,
    traceId: `whatsapp.signin:${providerMessageId}`,
    spaceId: "",
    userId: "",
    signal: AbortSignal.timeout(SIGNIN_REPLY_TIMEOUT_MS),
  };
  // The same surface that delivers agent replies sends the code: answering an
  // inbound message from the business line stays inside Meta's free 24 hour
  // service window, so no template send is needed.
  const threadId = await messaging.openDirectThread("whatsapp", from, context);
  await messaging.sendToThread(
    { threadId, body: reply, idempotencyKey: `whatsapp:signin:${providerMessageId}` },
    context,
  );
}

/** The messages whose trimmed body is a sign-in nonce; only these leave the messaging channel. */
function nonceMessages(
  messages: InboundWhatsAppMessage[],
): Array<InboundWhatsAppMessage & { body: string }> {
  const nonces: Array<InboundWhatsAppMessage & { body: string }> = [];
  for (const message of messages) {
    const body = message.body?.trim();
    if (body !== undefined && ME_NONCE_PATTERN.test(body)) nonces.push({ ...message, body });
  }
  return nonces;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayField(record: Record<string, unknown> | undefined, field: string): unknown[] {
  const value = record?.[field];
  return Array.isArray(value) ? value : [];
}

function stringField(
  record: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const value = record?.[field];
  return typeof value === "string" ? value : undefined;
}
