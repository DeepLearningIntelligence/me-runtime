import { t } from "@lingui/core/macro";
import {
  connectorCardAllowed,
  isProvisionedGfinEndpoint,
} from "@rakazo/adapters/connector-allowlist";
import type { ConnectorPolicy, MessageBlock } from "@rakazo/contracts";

export type AppConnectBlock = Extract<MessageBlock, { kind: "app_connect" }>;
export type McpApprovalBlock = Extract<MessageBlock, { kind: "mcp_approval" }>;

/** Cards a person may act on: denied connectors and the provisioned GFIN server are hidden. */
export function offeredAppConnectBlocks(
  blocks: readonly MessageBlock[],
  policy: ConnectorPolicy,
): AppConnectBlock[] {
  return blocks.filter(
    (block): block is AppConnectBlock =>
      block.kind === "app_connect" && connectorCardAllowed(policy, block),
  );
}

export function offeredMcpApprovalBlocks(blocks: readonly MessageBlock[]): McpApprovalBlock[] {
  return blocks.filter(
    (block): block is McpApprovalBlock =>
      block.kind === "mcp_approval" && !isProvisionedGfinEndpoint(block.endpoint),
  );
}

export function appConnectPresentation(block: AppConnectBlock, busy = false) {
  const connected = block.status === "connected";
  return {
    title: block.name,
    description: block.description,
    showAuthorize: !connected,
    actionLabel: connected ? t`Connected` : busy ? t`Waiting…` : t`Connect`,
    connected,
  };
}
