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
| P11 phone sign-in fixes | `apps/api/src/me/phone-signin/{service,session,routes}.ts`, `apps/api/src/cli/bootstrap-owner.ts`, `packages/db/prisma/schema.prisma`, `packages/db/prisma/migrations/20261118095000_me_user_phone_hash`, web onboarding `door.ts`, `phone-signin.tsx`, `flow.tsx` | A refused admission no longer burns a correct code (the consume rides in the admission transaction); the owner can seed and signed-in people can link a phone (`user.phoneHash`, one hash per person); a dead door gets one answer and a replay none; the code and the business number stay on screen with a copy button; wa.me links open in the same tab and the door survives the trip. Details, tests and mutations in `FORK.d/P11.md`. | No |

## Decisions taken while building

One line each: decision, reason, date. The brief's own decisions (D-RUN-1 to D-RUN-15)
are not repeated here.

| Decision | Reason | Date |
|---|---|---|
| Fork pushed from a full clone at the tag, not the partial clone used for the source audit | A partial clone has no blobs and `git push` is rejected by the receiver | 2026-11-16 |
