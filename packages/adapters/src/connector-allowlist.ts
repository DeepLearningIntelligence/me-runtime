import type { ConnectorCall } from "@rakazo/adapter-kit";
import type { ConnectorPolicy } from "@rakazo/contracts";
import { GFIN_MCP_URL } from "./gfin-endpoint.js";

/**
 * ME_CONNECTOR_DENYLIST removes Composio apps by id and ME_CONNECTOR_ALLOWLIST narrows to
 * only the ids it names; deny wins over allow, and both are parsed once here. Unset
 * ME_CONNECTOR_DENYLIST keeps the default list below; an unset or empty allowlist does not
 * narrow, so every other Composio app stays offered. Composio's own toolkit settings are a
 * mirror at most: me.io decides.
 */
export const COMPOSIO_CONNECTOR_ID = "composio";

export const CONNECTOR_NOT_ALLOWED = "connector_not_allowed";

/**
 * Personal Google content connectors this deployment never offers by default. The first
 * three are Composio fixtures in this repo; GOOGLEDOCS is the product's onboarding slug and
 * GOOGLESHEETS is in the published integrations list.
 */
export const DEFAULT_CONNECTOR_DENYLIST = [
  "gmail",
  "googlecalendar",
  "googledrive",
  "googledocs",
  "googlesheets",
];

export const DEFAULT_CONNECTOR_POLICY: ConnectorPolicy = {
  allowlist: null,
  denylist: DEFAULT_CONNECTOR_DENYLIST,
};

export function normalizeConnectorId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function parseConnectorList(value: string | undefined): string[] {
  const ids = new Set<string>();
  for (const raw of (value ?? "").split(",")) {
    const id = normalizeConnectorId(raw);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** An allowlist that is absent or blank does not narrow; one that is present narrows, even to nothing. */
function parseOptionalAllowlist(value: string | undefined): string[] | null {
  return (value ?? "").trim() === "" ? null : parseConnectorList(value);
}

export function parseConnectorPolicy(
  denylistValue: string | undefined,
  allowlistValue: string | undefined,
): ConnectorPolicy {
  const denylist = parseConnectorList(denylistValue);
  return {
    allowlist: parseOptionalAllowlist(allowlistValue),
    denylist: denylist.length > 0 ? denylist : [...DEFAULT_CONNECTOR_DENYLIST],
  };
}

/** True for every non-Composio connector. Composio apps must pass deny, then allow. */
export function connectorAllowed(
  policy: ConnectorPolicy,
  connectorId: string,
  appId: string,
): boolean {
  if (connectorId !== COMPOSIO_CONNECTOR_ID) return true;
  const app = normalizeConnectorId(appId);
  if (!app) return false;
  if (policy.denylist.some((entry) => normalizeConnectorId(entry) === app)) return false;
  if (
    policy.allowlist !== null &&
    !policy.allowlist.some((entry) => normalizeConnectorId(entry) === app)
  ) {
    return false;
  }
  return true;
}

export function connectorNotAllowedRefusal(appId: string): string {
  return `${CONNECTOR_NOT_ALLOWED}: ${appId} is not offered on this deployment.`;
}

export class ConnectorNotAllowedError extends Error {
  readonly code = CONNECTOR_NOT_ALLOWED;

  constructor(readonly connectorId: string) {
    super(connectorNotAllowedRefusal(connectorId));
    this.name = "ConnectorNotAllowedError";
  }
}

/** Composio prefixes every tool slug with its toolkit, e.g. GMAIL_SEND_EMAIL. */
export function composioToolkitId(toolName: string): string {
  const slug = toolName.trim().toLowerCase();
  if (!slug) return "";
  const separator = slug.indexOf("_");
  return separator === -1
    ? normalizeConnectorId(slug)
    : normalizeConnectorId(slug.slice(0, separator));
}

/** The toolkit every action in this call belongs to, including nested multi-execute items. */
export function composioCallToolkits(call: ConnectorCall): string[] {
  const slugs = [call.route?.toolName ?? call.tool];
  const items = Array.isArray(call.args?.tools) ? call.args.tools : [];
  for (const item of items) {
    if (item && typeof item === "object") {
      const slug = (item as { tool_slug?: unknown }).tool_slug;
      if (typeof slug === "string") slugs.push(slug);
    }
  }
  return [
    ...new Set(
      slugs
        .filter((slug) => !slug.trim().toUpperCase().startsWith("COMPOSIO_"))
        .map(composioToolkitId)
        .filter(Boolean),
    ),
  ];
}

/** The Go Fund It Now server is provisioned for everyone, so no card may ask to connect it. */
export function isProvisionedGfinEndpoint(endpoint: string | null | undefined): boolean {
  return endpoint?.trim() === GFIN_MCP_URL;
}

export type ConnectorCardRef = {
  connectorId?: string;
  provider: string;
  endpoint?: string | null;
};

/** Shared by web and mobile: no card for a denied connector or the provisioned GFIN server. */
export function connectorCardAllowed(policy: ConnectorPolicy, card: ConnectorCardRef): boolean {
  if (isProvisionedGfinEndpoint(card.endpoint)) return false;
  return connectorAllowed(
    policy,
    card.connectorId ?? COMPOSIO_CONNECTOR_ID,
    composioToolkitId(card.provider),
  );
}
