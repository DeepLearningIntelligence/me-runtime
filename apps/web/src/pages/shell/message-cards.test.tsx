// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  begin: vi.fn(async () => ({ connectionId: "connection", authorizationUrl: null })),
  complete: vi.fn(async () => ({ status: "connected" })),
  mark: vi.fn(async () => ({ ok: true })),
  oauthBegin: vi.fn(async () => ({
    status: "authorization_required" as const,
    authorizationUrl: "https://identity.example.test/authorize",
  })),
  approve: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    connections: { begin: calls.begin, complete: calls.complete },
    onboarding: { appConnected: calls.mark },
    mcp: { oauth: { begin: calls.oauthBegin }, assignments: { approve: calls.approve } },
  },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + (index ? values[index - 1] : "") + part, ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { connectMcpOauth } from "../../lib/mcp-connect";
import { AppConnectCard, McpApprovalCard, ProductCard } from "./message-cards";

function popupFlow({ focused }: { focused: boolean }) {
  const channels: FakeChannel[] = [];
  class FakeChannel {
    onmessage: ((event: MessageEvent) => void) | null = null;
    close = vi.fn();
    constructor(public name: string) {
      channels.push(this);
    }
  }
  // A popup on a COOP provider page reads as closed to the opener.
  const popup = { closed: true, close: vi.fn() };
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
  return { popup, channels };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("approves the bot after OAuth completes while a COOP popup keeps focus", async () => {
  vi.useFakeTimers();
  const { channels } = popupFlow({ focused: false });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <McpApprovalCard
          botId="bot"
          threadId="thread"
          block={{
            kind: "mcp_approval",
            name: "Example",
            serverId: "server",
            transport: "streamable_http",
            endpoint: "https://example.test/mcp",
            needsOAuth: true,
            status: "pending",
          }}
        />,
      ),
    );
    await act(async () => host.querySelector("button")?.click());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(calls.approve).not.toHaveBeenCalled();
    await act(async () =>
      channels[0]?.onmessage?.({ data: { type: "mcp-oauth-complete" } } as MessageEvent),
    );
    expect(calls.approve).toHaveBeenCalledExactlyOnceWith({
      botId: "bot",
      serverId: "server",
      threadId: "thread",
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await act(async () => root.unmount());
  }
});

it("cancels once the popup is closed and the app has focus again", async () => {
  vi.useFakeTimers();
  const { channels } = popupFlow({ focused: true });
  const flow = connectMcpOauth("server");
  await vi.advanceTimersByTimeAsync(500);
  await expect(flow).resolves.toBe("cancelled");
  expect(channels[0]?.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("authorizes a card in a normal chat and marks its thread connected", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <AppConnectCard
          botId="bot"
          threadId="normal-chat"
          block={{
            kind: "app_connect",
            connectorId: "fake",
            provider: "gmail",
            name: "Gmail",
            description: "",
            logo: null,
            status: "pending",
          }}
        />,
      ),
    );
    expect(host.querySelector("button")?.textContent).toBe("Connect");
    await act(async () => host.querySelector("button")?.click());
    expect(calls.mark).toHaveBeenCalledWith({
      botId: "bot",
      threadId: "normal-chat",
      connectorId: "fake",
      provider: "gmail",
    });
    expect(host.textContent).toContain("Connected");
    expect(host.querySelector("button")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("links OAuth failures in chat to the shared recovery guide without approving the server", async () => {
  calls.oauthBegin.mockRejectedValueOnce(
    Object.assign(new Error("Sign-in configuration mismatch"), {
      code: "MCP_OAUTH_REDIRECT_MISMATCH",
    }),
  );
  const approvalsBefore = calls.approve.mock.calls.length;
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <McpApprovalCard
          botId="bot"
          threadId="thread"
          block={{
            kind: "mcp_approval",
            name: "Example",
            serverId: "server",
            transport: "streamable_http",
            endpoint: "https://example.test/mcp",
            needsOAuth: true,
            status: "pending",
          }}
        />,
      ),
    );
    await act(async () => host.querySelector("button")?.click());
    expect(host.querySelector('[role="alert"] a')?.getAttribute("href")).toBe(
      "https://rakazo.com/docs/troubleshooting/#mcp-oauth-redirect-mismatch",
    );
    expect(calls.approve.mock.calls).toHaveLength(approvalsBefore);
    expect(host.querySelector("button")?.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

it("renders a product card from page facts and opens the product page", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ProductCard
          block={{
            kind: "product_card",
            url: "https://shopstar.example/products/mini-backpack",
            title: "Mini Backpack",
            subtitle: "Shopstar",
            price: "$49.99",
            attributes: [{ k: "Color", v: "Cream" }],
            imageUrl: "https://shopstar.example/images/mini-backpack.jpg",
            source: "https://shopstar.example/products/mini-backpack",
            verifiedAt: "2026-11-19T09:00:00.000Z",
          }}
        />,
      ),
    );
    const card = host.querySelector('[data-testid="product-card"]') as HTMLAnchorElement;
    expect(card.href).toBe("https://shopstar.example/products/mini-backpack");
    expect(card.getAttribute("target")).toBe("_blank");
    expect(card.textContent).toContain("Mini Backpack");
    expect(card.textContent).toContain("Shopstar");
    expect(card.textContent).toContain("Color: Cream");
    expect(card.textContent).toContain("$49.99");
    expect(card.textContent).toContain("Add to Cart");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
