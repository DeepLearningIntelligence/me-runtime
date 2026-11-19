import { describe, expect, it } from "vitest";
import {
  connectorAllowed,
  connectorCardAllowed,
  DEFAULT_CONNECTOR_DENYLIST,
  parseConnectorPolicy,
} from "./connector-allowlist.js";

const defaultPolicy = parseConnectorPolicy(undefined, undefined);

describe("connector policy", () => {
  it("keeps the personal Google default deny and does not narrow when the allowlist is unset", () => {
    expect(DEFAULT_CONNECTOR_DENYLIST).toEqual([
      "gmail",
      "googlecalendar",
      "googledrive",
      "googledocs",
      "googlesheets",
    ]);
    expect(defaultPolicy).toEqual({ allowlist: null, denylist: DEFAULT_CONNECTOR_DENYLIST });
    expect(connectorAllowed(defaultPolicy, "composio", "gmail")).toBe(false);
    expect(connectorAllowed(defaultPolicy, "composio", "slack")).toBe(true);
  });

  it("parses both lists once, case-insensitively and with aliases normalized", () => {
    expect(parseConnectorPolicy(" Gmail,GOOGLE-DRIVE ", " Slack , notion ")).toEqual({
      allowlist: ["slack", "notion"],
      denylist: ["gmail", "googledrive"],
    });
  });

  it("narrows to the allowlist and lets deny beat allow", () => {
    const narrowed = parseConnectorPolicy(undefined, "slack");
    expect(connectorAllowed(narrowed, "composio", "slack")).toBe(true);
    expect(connectorAllowed(narrowed, "composio", "github")).toBe(false);

    const conflict = parseConnectorPolicy("slack", "slack");
    expect(connectorAllowed(conflict, "composio", "slack")).toBe(false);
  });

  it("offers nothing when the allowlist is explicitly empty", () => {
    const empty = parseConnectorPolicy(undefined, ",");
    expect(empty.allowlist).toEqual([]);
    expect(connectorAllowed(empty, "composio", "slack")).toBe(false);
    expect(connectorAllowed(empty, "composio", "gmail")).toBe(false);
  });

  it("leaves every non-Composio connector alone", () => {
    expect(connectorAllowed(defaultPolicy, "mcp", "gmail")).toBe(true);
  });

  it("hides the provisioned GFIN card on either connector kind", () => {
    expect(
      connectorCardAllowed(defaultPolicy, {
        connectorId: "mcp",
        provider: "gfin",
        endpoint: "https://app.gofunditnow.com/api/mcp",
      }),
    ).toBe(false);
    expect(
      connectorCardAllowed(defaultPolicy, {
        connectorId: "mcp",
        provider: "example",
        endpoint: "https://example.test/mcp",
      }),
    ).toBe(true);
  });
});
