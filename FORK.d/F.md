# Packet F: WhatsApp inbound routing (D-RUN-6, D-RUN-11)

Rows for the fork ledger (`FORK.md` patch log and decisions). Written by the packet F
subagent; the lead agent folds them into `FORK.md` at integration so the shared ledger
keeps one writer.

## Patch rows (for FORK.md "Patch log")

| Patch | Files | Reason | Replaceable by upstream config |
|---|---|---|---|
| WhatsApp webhook router | `apps/api/src/me/whatsapp-router.ts` (new), `apps/api/src/me/whatsapp-router.test.ts` (new) | One router verifies the Meta signature over the raw bytes before any parse, then routes exactly once per delivery: a trimmed body matching `^ME-[A-Z0-9]{6,}$` goes to phone sign-in and never reaches an agent; every other message goes to the existing messaging channel unchanged. Replays are refused by the same-transaction provider-message-id claim (see decisions). | No. Rakazo has no phone sign-in and no ME- routing; upstream's adapter-level signature check stays as the second layer. |
| Webhook entry runs the WhatsApp router first | `apps/api/src/messaging-webhook.ts`, `apps/api/src/messaging-runtime.ts` | The existing `mountMessagingWebhookRoutes` gained an optional `whatsapp` router: when mounted, provider `whatsapp` requests are dispatched by the router (signature gate, sign-in nonces, filtered forward of the agent messages in a batched payload) instead of going straight to the surface. Behaviour for every other provider, and for WhatsApp when the channel is not configured, is unchanged (the same `messaging.handleWebhook` call with byte-identical requests). | No. |
| `WHATSAPP_BUSINESS_NUMBER` config key | `apps/api/src/env.ts` | The business line people text, needed for `wa.me` deep links (`whatsAppDeepLink` in the router module). Read once in the fork's config module; the router never touches `process.env`. | No. |

## Decisions (for FORK.md "Decisions taken while building")

| Decision | Reason | Date |
|---|---|---|
| The provider-message-id claim for the sign-in path lives inside phone sign-in's own transaction, not the router | D-RUN-6 says the claim sits in the same transaction as the work; the work (code issuance) is packet C's transaction, which the router cannot join. The router's contract: `handleInbound` receives `providerMessageId` and answers `handled: true` only when it claimed it; the router sends `reply` only when `handled` is true, so a Meta replay produces neither a second code nor a second reply. Mutation-proven: dropping the `handled` check makes the replay test fail with two sends. | 2026-11-16 |
| The messaging path's dedupe is reused, not duplicated | The existing dedupe already claims the provider message id in the same transaction as the work: `messagingWakeIdempotencyKey(provider, handle)` feeds `clientNonce` into `sendUserMessage`, whose unique key fails the insert of a replayed delivery. No second dedupe table was added for either path. | 2026-11-16 |
| A batched webhook carrying both a nonce and agent text is split, not dropped | Meta can batch messages. Forwarding unchanged would let an `ME-` message reach an agent (failure mode 4); dropping the payload would swallow the agent message. The router forwards a filtered copy with the nonces removed, so both messages reach exactly one owner. | 2026-11-16 |
| The sign-in reply is sent through the existing messaging surface | `openDirectThread` + `sendToThread` on the mounted surface posts from the business line, which answers an inbound message inside Meta's free 24 hour service window. No new sender, no template. The send carries `idempotencyKey: whatsapp:signin:<wamid>`. | 2026-11-16 |
| An unsigned or mis-signed POST is refused with 401 before any parse | HMAC-SHA256 over the raw bytes (bounded read, same 256 KiB cap as the messaging webhook) with a timing-safe compare, in the API layer ahead of the surface. A GET still goes to the surface's verify-token handshake, so the Meta "Verify" flow is unchanged. When `WHATSAPP_APP_SECRET` is unset the router returns null and the existing 404 behaviour stands (the channel cannot be mounted without all four Meta values). | 2026-11-16 |

## Integration notes for packet C and the lead

- Packet C's real module has landed at `apps/api/src/me/phone-signin/` and replaced packet
  F's temporary seam file (`index.ts` placeholder that threw a named error). The wiring in
  `messaging-runtime.ts` now calls `whatsAppSignInHandler(prisma, config)` from that module;
  the router's `WhatsAppSignInHandler` type is the shared contract.
- Reply-send failure after a claim: if the reply send throws, the delivery answers 5xx and
  Meta retries; phone sign-in's claim then answers `handled: false`, so the retry produces
  no second code but also no re-reply. Phone sign-in should either tolerate that window or
  issue the code inside its claimed transaction with an outbox send. UNVERIFIED until the
  live harness (Wave 3) exercises it.
- Owner items for this packet: `WHATSAPP_BUSINESS_NUMBER` must be set on the host (the Meta
  test number, in non-secret `.env` form) for `wa.me` deep links to work; Meta webhook
  registration itself (D-RUN-11, pointing the `me.io` app at the existing webhook URL with
  a new verify token) is the lead's Meta-app step.
