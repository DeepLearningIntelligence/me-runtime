import { describe, expect, it } from "vitest";
import type { LlmRouteRequest, LlmRoutingConfig } from "./llm-routing.js";
import { loadLlmRoutingConfig, routeRequest } from "./llm-routing.js";

const current = { provider: "openrouter", id: "default-model" };

const request = (prompt: string, history: LlmRouteRequest["history"] = []): LlmRouteRequest => ({
  model: current,
  prompt,
  history,
});

const config = (overrides: Partial<LlmRoutingConfig> = {}): LlmRoutingConfig => ({
  enabled: true,
  cdr: { provider: "cdr", modelId: "cdr-model" },
  freeLocal: { provider: "local", modelId: "local-model" },
  imageVideo: {
    provider: "kie",
    modelId: "kie-model",
    enabled: false,
    ceilingUsd: null,
  },
  code: null,
  ...overrides,
});

describe("routeRequest", () => {
  it("keeps the current model while routing is off, even for classified text", () => {
    const off = config({ enabled: false });
    for (const prompt of [
      "email me at person@example.com",
      "research the best laptops",
      "generate an image of a cat",
      "fix the bug in this function",
    ]) {
      expect(routeRequest(request(prompt), off)).toEqual({
        modelId: "default-model",
        reason: "default",
      });
    }
  });

  it("routes PII-bearing requests to the CDR model", () => {
    expect(routeRequest(request("reach me at person@example.com"), config())).toEqual({
      modelId: "cdr-model",
      reason: "pii",
    });
    expect(routeRequest(request("my number is (555) 123-4567"), config())).toEqual({
      modelId: "cdr-model",
      reason: "pii",
    });
    expect(routeRequest(request("ssn 123-45-6789"), config())).toEqual({
      modelId: "cdr-model",
      reason: "pii",
    });
    expect(routeRequest(request("card 4111 1111 1111 1111"), config())).toEqual({
      modelId: "cdr-model",
      reason: "pii",
    });
  });

  it("refuses PII when no CDR model is configured instead of using the default", () => {
    expect(() => routeRequest(request("person@example.com"), config({ cdr: null }))).toThrow(
      /no CDR model is configured/,
    );
  });

  it("routes research and exploration to the free local model", () => {
    expect(routeRequest(request("research the best laptops this year"), config())).toEqual({
      modelId: "local-model",
      reason: "research",
    });
    expect(routeRequest(request("look up how does a heat pump work"), config())).toEqual({
      modelId: "local-model",
      reason: "research",
    });
    expect(
      routeRequest(
        request("and how does that compare?", [{ role: "user", content: "explore heat pumps" }]),
        config(),
      ),
    ).toEqual({
      modelId: "local-model",
      reason: "research",
    });
  });

  it("keeps image and video on the default model while KIE.ai is off", () => {
    expect(routeRequest(request("generate an image of a cat"), config())).toEqual({
      modelId: "default-model",
      reason: "image-video",
    });
  });

  it("still refuses KIE.ai when it is enabled without a ceiling", () => {
    const noCeiling = config({
      imageVideo: { provider: "kie", modelId: "kie-model", enabled: true, ceilingUsd: null },
    });
    expect(routeRequest(request("make a video of a sunset"), noCeiling)).toEqual({
      modelId: "default-model",
      reason: "image-video",
    });
  });

  it("routes image and video to KIE.ai only when enabled with a ceiling", () => {
    const capped = config({
      imageVideo: { provider: "kie", modelId: "kie-model", enabled: true, ceilingUsd: 0.5 },
    });
    expect(routeRequest(request("make a video of a sunset"), capped)).toEqual({
      modelId: "kie-model",
      reason: "image-video",
    });
  });

  it("keeps code on the default model, or a deliberately configured one", () => {
    expect(routeRequest(request("fix the bug in this function"), config())).toEqual({
      modelId: "default-model",
      reason: "code",
    });
    expect(
      routeRequest(
        request("refactor this python script"),
        config({ code: { provider: "openrouter", modelId: "code-model" } }),
      ),
    ).toEqual({ modelId: "code-model", reason: "code" });
  });

  it("keeps anything unclassified on the current model", () => {
    expect(routeRequest(request("hello there, what is your name?"), config())).toEqual({
      modelId: "default-model",
      reason: "default",
    });
  });

  it("ships disabled, with KIE.ai off and no CDR target", () => {
    const shipped = loadLlmRoutingConfig();
    expect(shipped.enabled).toBe(false);
    expect(shipped.imageVideo).toMatchObject({ provider: "kie", enabled: false, ceilingUsd: null });
    expect(routeRequest(request("person@example.com"), shipped)).toEqual({
      modelId: "default-model",
      reason: "default",
    });
  });

  it("rejects a malformed config instead of guessing", () => {
    expect(() => loadLlmRoutingConfig({ enabled: "yes" })).toThrow();
  });
});
