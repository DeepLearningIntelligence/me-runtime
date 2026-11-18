import type { ConnectorCall, ConnectorEvent, ConnectorProvider } from "@rakazo/adapter-kit";
import { connectorToolRequiresApproval } from "@rakazo/core";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findBlockedArgKey,
  GFIN_CONNECTION_SLUG,
  GFIN_ORG_ID_REFUSAL,
  GFIN_TOOL_GUARD,
  GFIN_TOOL_REFUSAL,
  GFIN_TOOLS,
  guardConnectorTools,
  guardedToolRefusal,
  parseGfinConnectionEnv,
} from "./gfin-connection.js";
import { McpConnector } from "./mcp-connector.js";
import { EncryptedSecretStore } from "./secrets.js";

/**
 * The GFIN connection's tool table and lanes, against a stub MCP server that speaks
 * JSON-RPC through stubbed fetch: no real network. The stub offers every registered tool
 * plus one name GFIN does not register.
 */
const STUB_TOOLS = [...GFIN_TOOLS.map((tool) => tool.name), "delete_opportunity"] as const;

const PUBLIC_TOOLS = GFIN_TOOLS.filter((tool) => tool.lane === "public").map((tool) => tool.name);

const GFIN_SERVER = {
  id: "gfin-server",
  slug: GFIN_CONNECTION_SLUG,
  name: "Go Fund It Now (public search)",
  transport: "streamable_http",
  endpoint: "https://gfin.example.test/api/mcp",
  secretId: null as string | null,
  args: [],
  revision: 1,
  enabled: true,
};

const OTHER_SERVER = {
  id: "other-server",
  slug: "notes",
  name: "Notes",
  transport: "streamable_http",
  endpoint: "https://gfin.example.test/api/mcp",
  secretId: null as string | null,
  args: [],
  revision: 1,
  enabled: true,
};

const NO_ASSIGNMENTS = { findMany: async () => [], findFirst: async () => null };

const context = {
  spaceId: "w1",
  userId: "u1",
  botId: "bot-1",
  signal: new AbortController().signal,
} as never;

const TEST_NETWORK = {
  fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
  resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
};

/** A stub MCP server over stubbed fetch: answers initialize, tools/list, tools/call. */
function mcpStubServer(state: { calls: Array<{ name: string; args: unknown }>; inits: number }) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = JSON.parse(await request.text()) as {
      id?: number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    if (message.method === "initialize") {
      state.inits += 1;
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "stub", version: "1" },
        },
      });
    }
    if (message.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: STUB_TOOLS.map((name) => ({
            name,
            description: name,
            inputSchema: { type: "object", properties: {} },
          })),
        },
      });
    }
    if (message.method === "tools/call") {
      state.calls.push({ name: message.params?.name ?? "", args: message.params?.arguments });
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "ok" }] },
      });
    }
    return new Response(null, { status: 202 });
  });
}

function stubPrisma(shared = GFIN_SERVER, secretRecord?: { id: string; ciphertext: string }) {
  return {
    mcpServer: {
      // The allBots discovery query; the connector reads shared servers here.
      findMany: vi.fn(async () => [shared]),
      findFirst: vi.fn(async () => shared),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    botMcpServer: NO_ASSIGNMENTS,
    secret: { findFirst: vi.fn(async () => secretRecord ?? null) },
  };
}

/** A credentialed row and the encrypted record its secretId points at. */
async function connectedFixture() {
  const store = new EncryptedSecretStore("0123456789abcdef0123456789abcdef");
  const record = await store.put(
    JSON.stringify({ secret: "gfin_personal_test_key_111111" }),
    context,
  );
  const server = { ...GFIN_SERVER, secretId: record.id };
  return { store, server, prisma: stubPrisma(server, { id: record.id, ciphertext: record.ref }) };
}

const gfinToolCall = (
  toolName: string,
  args: Record<string, unknown>,
  credentialed = false,
): ConnectorCall => ({
  tool: `mcp__${GFIN_CONNECTION_SLUG}__${toolName}`,
  args,
  executionId: "exec-1",
  route: {
    connectorId: "mcp",
    resourceId: GFIN_SERVER.id,
    resourceRevision: 1,
    toolName,
    catalogGroup: GFIN_CONNECTION_SLUG,
    credentialed,
  },
});

async function collect(events: AsyncIterable<ConnectorEvent>): Promise<ConnectorEvent[]> {
  const all: ConnectorEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

function stubProvider(): ConnectorProvider {
  return {
    describe: () => ({
      id: "stub",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { discover: true, oauth: false, secretsBrokered: false },
    }),
    discoverTools: async () => [],
    execute: async function* () {
      yield { type: "result", data: null };
    },
  };
}

describe("gfin connection tool guard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers the public read tools only, from a stub MCP server", async () => {
    const state = { calls: [] as Array<{ name: string; args: unknown }>, inits: 0 };
    vi.stubGlobal("fetch", mcpStubServer(state));
    const inner = new McpConnector(stubPrisma() as never, {} as never, { network: TEST_NETWORK });
    const guarded = guardConnectorTools(inner, GFIN_TOOL_GUARD);
    try {
      const tools = await guarded.discoverTools(context);
      expect(tools.map((tool) => tool.name)).toEqual(
        PUBLIC_TOOLS.map((name) => `mcp__${GFIN_CONNECTION_SLUG}__${name}`),
      );
      expect(tools.every((tool) => tool.route?.credentialed === false)).toBe(true);
    } finally {
      await inner.close();
    }
  });

  it("offers all seven registered tools on a credentialed connection", async () => {
    const fixture = await connectedFixture();
    const state = { calls: [] as Array<{ name: string; args: unknown }>, inits: 0 };
    vi.stubGlobal("fetch", mcpStubServer(state));
    const inner = new McpConnector(fixture.prisma as never, fixture.store, {
      network: TEST_NETWORK,
    });
    const guarded = guardConnectorTools(inner, GFIN_TOOL_GUARD);
    try {
      const tools = await guarded.discoverTools(context);
      expect(tools.map((tool) => tool.name)).toEqual(
        GFIN_TOOLS.map((tool) => `mcp__${GFIN_CONNECTION_SLUG}__${tool.name}`),
      );
      expect(tools.every((tool) => tool.route?.credentialed === true)).toBe(true);
    } finally {
      await inner.close();
    }
  });

  it("leaves other MCP servers untouched", async () => {
    const state = { calls: [] as Array<{ name: string; args: unknown }>, inits: 0 };
    vi.stubGlobal("fetch", mcpStubServer(state));
    const prisma = stubPrisma(OTHER_SERVER);
    const inner = new McpConnector(prisma as never, {} as never, { network: TEST_NETWORK });
    const guarded = guardConnectorTools(inner, GFIN_TOOL_GUARD);
    try {
      const tools = await guarded.discoverTools(context);
      expect(tools.map((tool) => tool.name)).toContain("mcp__notes__delete_opportunity");
      expect(tools.map((tool) => tool.name)).toContain("mcp__notes__list_pipeline");
    } finally {
      await inner.close();
    }
  });

  it("refuses a tool outside the table before any request", async () => {
    const state = { calls: [] as Array<{ name: string; args: unknown }>, inits: 0 };
    const fetchStub = mcpStubServer(state);
    vi.stubGlobal("fetch", fetchStub);
    const inner = new McpConnector(stubPrisma() as never, {} as never, { network: TEST_NETWORK });
    const guarded = guardConnectorTools(inner, GFIN_TOOL_GUARD);
    try {
      const events = await collect(
        guarded.execute(gfinToolCall("delete_opportunity", {}), context),
      );
      expect(events).toEqual([{ type: "error", message: GFIN_TOOL_REFUSAL }]);
      // Not even a session reached the stub: zero requests total.
      expect(fetchStub).not.toHaveBeenCalled();
    } finally {
      await inner.close();
    }
  });

  it("refuses connected tools on the public lane before any request", async () => {
    const state = { calls: [] as Array<{ name: string; args: unknown }>, inits: 0 };
    const fetchStub = mcpStubServer(state);
    vi.stubGlobal("fetch", fetchStub);
    const inner = new McpConnector(stubPrisma() as never, {} as never, { network: TEST_NETWORK });
    const guarded = guardConnectorTools(inner, GFIN_TOOL_GUARD);
    try {
      for (const toolName of ["list_pipeline", "save_opportunity"]) {
        const events = await collect(guarded.execute(gfinToolCall(toolName, {}), context));
        expect(events).toEqual([{ type: "error", message: GFIN_TOOL_REFUSAL }]);
      }
      expect(fetchStub).not.toHaveBeenCalled();
    } finally {
      await inner.close();
    }
  });

  it("allows every class on the lane that serves it", () => {
    for (const tool of GFIN_TOOLS) {
      expect(
        guardedToolRefusal(tool.name, { query: "grants" }, GFIN_TOOL_GUARD, tool.lane),
      ).toBeUndefined();
    }
    expect(
      guardedToolRefusal("save_opportunity", {}, GFIN_TOOL_GUARD, "connected"),
    ).toBeUndefined();
    expect(guardedToolRefusal("not_a_gfin_tool", {}, GFIN_TOOL_GUARD, "connected")).toContain(
      "gfin_tool_not_allowed",
    );
  });

  it("classifies exactly GFIN's seven registered tools", () => {
    expect(GFIN_TOOLS).toEqual([
      { name: "search_opportunities", kind: "read", lane: "public" },
      { name: "get_opportunity", kind: "read", lane: "public" },
      { name: "get_organization_profile", kind: "read", lane: "connected" },
      { name: "get_project_requirements", kind: "read", lane: "connected" },
      { name: "list_pipeline", kind: "read", lane: "connected" },
      { name: "get_my_saved_opportunities", kind: "read", lane: "connected" },
      { name: "save_opportunity", kind: "write", lane: "connected" },
    ]);
  });

  it("leaves save_opportunity to the existing approval gate as a write", () => {
    // The gate reads the tool's declared effect and its name; save is never a read.
    expect(connectorToolRequiresApproval("save_opportunity", true)).toBe(true);
    expect(connectorToolRequiresApproval("save_opportunity", undefined)).toBe(true);
  });

  it("refuses an org_id argument on every tool, before any request", async () => {
    const state = { calls: [] as Array<{ name: string; args: unknown }>, inits: 0 };
    const fetchStub = mcpStubServer(state);
    vi.stubGlobal("fetch", fetchStub);
    const fixture = await connectedFixture();
    const inner = new McpConnector(fixture.prisma as never, fixture.store, {
      network: TEST_NETWORK,
    });
    const guarded = guardConnectorTools(inner, GFIN_TOOL_GUARD);
    try {
      const events = await collect(
        guarded.execute(
          gfinToolCall("list_pipeline", { filter: { org_id: "org-123" } }, true),
          context,
        ),
      );
      expect(events).toEqual([{ type: "error", message: GFIN_ORG_ID_REFUSAL }]);
      expect(fetchStub).not.toHaveBeenCalled();
    } finally {
      await inner.close();
    }
  });

  it("lets an allowed call without org_id through to the stub server", async () => {
    const state = { calls: [] as Array<{ name: string; args: unknown }>, inits: 0 };
    vi.stubGlobal("fetch", mcpStubServer(state));
    const inner = new McpConnector(stubPrisma() as never, {} as never, { network: TEST_NETWORK });
    const guarded = guardConnectorTools(inner, GFIN_TOOL_GUARD);
    try {
      const events = await collect(
        guarded.execute(gfinToolCall("search_opportunities", { query: "grants" }), context),
      );
      expect(events).toEqual([{ type: "result", data: expect.anything() }]);
      expect(state.calls).toEqual([{ name: "search_opportunities", args: { query: "grants" } }]);
    } finally {
      await inner.close();
    }
  });

  it("lets a connected read through on a credentialed connection", async () => {
    const fixture = await connectedFixture();
    const state = { calls: [] as Array<{ name: string; args: unknown }>, inits: 0 };
    vi.stubGlobal("fetch", mcpStubServer(state));
    const inner = new McpConnector(fixture.prisma as never, fixture.store, {
      network: TEST_NETWORK,
    });
    const guarded = guardConnectorTools(inner, GFIN_TOOL_GUARD);
    try {
      const events = await collect(
        guarded.execute(gfinToolCall("list_pipeline", {}, true), context),
      );
      expect(events).toEqual([{ type: "result", data: expect.anything() }]);
      expect(state.calls).toEqual([{ name: "list_pipeline", args: {} }]);
    } finally {
      await inner.close();
    }
  });

  it("logs a refusal without the arguments", async () => {
    const sink = createTestSink();
    const previous = getLogger();
    installLogger(createLogger({ service: "test", sinks: [sink], level: "debug" }));
    try {
      const guarded = guardConnectorTools(stubProvider(), GFIN_TOOL_GUARD);
      await collect(
        guarded.execute(
          gfinToolCall("search_opportunities", { org_id: "secret-org-value", query: "x" }),
          context,
        ),
      );
      const logged = JSON.stringify(sink.events);
      expect(logged).toContain("gfin_org_id_refused");
      expect(logged).not.toContain("secret-org-value");
      expect(logged).not.toContain('"query"');
    } finally {
      installLogger(previous);
    }
  });

  it("blocks the key at any depth and only inside the guarded slug", () => {
    expect(findBlockedArgKey({ a: [{ b: { org_id: "x" } }] }, ["org_id"])).toBe("org_id");
    expect(findBlockedArgKey({ a: { b: "c" } }, ["org_id"])).toBeUndefined();
    expect(guardedToolRefusal("search_opportunities", { org_id: "x" }, GFIN_TOOL_GUARD)).toBe(
      GFIN_ORG_ID_REFUSAL,
    );
    expect(
      guardedToolRefusal("search_opportunities", { query: "x" }, GFIN_TOOL_GUARD),
    ).toBeUndefined();
    expect(guardedToolRefusal("delete_opportunity", {}, GFIN_TOOL_GUARD)).toBe(GFIN_TOOL_REFUSAL);
  });

  it("reads the deployment config; provisioning values arrive together", () => {
    expect(parseGfinConnectionEnv({})).toEqual({
      mcpUrl: "https://app.gofunditnow.com/api/mcp",
      houseKey: undefined,
      provision: undefined,
    });
    expect(parseGfinConnectionEnv({ ME_GFIN_HOUSE_KEY: "hk_1" })).toEqual({
      mcpUrl: "https://app.gofunditnow.com/api/mcp",
      houseKey: "hk_1",
      provision: undefined,
    });
    expect(() =>
      parseGfinConnectionEnv({ ME_GFIN_PROVISION_URL: "https://g3.example.test/provision" }),
    ).toThrow("ME_GFIN_PROVISION_TOKEN");
    expect(() => parseGfinConnectionEnv({ ME_GFIN_PROVISION_TOKEN: "t" })).toThrow(
      "ME_GFIN_PROVISION_URL",
    );
    expect(
      parseGfinConnectionEnv({
        ME_GFIN_PROVISION_URL: "https://g3.example.test/provision",
        ME_GFIN_PROVISION_TOKEN: "t",
      }),
    ).toEqual({
      mcpUrl: "https://app.gofunditnow.com/api/mcp",
      provision: { url: "https://g3.example.test/provision", token: "t" },
    });
  });
});

describe.each(GFIN_TOOLS.map((tool) => tool.name))("%s refuses org_id", (toolName) => {
  it("at the top level and one level deep", () => {
    for (const args of [{ org_id: "org-123" }, { filter: { org_id: "org-123" } }])
      expect(guardedToolRefusal(toolName, args, GFIN_TOOL_GUARD, "connected")).toBe(
        GFIN_ORG_ID_REFUSAL,
      );
  });
});
