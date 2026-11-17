import type {
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorRoute,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";

/**
 * The deployment-managed Go Fund It Now connection (D-RUN-9 of the me-runtime brief).
 *
 * One authority: the closed tool set and the org_id refusal live here, so every process
 * that can call an MCP tool (the API and the worker compose this connector) enforces the
 * same rule. The connection row itself is provisioned by the API's account hook; the
 * label it carries is decided here too, because the degraded public-search path is a
 * named product state, not a hidden fallback.
 */

/** The slug of the provisioned connection. Tool routes carry it as `catalogGroup`. */
export const GFIN_CONNECTION_SLUG = "gfin";

/** The MCP endpoint the connection points at until per-person provisioning (GFIN G3). */
export const GFIN_MCP_URL = "https://app.gofunditnow.com/api/mcp";

/** The only tools the house key may reach: GFIN's public read-only search. */
export const GFIN_PUBLIC_TOOLS = ["search_opportunities", "get_opportunity"] as const;

/**
 * The visible degraded path: until a per-person `gfin_` key exists, the connection is
 * labelled exactly this, in the portal and in every thread that uses it.
 */
export const GFIN_PUBLIC_LABEL = "Go Fund It Now (public search)";
export const GFIN_PUBLIC_DESCRIPTION = "Searches Go Fund It Now's public opportunities.";
export const GFIN_PERSONAL_LABEL = "Go Fund It Now";
export const GFIN_PERSONAL_DESCRIPTION = "Searches your Go Fund It Now organisation.";

/** A per-person provisioning key always starts with this prefix; anything else is malformed. */
export const GFIN_PERSONAL_KEY_PREFIX = "gfin_";

export const GFIN_TOOL_REFUSAL =
  "This Go Fund It Now connection offers public search only; that tool is not available (gfin_tool_not_allowed).";
export const GFIN_ORG_ID_REFUSAL = "This connection does not accept org_id (gfin_org_id_refused).";
export const GFIN_KEY_MALFORMED =
  "The Go Fund It Now provisioning response did not include a valid personal key (gfin_key_malformed).";

/** The closed set one connection must serve, enforced in every process. */
export interface ToolGuardSpec {
  slug: string;
  allowedTools: readonly string[];
  /** Argument keys this connection never accepts, at any depth of the arguments. */
  blockedArgKeys: readonly string[];
  toolRefusal: string;
  argRefusal: string;
}

export const GFIN_TOOL_GUARD: ToolGuardSpec = {
  slug: GFIN_CONNECTION_SLUG,
  allowedTools: GFIN_PUBLIC_TOOLS,
  blockedArgKeys: ["org_id"],
  toolRefusal: GFIN_TOOL_REFUSAL,
  argRefusal: GFIN_ORG_ID_REFUSAL,
};

/** The first blocked key found anywhere inside the arguments, or undefined. */
export function findBlockedArgKey(
  value: unknown,
  blocked: readonly string[],
  depth = 8,
): string | undefined {
  if (depth <= 0 || value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findBlockedArgKey(item, blocked, depth - 1);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (blocked.includes(key)) return key;
    const found = findBlockedArgKey(child, blocked, depth - 1);
    if (found) return found;
  }
  return undefined;
}

/** Why the guard refuses this call before any request is made, or undefined to allow it. */
export function guardedToolRefusal(
  toolName: string,
  args: Record<string, unknown>,
  guard: ToolGuardSpec,
): string | undefined {
  if (!guard.allowedTools.includes(toolName)) return guard.toolRefusal;
  const blocked = findBlockedArgKey(args, guard.blockedArgKeys);
  return blocked ? guard.argRefusal : undefined;
}

const isGuardedRoute = (route: ConnectorRoute | undefined, guard: ToolGuardSpec): boolean =>
  route?.catalogGroup === guard.slug;

/**
 * Wraps one connector provider so its tools for `guard.slug` serve only `allowedTools`
 * and refuse calls carrying a blocked argument key, before any request leaves. Other
 * servers pass through untouched. Tool calls a lazy catalog resolved keep their route,
 * so they meet the same refusal here.
 */
export function guardConnectorTools(
  inner: ConnectorProvider,
  guard: ToolGuardSpec,
): ConnectorProvider {
  const refusalFor = (route: ConnectorRoute | undefined, toolName: string, args: unknown) => {
    if (!isGuardedRoute(route, guard)) return undefined;
    const refusal = guardedToolRefusal(toolName, (args ?? {}) as Record<string, unknown>, guard);
    if (refusal)
      getLogger().warn("gfin connector tool refused", {
        "gfin.tool": toolName,
        "gfin.reason": refusal.match(/\((gfin_[a-z_]+)\)/)?.[1] ?? "unknown",
      });
    return refusal;
  };
  return {
    describe: () => inner.describe(),
    discoverTools: async (context) => {
      const tools = await inner.discoverTools(context);
      return tools.filter(
        (tool: ConnectorTool) =>
          !isGuardedRoute(tool.route, guard) ||
          guard.allowedTools.includes(routeToolName(tool, guard)),
      );
    },
    resolveCall: inner.resolveCall
      ? async (call, context) => {
          const refusal = refusalFor(call.route, routeCallToolName(call), call.args);
          if (refusal) return undefined;
          return (await inner.resolveCall?.(call, context)) ?? undefined;
        }
      : undefined,
    execute: async function* (call, context): AsyncIterable<ConnectorEvent> {
      const refusal = refusalFor(call.route, routeCallToolName(call), call.args);
      if (refusal) {
        yield { type: "error", message: refusal };
        return;
      }
      yield* inner.execute(call, context);
    },
    endRun: inner.endRun ? (runId: string) => inner.endRun?.(runId) : undefined,
  };
}

function routeToolName(tool: ConnectorTool, guard: ToolGuardSpec): string {
  return tool.route?.toolName ?? tool.name.replace(`mcp__${guard.slug}__`, "");
}

function routeCallToolName(call: ConnectorCall): string {
  return call.route?.toolName ?? call.tool;
}

/** The deployment's Go Fund It Now connection settings, or undefined when it is off. */
export interface GfinConnectionConfig {
  mcpUrl: string;
  /** The house key behind the labelled public-search connection. */
  houseKey?: string;
  /** The server-to-server provisioning endpoint (GFIN G3) that returns per-person keys. */
  provision?: { url: string; token: string };
}

/**
 * Reads the connection settings. Both provisioning values arrive together or the
 * deployment fails at boot, so a typo never silently disables the personal path.
 */
export function parseGfinConnectionEnv(
  source: NodeJS.ProcessEnv,
): GfinConnectionConfig | undefined {
  const mcpUrl = source.ME_GFIN_MCP_URL?.trim() || GFIN_MCP_URL;
  const houseKey = source.ME_GFIN_HOUSE_KEY?.trim() || undefined;
  const url = source.ME_GFIN_PROVISION_URL?.trim() || undefined;
  const token = source.ME_GFIN_PROVISION_TOKEN?.trim() || undefined;
  if (url && !token)
    throw new Error("Set ME_GFIN_PROVISION_TOKEN together with ME_GFIN_PROVISION_URL");
  if (token && !url)
    throw new Error("Set ME_GFIN_PROVISION_URL together with ME_GFIN_PROVISION_TOKEN");
  if (!houseKey && !url) return undefined;
  return { mcpUrl, houseKey, provision: url && token ? { url, token } : undefined };
}
