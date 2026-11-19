import { composioToolkitId, connectorAllowlistAllows } from "@rakazo/adapters/connector-allowlist";
import { GFIN_MCP_URL } from "@rakazo/adapters/gfin-endpoint";
import type { MessageBlock } from "@rakazo/contracts";

type AppConnectBlock = Extract<MessageBlock, { kind: "app_connect" }>;

/** A stable empty policy, so a missing prop never forces a memoized message to rerender. */
export const NO_CONNECTOR_ALLOWLIST: readonly string[] = [];

/**
 * Whether this client may show a connect card. The server also refuses these at the
 * catalog and begin routes; this check keeps cards already in old threads from becoming
 * dead doors. Unset allowlist means none, never all. The GFIN server is provisioned for
 * everyone, so a card asking to connect it is a duplicate door.
 */
export function appConnectCardVisible(
  block: AppConnectBlock,
  connectorAllowlist: readonly string[],
): boolean {
  if (isProvisionedGfinEndpoint(block.endpoint)) return false;
  const connectorId = block.connectorId ?? "composio";
  // An MCP app_connect card names its server as the provider, not a Composio toolkit.
  return connectorId === "composio"
    ? connectorAllowlistAllows(connectorAllowlist, connectorId, composioToolkitId(block.provider))
    : true;
}

/** The Go Fund It Now server is provisioned for everyone, so no card may ask to connect it. */
export function isProvisionedGfinEndpoint(endpoint: string | null | undefined): boolean {
  return endpoint?.trim() === GFIN_MCP_URL;
}
