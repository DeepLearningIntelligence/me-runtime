/**
 * Where the signed upload link points. The page is served by the API at
 * `/pii/:token` (and `/api/pii/:token` for the JSON form post), so a deployment
 * whose web origin is not this host must route `/pii/*` to the API.
 */
export const PII_TUNNEL_BASE_URL = "https://me.gofunditnow.com";

export function piiTunnelUrl(token: string): string {
  return `${PII_TUNNEL_BASE_URL}/pii/${encodeURIComponent(token)}`;
}
