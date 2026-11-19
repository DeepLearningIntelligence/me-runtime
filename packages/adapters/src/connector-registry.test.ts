import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { ConnectorRegistry, createConnectorStack } from "./connector-registry.js";

class StubConnector implements ConnectorProvider {
  calls: ConnectorCall[] = [];
  contexts: AdapterContext[] = [];

  constructor(
    private readonly id: string,
    private readonly tools: ConnectorTool[],
  ) {}

  describe() {
    return {
      id: this.id,
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { discover: true, oauth: false, secretsBrokered: false },
    };
  }

  async discoverTools() {
    return this.tools;
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    this.calls.push(call);
    this.contexts.push(context);
    yield { type: "result", data: { connector: this.id, tool: call.tool } };
  }
}

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

describe("ConnectorRegistry", () => {
  it("scopes any provider to the connection selected by its tool route", async () => {
    const provider = new StubConnector("example", [tool("read")]);
    const registry = new ConnectorRegistry([provider]);
    const connections = ["first", "second"].map((id) => ({
      id,
      connectorId: "example",
      externalId: "mail",
      displayName: id,
    }));
    for await (const _event of registry.execute(
      {
        tool: "read",
        args: {},
        executionId: "test",
        route: { connectorId: "example", toolName: "read", connectionId: "second" },
      },
      { ...context, connectedConnections: connections },
    )) {
      /* drain */
    }
    expect(provider.calls[0]?.connectionId).toBe("second");
    expect(provider.contexts[0]?.connectedConnections).toEqual([connections[1]]);
    expect(connections).toHaveLength(2);
  });

  it("rejects account routes outside the run or owned by a different connector", async () => {
    const provider = new StubConnector("example", [tool("read")]);
    const registry = new ConnectorRegistry([provider]);
    for (const connections of [
      [],
      [{ id: "account", connectorId: "other", externalId: "mail", displayName: "Other" }],
    ]) {
      const events = [];
      for await (const event of registry.execute(
        {
          tool: "read",
          args: {},
          executionId: "test",
          route: { connectorId: "example", toolName: "read", connectionId: "account" },
        },
        { ...context, connectedConnections: connections },
      ))
        events.push(event);
      expect(events).toEqual([expect.objectContaining({ type: "error" })]);
    }
    expect(provider.calls).toEqual([]);
  });

  it("preserves every colliding tool and routes through hidden source metadata", async () => {
    const first = new StubConnector("first", [tool("shared.tool")]);
    const second = new StubConnector("second", [tool("shared.tool")]);
    const registry = new ConnectorRegistry([first, second]);

    const external = await registry.discoverTools(context);
    expect(external.map((entry) => entry.name)).toEqual(["shared.tool", "second.shared.tool"]);

    const selected = external[1]!;
    const results: unknown[] = [];
    for await (const event of registry.execute(
      {
        tool: selected.name,
        args: {},
        executionId: "execution",
        route: selected.route,
      },
      context,
    )) {
      if (event.type === "result") results.push(event.data);
    }
    expect(results).toEqual([{ connector: "second", tool: "shared.tool" }]);
    expect(first.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(1);
  });

  it("registers only the providers it is given", async () => {
    const stack = createConnectorStack(undefined, [new StubConnector("first", [tool("a")])]);

    await expect(stack.connector.discoverTools(context)).resolves.toEqual([
      expect.objectContaining({ name: "a", route: { connectorId: "first", toolName: "a" } }),
    ]);
    const events: ConnectorEvent[] = [];
    for await (const event of stack.connector.execute(
      { tool: "destination.write", args: {}, executionId: "execution" },
      context,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        type: "error",
        message: "connector_not_allowed: composio is not offered on this deployment.",
      },
    ]);
  });

  it("denies Gmail by default while Slack stays offered", async () => {
    const composio = new StubConnector("composio", [
      tool("GMAIL_SEND_EMAIL"),
      tool("SLACK_POST_MESSAGE"),
    ]);
    const other = new StubConnector("installed", [tool("read")]);
    const registry = new ConnectorRegistry([composio, other]);

    const discovered = await registry.discoverTools(context);
    expect(discovered.map((entry) => entry.name)).toEqual(["SLACK_POST_MESSAGE", "read"]);

    const events: ConnectorEvent[] = [];
    for await (const event of registry.execute(
      {
        tool: "SLACK_POST_MESSAGE",
        args: {},
        executionId: "execution",
        route: { connectorId: "composio", toolName: "SLACK_POST_MESSAGE" },
      },
      context,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "result", data: { connector: "composio", tool: "SLACK_POST_MESSAGE" } },
    ]);
    expect(composio.calls).toHaveLength(1);
  });

  it("offers no Composio app when the allowlist is explicitly empty", async () => {
    const composio = new StubConnector("composio", [
      tool("GMAIL_SEND_EMAIL"),
      tool("SLACK_POST_MESSAGE"),
    ]);
    const other = new StubConnector("installed", [tool("read")]);
    const registry = new ConnectorRegistry([composio, other], { allowlist: [], denylist: [] });

    const discovered = await registry.discoverTools(context);
    expect(discovered.map((entry) => entry.name)).toEqual(["read"]);
  });

  it("narrows to the allowlist", async () => {
    const composio = new StubConnector("composio", [
      tool("GMAIL_SEND_EMAIL"),
      tool("SLACK_POST_MESSAGE"),
    ]);
    const registry = new ConnectorRegistry([composio], { allowlist: ["slack"], denylist: [] });

    const discovered = await registry.discoverTools(context);
    expect(discovered.map((entry) => entry.name)).toEqual(["SLACK_POST_MESSAGE"]);
  });

  it("keeps Composio's meta-tools when the allowlist narrows", async () => {
    const composio = new StubConnector("composio", [
      tool("COMPOSIO_SEARCH_TOOLS"),
      tool("COMPOSIO_MULTI_EXECUTE_TOOL"),
      tool("GMAIL_SEND_EMAIL"),
      tool("SLACK_POST_MESSAGE"),
    ]);
    const registry = new ConnectorRegistry([composio], { allowlist: ["slack"], denylist: [] });

    const discovered = await registry.discoverTools(context);
    expect(discovered.map((entry) => entry.name)).toEqual([
      "COMPOSIO_SEARCH_TOOLS",
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      "SLACK_POST_MESSAGE",
    ]);
  });

  it("refuses an app nested inside a meta-tool when that app is denied", async () => {
    const composio = new StubConnector("composio", [tool("COMPOSIO_MULTI_EXECUTE_TOOL")]);
    const registry = new ConnectorRegistry([composio], { allowlist: ["slack"], denylist: [] });

    const events: ConnectorEvent[] = [];
    for await (const event of registry.execute(
      {
        tool: "COMPOSIO_MULTI_EXECUTE_TOOL",
        args: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] },
        executionId: "execution",
        route: { connectorId: "composio", toolName: "COMPOSIO_MULTI_EXECUTE_TOOL" },
      },
      context,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      expect.objectContaining({ type: "error", message: expect.stringContaining("gmail") }),
    ]);
    expect(composio.calls).toHaveLength(0);
  });

  it("lets deny beat allow", async () => {
    const composio = new StubConnector("composio", [tool("SLACK_POST_MESSAGE")]);
    const registry = new ConnectorRegistry([composio], {
      allowlist: ["slack"],
      denylist: ["slack"],
    });

    await expect(registry.discoverTools(context)).resolves.toEqual([]);
  });

  it("refuses a denied Composio connector before it is executed", async () => {
    const composio = new StubConnector("composio", [tool("GMAIL_SEND_EMAIL")]);
    const registry = new ConnectorRegistry([composio]);

    const events: ConnectorEvent[] = [];
    for await (const event of registry.execute(
      {
        tool: "GMAIL_SEND_EMAIL",
        args: {},
        executionId: "execution",
        route: { connectorId: "composio", toolName: "GMAIL_SEND_EMAIL" },
      },
      context,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "error", message: "connector_not_allowed: gmail is not offered on this deployment." },
    ]);
    expect(composio.calls).toEqual([]);
  });

  it("refuses a nested multi-execute action on a denied app", async () => {
    const composio = new StubConnector("composio", [tool("COMPOSIO_MULTI_EXECUTE_TOOL")]);
    const registry = new ConnectorRegistry([composio]);

    const events: ConnectorEvent[] = [];
    for await (const event of registry.execute(
      {
        tool: "COMPOSIO_MULTI_EXECUTE_TOOL",
        args: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }] },
        executionId: "execution",
        route: { connectorId: "composio", toolName: "COMPOSIO_MULTI_EXECUTE_TOOL" },
      },
      context,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "error", message: "connector_not_allowed: gmail is not offered on this deployment." },
    ]);
    expect(composio.calls).toEqual([]);
  });
});

function tool(name: string): ConnectorTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}
