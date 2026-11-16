import { ORPCError } from "@orpc/server";

/**
 * The deployment's model-connection policy (ME_MODEL_POLICY).
 *
 * `house_only` means the deployment runs the intelligence on its own key: no path may
 * create or update a user model connection, and every path refuses with the named 403
 * before any write (D-RUN-8). Empty means the rule is off and connections work as upstream.
 */
export const MODEL_POLICY_HOUSE_ONLY = "house_only";
export type ModelPolicy = "" | typeof MODEL_POLICY_HOUSE_ONLY;

export const MODEL_POLICY_ENV = "ME_MODEL_POLICY";

/** Reads the policy from deployment config; any other value fails the deployment at boot. */
export function parseModelPolicy(value: string | undefined): ModelPolicy {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  if (trimmed === MODEL_POLICY_HOUSE_ONLY) return MODEL_POLICY_HOUSE_ONLY;
  throw new Error(`${MODEL_POLICY_ENV} must be empty or ${MODEL_POLICY_HOUSE_ONLY}`);
}

/**
 * The refusal carries the policy name, so an operator can see which rule refused and a
 * person sees why their key was not saved.
 */
export const MODEL_CONNECTION_REFUSED_MESSAGE =
  "This deployment runs house models only and does not accept user model keys (model_policy_house_only).";

/** The one guard every model-connection write consults before any write happens. */
export function assertModelConnectionWriteAllowed(modelPolicy: string | undefined): void {
  if (modelPolicy === MODEL_POLICY_HOUSE_ONLY)
    throw new ORPCError("FORBIDDEN", { message: MODEL_CONNECTION_REFUSED_MESSAGE });
}
