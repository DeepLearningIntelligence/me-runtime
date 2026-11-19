import { appConnectedInput } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  appConnectPresentation,
  offeredAppConnectBlocks,
  offeredMcpApprovalBlocks,
} from "./app-connect.js";

describe("appConnectPresentation", () => {
  const block = {
    kind: "app_connect" as const,
    provider: "gmail",
    name: "Gmail",
    description: "Search, read, draft, and send email.",
    logo: null,
    status: "pending" as const,
  };

  it("renders an authorize control for pending app_connect blocks", () => {
    const view = appConnectPresentation(block);
    expect(view.showAuthorize).toBe(true);
    expect(view.actionLabel).toBe("Connect");
  });

  it("hides authorize once connected", () => {
    const view = appConnectPresentation({ ...block, status: "connected" });
    expect(view.showAuthorize).toBe(false);
    expect(view.actionLabel).toBe("Connected");
  });
});

it("hides denied connector cards and the provisioned GFIN approval card on mobile", () => {
  const policy = { allowlist: null, denylist: ["gmail"] };
  const blocks = [
    {
      kind: "app_connect" as const,
      provider: "gmail",
      name: "Gmail",
      description: "",
      logo: null,
      status: "pending" as const,
    },
    {
      kind: "app_connect" as const,
      provider: "slack",
      name: "Slack",
      description: "",
      logo: null,
      status: "pending" as const,
    },
    {
      kind: "mcp_approval" as const,
      name: "Go Fund It Now",
      serverId: "gfin",
      transport: "streamable_http" as const,
      endpoint: "https://app.gofunditnow.com/api/mcp",
      needsOAuth: false,
      status: "pending" as const,
    },
  ];
  expect(offeredAppConnectBlocks(blocks, policy).map((block) => block.provider)).toEqual(["slack"]);
  expect(offeredMcpApprovalBlocks(blocks)).toEqual([]);
});

it("marks a normal chat card using the message thread", () => {
  expect(
    appConnectedInput("bot", "normal-chat", {
      kind: "app_connect",
      connectorId: "fake",
      provider: "gmail",
      name: "Gmail",
      description: "",
      logo: null,
      status: "pending",
    }),
  ).toEqual({ botId: "bot", threadId: "normal-chat", connectorId: "fake", provider: "gmail" });
});
