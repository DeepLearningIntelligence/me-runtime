import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import type { ConnectorPolicy } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import type { ComposioProvider } from "./composio-connector.js";
import { sanitizeIntegrationError } from "./composio-connector.js";
import {
  COMPOSIO_CONNECTOR_ID,
  ConnectorNotAllowedError,
  composioCallToolkits,
  composioToolkitId,
  isComposioMetaTool,
  connectorAllowed,
  connectorNotAllowedRefusal,
  DEFAULT_CONNECTOR_POLICY,
} from "./connector-allowlist.js";

export class ConnectorRegistry implements ConnectorProvider {
  private readonly providers = new Map<string, ConnectorProvider>();
  private readonly offeredProviders = new Map<string, ConnectorProvider>();
  private readonly policy: ConnectorPolicy;

  constructor(
    providers: ConnectorProvider[],
    connectorPolicy: ConnectorPolicy = DEFAULT_CONNECTOR_POLICY,
  ) {
    this.policy = connectorPolicy;
    for (const provider of providers) {
      const id = provider.describe().id;
      if (this.providers.has(id)) throw new Error(`Duplicate connector id ${id}`);
      this.providers.set(id, provider);
      this.offeredProviders.set(id, allowlistedProvider(provider, connectorPolicy));
    }
  }

  managedProviders(): ManagedConnectorProvider[] {
    return [...this.offeredProviders.values()].filter(isManagedConnectorProvider);
  }

  managed(id: string): ManagedConnectorProvider | undefined {
    const provider = this.providers.get(id);
    return provider && isManagedConnectorProvider(provider) ? provider : undefined;
  }

  /** Release run-scoped state of every provider that keeps it. */
  endRun(runId: string): void {
    for (const provider of this.providers.values()) provider.endRun?.(runId);
  }

  describe() {
    return {
      id: "connector-registry",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const discovered: ConnectorTool[] = [];
    const used = new Set<string>();
    const providerTools = await Promise.all(
      [...this.providers].map(async ([connectorId, provider]) => {
        try {
          return [
            connectorId,
            allowlistedTools(this.policy, connectorId, await provider.discoverTools(context)),
          ] as const;
        } catch (error) {
          getLogger().error("connector discovery failed", sanitizeIntegrationError(error), {
            "connector.id": connectorId,
          });
          return [connectorId, []] as const;
        }
      }),
    );
    for (const [connectorId, tools] of providerTools) {
      for (const tool of tools) {
        let name = tool.name;
        if (used.has(name)) name = `${connectorId}.${name}`;
        let suffix = 2;
        while (used.has(name)) {
          name = `${connectorId}.${tool.name}.${suffix}`;
          suffix += 1;
        }
        used.add(name);
        discovered.push({
          ...tool,
          name,
          route: tool.route ?? { connectorId, toolName: tool.name },
        });
      }
    }
    return discovered;
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    const connectorId = call.route?.connectorId ?? COMPOSIO_CONNECTOR_ID;
    const denied = deniedComposioToolkit(this.policy, call);
    if (denied) {
      yield { type: "error", message: connectorNotAllowedRefusal(denied) };
      return;
    }
    const provider = this.providers.get(connectorId);
    if (!provider) {
      yield { type: "error", message: connectorNotAllowedRefusal(connectorId) };
      return;
    }
    const connectionId = call.route?.connectionId ?? call.connectionId;
    if (
      connectionId &&
      !context.connectedConnections?.some(
        (connection) => connection.id === connectionId && connection.connectorId === connectorId,
      )
    ) {
      yield { type: "error", message: "The selected connected account is unavailable." };
      return;
    }
    const scopedContext = connectionId
      ? {
          ...context,
          connectedConnections: context.connectedConnections!.filter(
            (connection) =>
              connection.id === connectionId && connection.connectorId === connectorId,
          ),
          connectedProviders: undefined,
        }
      : context;
    yield* provider.execute(
      { ...call, connectionId, tool: call.route?.toolName ?? call.tool },
      scopedContext,
    );
  }

  async resolveCall(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined> {
    const connectorId = call.route?.connectorId;
    if (!connectorId) {
      for (const provider of this.providers.values()) {
        const resolved = await provider.resolveCall?.(call, context);
        if (resolved) return resolved;
      }
      return undefined;
    }
    if (deniedComposioToolkit(this.policy, call)) return undefined;
    const provider = this.providers.get(connectorId);
    return provider?.resolveCall?.({ ...call, tool: call.route?.toolName ?? call.tool }, context);
  }
}

function allowsTool(policy: ConnectorPolicy, toolName: string): boolean {
  // A meta-tool carries no app. Narrowing apps must not remove discovery and dispatch, and
  // every nested call inside a multi-execute is checked by its own toolkit below.
  if (isComposioMetaTool(toolName)) return true;
  return connectorAllowed(policy, COMPOSIO_CONNECTOR_ID, composioToolkitId(toolName));
}

function allowlistedTools(
  policy: ConnectorPolicy,
  connectorId: string,
  tools: ConnectorTool[],
): ConnectorTool[] {
  if (connectorId !== COMPOSIO_CONNECTOR_ID) return tools;
  return tools.filter((tool) => allowsTool(policy, tool.name));
}

function deniedComposioToolkit(policy: ConnectorPolicy, call: ConnectorCall): string | undefined {
  if ((call.route?.connectorId ?? COMPOSIO_CONNECTOR_ID) !== COMPOSIO_CONNECTOR_ID)
    return undefined;
  const toolkits = composioCallToolkits(call);
  // No toolkit means a meta-tool call with nothing nested: discovery or a bare dispatch.
  // Its execution still needs a connected account, and nested calls are checked below.
  if (toolkits.length === 0) return undefined;
  return toolkits.find((toolkitId) => !connectorAllowed(policy, COMPOSIO_CONNECTOR_ID, toolkitId));
}

function allowlistedProvider(
  provider: ConnectorProvider,
  policy: ConnectorPolicy,
): ConnectorProvider {
  if (provider.describe().id !== COMPOSIO_CONNECTOR_ID || !isManagedConnectorProvider(provider)) {
    return provider;
  }
  return new AllowlistedManagedConnector(provider, policy);
}

/** Filter the catalog and refuse begin before an authorization window can open. */
class AllowlistedManagedConnector implements ManagedConnectorProvider {
  readonly listReconnectRefs?: ManagedConnectorProvider["listReconnectRefs"];
  readonly warmDirectory?: ManagedConnectorProvider["warmDirectory"];
  readonly resolveConnectedAccountId?: ManagedConnectorProvider["resolveConnectedAccountId"];
  readonly cancelAuthorizationRequest?: ManagedConnectorProvider["cancelAuthorizationRequest"];
  readonly revokeUnreferencedAccounts?: ManagedConnectorProvider["revokeUnreferencedAccounts"];
  readonly endRun?: ConnectorProvider["endRun"];

  constructor(
    private readonly inner: ManagedConnectorProvider,
    private readonly policy: ConnectorPolicy,
  ) {
    this.listReconnectRefs = inner.listReconnectRefs?.bind(inner);
    this.warmDirectory = inner.warmDirectory?.bind(inner);
    this.resolveConnectedAccountId = inner.resolveConnectedAccountId?.bind(inner);
    this.cancelAuthorizationRequest = inner.cancelAuthorizationRequest?.bind(inner);
    this.revokeUnreferencedAccounts = inner.revokeUnreferencedAccounts?.bind(inner);
    this.endRun = inner.endRun?.bind(inner);
  }

  describe() {
    return this.inner.describe();
  }

  async catalog(context: AdapterContext, query?: string) {
    const items = await this.inner.catalog(context, query);
    return items.filter((item) =>
      connectorAllowed(this.policy, this.inner.describe().id, item.slug),
    );
  }

  async discoverTools(context: AdapterContext) {
    return allowlistedTools(this.policy, this.inner.describe().id, [
      ...(await this.inner.discoverTools(context)),
    ]);
  }

  resolveCall(call: ConnectorCall, context: AdapterContext) {
    return this.inner.resolveCall?.(call, context) ?? Promise.resolve(undefined);
  }

  execute(call: ConnectorCall, context: AdapterContext) {
    return this.inner.execute(call, context);
  }

  async begin(request: Parameters<ManagedConnectorProvider["begin"]>[0], context: AdapterContext) {
    if (connectorAllowed(this.policy, this.inner.describe().id, request.provider)) {
      return this.inner.begin(request, context);
    }
    throw new ConnectorNotAllowedError(request.provider);
  }

  complete(request: Parameters<ManagedConnectorProvider["complete"]>[0], context: AdapterContext) {
    return this.inner.complete(request, context);
  }

  revoke(ref: string, context: AdapterContext) {
    return this.inner.revoke(ref, context);
  }

  connectionReady(context: AdapterContext, externalId: string) {
    return this.inner.connectionReady(context, externalId);
  }

  listConnectedExternalIds(context: AdapterContext) {
    return this.inner.listConnectedExternalIds(context);
  }
}

function isManagedConnectorProvider(
  provider: ConnectorProvider,
): provider is ManagedConnectorProvider {
  const candidate = provider as Partial<ManagedConnectorProvider>;
  return (
    typeof candidate.catalog === "function" &&
    typeof candidate.begin === "function" &&
    typeof candidate.complete === "function" &&
    typeof candidate.connectionReady === "function" &&
    typeof candidate.listConnectedExternalIds === "function" &&
    typeof candidate.revoke === "function"
  );
}

export function createConnectorStack(
  composio: ComposioProvider | undefined,
  providers: ConnectorProvider[] = [],
  connectorPolicy: ConnectorPolicy = DEFAULT_CONNECTOR_POLICY,
) {
  return {
    composio,
    connector: new ConnectorRegistry(
      [...(composio ? [composio] : []), ...providers],
      connectorPolicy,
    ),
  };
}
