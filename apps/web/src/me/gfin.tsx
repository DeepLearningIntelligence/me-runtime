import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { McpServer, McpServerConnection } from "@rakazo/contracts";
import { mcpServerConnection } from "@rakazo/contracts";
import { SectionHeading } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../lib/query";

/**
 * The workspace's Go Fund It Now connection. The slug is the contract with the
 * fork's connection module (`GFIN_CONNECTION_SLUG` in packages/adapters): the
 * connection is created and re-keyed there, labelled "Go Fund It Now (public
 * search)" until per-person provisioning is live, and never shown with its key.
 */
export function gfinConnections(servers: readonly McpServer[]): McpServer[] {
  return servers.filter((server) => server.slug === "gfin");
}

/** One word per connection state; the vault never explains more than the state. */
export function connectionWords(state: McpServerConnection): string {
  switch (state) {
    case "connected":
      return t`Connected`;
    case "not_connected":
      return t`Not connected`;
    case "disabled":
      return t`Off`;
    case "needs_sign_in":
      return t`Sign-in needed`;
    case "needs_client":
      return t`Not working`;
    case "not_working":
      return t`Not working`;
  }
}

/**
 * The vault's Go Fund It Now block: the connection exists, its state is current,
 * and the key is never shown. The credential lives in the encrypted secret
 * store, so there is nothing to reveal and no row to edit here.
 */
export function GfinVaultBlock() {
  const queries = useSpaceQueries();
  const serversQuery = useQuery(queries.mcp.servers.list.queryOptions());
  if (serversQuery.isPending) return null;
  if (serversQuery.isError) {
    // A failed read is not an empty vault: the person sees why the block is bare.
    return (
      <section data-testid="vault-gfin" className="space-y-2">
        <SectionHeading variant="label">
          <Trans>Go Fund It Now</Trans>
        </SectionHeading>
        <p className="text-body-sm text-destructive">
          <Trans>Could not load the connection.</Trans>
        </p>
      </section>
    );
  }
  const connections = gfinConnections(serversQuery.data);
  if (connections.length === 0) return null;
  return (
    <section data-testid="vault-gfin" className="space-y-2">
      <SectionHeading variant="label">
        <Trans>Go Fund It Now</Trans>
      </SectionHeading>
      <ul className="divide-y divide-border overflow-hidden rounded-xl bg-muted/50">
        {connections.map((server) => (
          <li key={server.id} className="px-3.5 py-2.5">
            <span className="block truncate text-body font-medium text-foreground">
              {server.name}
            </span>
            <span className="block truncate text-body-sm text-muted-foreground">
              {connectionWords(mcpServerConnection(server))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
