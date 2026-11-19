/**
 * LLM orchestration routing: a request's own signals choose the model before a run.
 *
 * Rules, in the order they are checked:
 *   - PII-bearing text goes to the CDR model. With no CDR model configured the
 *     decision throws rather than leaking personal data to the default model.
 *   - Research and exploration go to a free/local model when one is configured.
 *   - Image and video go to KIE.ai only when an operator has enabled it and set a
 *     per-request ceiling; the vendor is off by default so spend never starts silently.
 *   - Code keeps the default model.
 *   - Anything unclassified, and every request while routing is off, keeps the
 *     current model: the default is always "no change".
 *
 * The config lives in ./llm-routing-config.json.
 */
import { z } from "zod";
import rawConfig from "./llm-routing-config.json" with { type: "json" };

const targetSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
});

const routingConfigSchema = z.object({
  /** Master switch. While false no rule changes the selected model. */
  enabled: z.boolean(),
  /** Model personal data must go to. Null until a deployment has one. */
  cdr: targetSchema.nullable(),
  /** Model for research and exploration, normally the operator's local server. */
  freeLocal: targetSchema.nullable(),
  /** Image and video generation. OFF by default: enabling it starts recurring spend. */
  imageVideo: z
    .object({
      provider: z.string().min(1),
      modelId: z.string().min(1),
      enabled: z.boolean(),
      /** Per-request USD cap. Required before the vendor may be enabled. */
      ceilingUsd: z.number().positive().nullable(),
      notes: z.string().optional(),
    })
    .nullable(),
  /** Model for code requests; null keeps the default model. */
  code: targetSchema.nullable(),
  /** Operator-facing rationale, kept beside the values it explains. */
  notes: z.record(z.string(), z.string()).optional(),
});

export type LlmRoutingConfig = z.infer<typeof routingConfigSchema>;
export type LlmRoutingTarget = z.infer<typeof targetSchema>;

export interface LlmRouteModel {
  provider: string;
  id: string;
}

export interface LlmRouteRequest {
  /** The model a run would use without routing. */
  model: LlmRouteModel;
  /** The user's turn; the only signal most runs carry. */
  prompt?: string;
  /** Recent turns, so a short follow-up is classified with its context. */
  history?: ReadonlyArray<{ role: string; content: string }>;
}

export type LlmRouteReason = "pii" | "research" | "image-video" | "code" | "default";

export interface LlmRouteDecision {
  modelId: string;
  reason: LlmRouteReason;
}

/** Parse and validate the checked-in config. A malformed file fails loud. */
export function loadLlmRoutingConfig(raw: unknown = rawConfig): LlmRoutingConfig {
  return routingConfigSchema.parse(raw);
}

/**
 * The configured target a reason names, gated by the same rules routeRequest applies.
 * Used by the run path to resolve a decision's modelId back to its provider.
 */
export function routingTargetFor(
  config: LlmRoutingConfig,
  reason: LlmRouteReason,
): LlmRoutingTarget | null {
  switch (reason) {
    case "pii":
      return config.cdr;
    case "research":
      return config.freeLocal;
    case "image-video":
      // The ceiling condition is the spend gate: no capped target, no KIE.ai.
      return config.imageVideo?.enabled && config.imageVideo.ceilingUsd !== null
        ? config.imageVideo
        : null;
    case "code":
      return config.code;
    default:
      return null;
  }
}

const EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u;
const PHONE_PATTERN =
  /(?<!\d)(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/;
const SSN_PATTERN = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/;
// A card number needs the Luhn check below; 16 arbitrary digits are just an id.
const CARD_CANDIDATE = /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g;

const RESEARCH_PATTERN =
  /\b(?:research|investigate|explore|exploration|look\s+up|find\s+out|deep\s+dive|how\s+does|how\s+do|why\s+does|why\s+do|learn\s+about)\b/i;
const IMAGE_VIDEO_PATTERN =
  /\b(?:generate|create|make|draw|render|design|edit|turn|transform)\b[^.\n]{0,40}\b(?:image|picture|photo|illustration|drawing|video|clip|animation|logo|poster)\b/i;
const CODE_PATTERN =
  /\b(?:code|function|class|script|bug|refactor|debug|typescript|javascript|python|sql|regex|unit\s+tests?|pull\s+request)\b/i;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let doubled = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (doubled) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    doubled = !doubled;
  }
  return sum % 10 === 0;
}

function containsCardNumber(text: string): boolean {
  for (const match of text.matchAll(CARD_CANDIDATE)) {
    const digits = match[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  return false;
}

/** Personal data that must never take the default hosted path. */
export function containsPersonalData(text: string): boolean {
  return (
    EMAIL_PATTERN.test(text) ||
    PHONE_PATTERN.test(text) ||
    SSN_PATTERN.test(text) ||
    containsCardNumber(text)
  );
}

function requestText(request: LlmRouteRequest): string {
  return [request.prompt ?? "", ...(request.history ?? []).map((turn) => turn.content)].join("\n");
}

function keep(model: LlmRouteModel, reason: LlmRouteReason): LlmRouteDecision {
  return { modelId: model.id, reason };
}

/**
 * Decide which model a request belongs to. Pure: the same request and config always
 * produce the same decision, and an unclassified request keeps the current model.
 */
export function routeRequest(request: LlmRouteRequest, config: LlmRoutingConfig): LlmRouteDecision {
  if (!config.enabled) return keep(request.model, "default");
  const text = requestText(request);
  if (containsPersonalData(text)) {
    const cdr = routingTargetFor(config, "pii");
    if (!cdr) {
      throw new Error(
        "PII-bearing request but no CDR model is configured in llm-routing-config.json; refusing the default model",
      );
    }
    return { modelId: cdr.modelId, reason: "pii" };
  }
  if (RESEARCH_PATTERN.test(text)) {
    const freeLocal = routingTargetFor(config, "research");
    return freeLocal
      ? { modelId: freeLocal.modelId, reason: "research" }
      : keep(request.model, "research");
  }
  if (IMAGE_VIDEO_PATTERN.test(text)) {
    const vendor = routingTargetFor(config, "image-video");
    return vendor
      ? { modelId: vendor.modelId, reason: "image-video" }
      : keep(request.model, "image-video");
  }
  if (CODE_PATTERN.test(text)) {
    const code = routingTargetFor(config, "code");
    return code ? { modelId: code.modelId, reason: "code" } : keep(request.model, "code");
  }
  return keep(request.model, "default");
}
