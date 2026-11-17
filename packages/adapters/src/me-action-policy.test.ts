import type { ActionApprovalRule } from "@rakazo/core";
import {
  approvalModeFromPreference,
  approvalRuleLabel,
  decisiveActionApprovalRules,
  planActionGate,
  resolveActionApproval,
  resolveActionApprovalForTools,
  watchToolRefusal,
} from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { deploymentDenyRules } from "./me-action-policy.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";

const deploymentRules = deploymentDenyRules();

// What a person may have saved: an always-allow for the tool must not punch through
// the deployment's deny, and its absence must change the decision (mutation proof).
const savedAlwaysAllow: ActionApprovalRule[] = [
  { effect: "always_allow", matchKind: "tool", matchValue: "request_purchase" },
];

describe("deployment action policy (me-action-policy)", () => {
  it("denies request_purchase at the evaluator and names the rule", () => {
    const resolved = resolveActionApprovalForTools({
      tools: [{ name: "request_purchase" }],
      rules: [...deploymentRules, ...savedAlwaysAllow],
    });
    expect(resolved.decision).toBe("deny");
    const decisive = decisiveActionApprovalRules(resolved);
    expect(decisive).toEqual(deploymentRules);
    // The same composition run-tool-gate's refusal shows: "blocked ... by the saved
    // rule <label>". The rule the refusal names is the deployment's, not the person's.
    expect(decisive.map(approvalRuleLabel)).toEqual(["Request purchase"]);
  });

  it("refuses in every approval mode; a person's never-ask or auto setting cannot override it", () => {
    const resolved = resolveActionApprovalForTools({
      tools: [{ name: "request_purchase" }],
      rules: [...deploymentRules, ...savedAlwaysAllow],
    });
    for (const preference of [
      { enabled: false, skipApprovals: true },
      { enabled: true, skipApprovals: false },
      { enabled: false, skipApprovals: false },
    ]) {
      expect(
        planActionGate({
          resolved,
          mode: approvalModeFromPreference(preference),
          consequential: true,
          checkerConfigured: true,
          purchase: true,
        }),
      ).toBe("deny");
    }
  });

  it("refuses a watch on the denied tool", () => {
    expect(
      watchToolRefusal({ toolName: "request_purchase", readOnly: true, rules: deploymentRules }),
    ).toBe("request_purchase is blocked, so a change trigger can't run it.");
  });

  it("without the deployment rule the evaluator allows the action, so the denial is the rule", () => {
    // Mutation baseline: emptying DEPLOYMENT_DENIED_TOOLS makes this the live branch.
    expect(resolveActionApproval({ toolName: "request_purchase", rules: savedAlwaysAllow })).toBe(
      "allow",
    );
    expect(resolveActionApproval({ toolName: "request_purchase", rules: [] })).toBe("allow");
  });

  it("offers no purchase tool on any run without a configured wallet (hidden, and denied besides)", () => {
    const ownerChat = {
      historyRetrievalEnabled: true,
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
    } as const;
    expect(
      selectBuiltinToolsForRun(ownerChat)
        .map((tool) => tool.name)
        .filter((name) => name === "request_purchase"),
    ).toEqual([]);
    // The deny does not depend on the hiding: with a wallet configured, the offered
    // tool is still refused at the evaluator.
    expect(
      resolveActionApproval({
        toolName: "request_purchase",
        rules: [...deploymentRules],
      }),
    ).toBe("deny");
  });

  it("rides on every load of a space's approval rules", async () => {
    const saved: ActionApprovalRule[] = savedAlwaysAllow.map((rule) => ({ ...rule }));
    vi.resetModules();
    vi.doMock("@rakazo/db", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      listApprovalRules: vi.fn(async () => saved),
    }));
    const { createRunTrustLoaders: fresh } = await import("./run-trust.js");
    const trust = fresh({} as never, {
      run: { userId: "u1", spaceId: "s1", trigger: "user" },
      runId: "r1",
      botId: "b1",
      taskPrompt: "",
      ownerStartedRun: true,
      messagingChannelRun: false,
      sourceMessage: null,
      connectedPlugins: [],
    });
    expect(await trust.loadApprovalRules()).toEqual([...deploymentRules, ...saved]);
    vi.doUnmock("@rakazo/db");
    vi.resetModules();
  });
});
