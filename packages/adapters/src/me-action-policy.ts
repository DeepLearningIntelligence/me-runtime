import type { ActionApprovalRule } from "@rakazo/core";

/**
 * The fork's deployment action policy (D-RUN-12): money stays out of the me.io build.
 *
 * `request_purchase` is denied at the policy evaluation point for every execution path
 * (chat, routine, subagent, API-triggered runs), not merely hidden from the UI. Upstream
 * has no operator switch for a deployment-level tool deny: the tool is approval-exempt
 * because the wallet owner approves in the wallet, and the wallet is out of scope here
 * entirely, so config cannot express the rule. The rules below ride on every load of a
 * space's saved rules (createRunTrustLoaders, routine-watch), where the existing deny
 * machinery refuses: a deny always wins, no approval mode or saved rule can pass it, and
 * the refusal names the rule like any saved one.
 *
 * Details and tests: FORK.d/G.md.
 */
export const DEPLOYMENT_DENIED_TOOLS: readonly string[] = ["request_purchase"];

/** The deny rules the deployment evaluates beside every space's saved rules. */
export function deploymentDenyRules(): ActionApprovalRule[] {
  return DEPLOYMENT_DENIED_TOOLS.map((matchValue) => ({
    effect: "deny" as const,
    matchKind: "tool" as const,
    matchValue,
  }));
}
