import type { ConnectorCall } from "@rakazo/adapter-kit";

/**
 * ME_CONNECTOR_ALLOWLIST is the one authority for which Composio apps this deployment
 * offers. Unset or empty offers none: Composio's own toolkit settings are a mirror at
 * most, and me.io decides here.
 */
export const COMPOSIO_CONNECTOR_ID = "composio";

export const CONNECTOR_NOT_ALLOWED = "connector_not_allowed";

export function normalizeConnectorId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Parse once, at startup: comma-separated app slugs such as `slack,notion`. */
export function parseConnectorAllowlist(value: string | undefined): string[] {
  const ids = new Set<string>();
  for (const raw of (value ?? "").split(",")) {
    const id = normalizeConnectorId(raw);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** True for every non-Composio connector; Composio apps must be named in the allowlist. */
export function connectorAllowlistAllows(
  allowlist: readonly string[],
  connectorId: string,
  appId: string,
): boolean {
  if (connectorId !== COMPOSIO_CONNECTOR_ID) return true;
  const app = normalizeConnectorId(appId);
  return Boolean(app) && allowlist.some((entry) => normalizeConnectorId(entry) === app);
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
