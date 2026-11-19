import { randomBytes } from "node:crypto";

/**
 * The signed link a person opens to upload credentials through an authenticated
 * tunnel. Issuing and consuming go through the verification store, like the
 * account export link: only that store's record can mint a tunnel, and consuming
 * is atomic, so one link opens once.
 *
 * The window is long enough for the person to open the link, sign in when the
 * session is missing, and finish the upload; it is short enough that a link
 * forwarded on is dead before it is useful to anyone else.
 */
export const PII_TUNNEL_TOKEN_MS = 15 * 60_000;
export const PII_TUNNEL_TOKEN_PREFIX = "pii-tunnel-";

type Verification = { value: string; expiresAt: Date };

export async function issuePIITunnelToken(
  adapter: {
    createVerificationValue(data: Verification & { identifier: string }): Promise<unknown>;
  },
  userId: string,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await adapter.createVerificationValue({
    identifier: `${PII_TUNNEL_TOKEN_PREFIX}${token}`,
    value: userId,
    expiresAt: new Date(Date.now() + PII_TUNNEL_TOKEN_MS),
  });
  return token;
}

/** The person the link was issued to, or null. Consuming is atomic, so a link opens once. */
export async function consumePIITunnelToken(
  adapter: { consumeVerificationValue(identifier: string): Promise<Verification | null> },
  token: string,
): Promise<string | null> {
  if (!token) return null;
  const stored = await adapter.consumeVerificationValue(`${PII_TUNNEL_TOKEN_PREFIX}${token}`);
  return stored && stored.expiresAt.getTime() > Date.now() ? stored.value : null;
}
