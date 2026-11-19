# FORK.md: me-runtime

The me.io runtime is a fork of `elie222/rakazo` at tag `v0.11.0`
(`ef5c3dd97f83f9b92d1dffcb6cb22cc09f5e2d76`, 12 November 2026), on branch `me`.
It exists so me.io can run a real agent runtime without a second identity system, and
without anyone bringing a model key.

`origin` is `DeepLearningIntelligence/me-runtime`. `upstream` is `elie222/rakazo`.
The licence and NOTICE are unchanged except for the one added attribution line.

## Rules for this fork

1. Configuration and the theme file before a patch. A patch is a last resort, small,
   and listed here with its reason.
2. Every patch is one commit with a name a reader can follow, and an entry in the
   table below saying why it exists and whether upstream configuration could replace it.
3. No user-visible string says Rakazo. Internal package names may stay.
4. One owner per concern. The authority table is in the brief
   (`docs/PROMPT_ME_RUN_001_RUNTIME_FORK.md` section 4) and this file repeats the
   decisions, not the table.

## Patch log

Detailed rows, including every enforcement point and its test, are in `FORK.d/<packet>.md`.
This table is the index; a packet that does not appear here did not ship.

| Patch | Files | Reason | Replaceable by upstream config |
|---|---|---|---|
| B house-only models | `apps/api/src/me/model-policy.ts`, `apps/api/src/model-credentials.ts`, `apps/api/src/routes/models.ts`, `apps/api/src/agent-import-services.ts`, `apps/api/src/env.ts`, `apps/api/src/cli/model-credit-grant.ts`, web model settings | One guard refuses every create or update of a user model connection with a named 403, including the lowest-level writer, because upstream has no operator switch (spike H1). Credits reuse the fork's existing ceiling. | No |
| C phone sign-in | `apps/api/src/me/phone-signin/*`, `packages/db/prisma/migrations/20261217120000_me_phone_signin`, `packages/auth/src/index.ts` (`issueSession`), `apps/api/src/env.ts` (`ME_IDENTITY_HASH_KEY`) | The phone door as one authority: pending row hashed, bind claimed in the same transaction, code single use with lockout, person and session through the fork's own auth. A phone-only person gets `@phone.invalid`, never a mailbox. | No |
| D invitations | `apps/api/src/me/invitations/*`, `apps/api/src/routes/invites.ts`, `packages/contracts/src/invites.ts`, `packages/db/prisma/migrations/20261116120000_me_invitations`, `apps/api/src/env.ts` | Hashed tokens, compare-and-swap redeem, quota read from the row and never from the client, inviter named for the welcome page. | No |
| F WhatsApp router | `apps/api/src/me/whatsapp-router.ts`, `apps/api/src/messaging-webhook.ts`, `apps/api/src/messaging-runtime.ts`, `apps/api/src/env.ts` (`WHATSAPP_BUSINESS_NUMBER`) | Signature over raw bytes before parse, then exactly one decision: `ME-` to sign-in, everything else to the agent. A batched payload is split, never dropped. | No |
| P11 phone sign-in fixes | `apps/api/src/me/phone-signin/{service,session,routes}.ts`, `apps/api/src/cli/bootstrap-owner.ts`, `packages/db/prisma/schema.prisma`, `packages/db/prisma/migrations/20261118095000_me_user_phone_hash`, `packages/db/prisma/migrations/20261218130000_me_phone_signin_link_user`, web onboarding `door.ts`, `phone-signin.tsx`, `flow.tsx` | A refused admission no longer burns a correct code (the consume rides in the admission transaction); the owner can seed and signed-in people can link a phone (`user.phoneHash`, one hash per person); a link door records its opener and redeems only for them; a dead door gets one answer and a replay none; the code and the business number stay on screen with a copy button; wa.me links open in the same tab and the door survives the trip. Details, tests and mutations in `FORK.d/P11.md`. | No |
| P15 base green | `apps/api/src/me/invitations/invitations.postgres.test.ts`, `packages/db/prisma/schema.prisma` (`BillingAuditEvent.id`), `packages/db/prisma/migrations/20261218140000_fk_on_update_cascade`, `packages/db/prisma.config.ts` (`SHADOW_DATABASE_URL`) | The base branch's own two defects: the concurrent-redeem postgres test never created the redeemer accounts so both racers died on the redeemed-by foreign key (test setup fixed, assertions untouched, CAS guard's mutation proof lives in the unit suite's interleaved racer test); and `prisma migrate diff` disagreement resolved: six foreign keys re-created with the schema's `ON UPDATE CASCADE`, the audit id default declared in the schema because four trigger functions rely on it, and the remaining two index renames plus three documented `NULLS NOT DISTINCT` uniques left alone. Details in `FORK.d/P15.md`. | Partially: upstream owns the drift; the schema declares what the database already does. |
| P16 base integration fixes | `packages/adapters/src/push-token-store.ts`, `packages/db/src/unread-inbox-chats.ts`, fixtures `packages/adapters/src/media-video-poll.postgres.test.ts` and `packages/adapters/src/schedule-timezone.postgres.test.ts` | Naive UTC timestamps met session-local clocks in four places, so the database gate was red on any server ahead of UTC: push registration refused every fresh session (`CURRENT_TIMESTAMP`), snoozed chats counted as unread (bare `now()`), and two fixtures wrote instants the column convention does not carry (raw `now()` and a raw pg `Date` parameter). UTC-wall-clock comparisons in the product, UTC forms in the fixtures; guards and mutations in `FORK.d/P16.md`. | No |
| P12 link authority | `apps/api/src/me/phone-signin/routes.ts` (+ `routes.test.ts`) | `/verify` derives link or sign-in from the code's pending row, never the request: a link door completes only for the person it was opened for (401 without a session, 403 `session_mismatch` for anyone else), and a `link` flag on a plain sign-in door is refused 400 `link_not_started` with nothing attached; every refusal leaves the code unconsumed. The legacy derived-id reads stay; the host count is pending and P11's SQL is corrected in `FORK.d/P12.md`. | No |
| P14 WhatsApp is the default | `packages/db/src/messaging.ts` (`attachMessagingIdentity`), `packages/db/prisma/schema.prisma`, `packages/db/prisma/migrations/20261219100000_me_phone_signin_sender_address`, `apps/api/src/me/phone-signin/{service,session,routes}.ts`, `apps/api/src/messaging-runtime.ts`, `apps/api/src/app.ts` (two one-line wiring changes), web onboarding `door.ts`, `entry.ts`, `phone-signin.tsx`, `flow.tsx`, `apps/web/src/components/SidebarFooter.tsx`, `apps/web/src/pages/shell/shell-sidebar.tsx`, `apps/web/e2e/me-whatsapp-default.spec.ts` | After a successful phone sign-in the server attaches the number that sent the `ME-` message to the person's default agent through the one linking authority, queues one welcome per nonce, and answers verify with a named `whatsapp` state; the address rides only as a secret-store seal in `me_phone_signins.senderAddress`, cleared on consume and dead with the door. The onboarding skips the manual link step for `linked` or `already_linked` and ends on Back to WhatsApp; the account menu gains the WhatsApp row and Connect apps becomes Connect tools. Details, tests and mutations in `FORK.d/P14.md`. | No |
| P14 rebase e2e walk | `apps/web/e2e/helpers.ts` | The base branch's own defect, found while proving this rebase end to end: packet H rewrote `completeOnboarding` for the me flow but recorded it "not run locally" (`FORK.d/H.md`), and its first wait (Open the portal or Chief before any click) cannot pass on a flow that lands on the skippable Connect WhatsApp step, so 210 of 313 Playwright specs died at signup on `origin/me` too. The helper now walks the real path (Skip for now, the meter's Continue, Open the portal) and asserts a complete account already on /app directly. Red on `origin/me` at `78fc66936`, green here on the same spec; the remaining full-suite failures are a matched pre-existing set (the rebase, conflict resolutions, gates and the branch-versus-base failure diff in `FORK.d/P14-rebase.md`). | No |

## Decisions taken while building

One line each: decision, reason, date. The brief's own decisions (D-RUN-1 to D-RUN-15)
are not repeated here.

| Decision | Reason | Date |
|---|---|---|
| Fork pushed from a full clone at the tag, not the partial clone used for the source audit | A partial clone has no blobs and `git push` is rejected by the receiver | 2026-11-16 |
