/**
 * The stable key of one inbound provider message. It dedupes the message on
 * its way into a run and names the message a mirrored reply answers.
 */
export function messagingInboundNonce(provider: string, handle: string): string {
  return `messaging:${provider}:${handle}`;
}

/** The provider handle carried by a nonce, or null when the nonce is not ours. */
export function messagingInboundHandle(
  provider: string,
  clientNonce: string | null | undefined,
): string | null {
  const prefix = `messaging:${provider}:`;
  if (!clientNonce?.startsWith(prefix)) return null;
  const handle = clientNonce.slice(prefix.length);
  return handle || null;
}
