# Packet C: Phone sign-in (D-RUN-5, webhook side of D-RUN-6)

Rows for the fork ledger (`FORK.md` patch log and decisions). Written by the packet C
subagent; the lead folds them into `FORK.md` at integration so the shared ledger keeps
one writer.

## Patch rows (for FORK.md "Patch log")

| Patch | Files | Reason | Replaceable by upstream config |
|---|---|---|---|
| Phone sign-in module | `apps/api/src/me/phone-signin/` (new: `codes.ts`, `identity.ts`, `service.ts`, `session.ts`, `routes.ts`, `index.ts`, `service.test.ts`) | D-RUN-5: the phone door as one authority over `me_phone_signins` and `me_phone_signin_messages`: start (pending row, only hashes stored), bind (webhook entry `whatsAppSignInHandler` matching the router's contract, provider-message-id claim in the same transaction as the bind), verify (constant-time, single use, 5 attempts then named lockout, named expiry), person + session creation through the fork's own auth. | No. Rakazo has no phone sign-in; the ported me.io pattern is the feature. |
| Phone sign-in tables | `packages/db/prisma/schema.prisma`, `packages/db/prisma/migrations/20261217120000_me_phone_signin/` (new) | Two tables, both RLS with the standard `app_rls_bypass()` system policy, following the existing migration file style. Adding tables only, so the previous release keeps running. | No. |
| `issueSession` on the auth object | `packages/auth/src/index.ts`, `packages/auth/package.json` (adds `@better-auth/core: 1.7.18`, already in the dependency tree) | The auth layer is the one owner of session creation; phone sign-in needs to issue a session outside a Better Auth HTTP endpoint. `issueSession` runs the internal adapter's `createSession` inside `runWithEndpointContext` carrying the request's headers, so the exact same session hooks (workspace admission, security events) fire as for every other sign-in. | No. Better Auth has no passwordless "sign in as this user" endpoint; its phone-number plugin assumes it delivers the OTP itself, which the WhatsApp door does not. |
| `ME_IDENTITY_HASH_KEY` config key | `apps/api/src/env.ts` | HKDF source for the one phone-identity HMAC. Read once in the fork's config module; the module refuses (`identity_key_missing`) when it is unset. | No (it is config; the feature is closed without it). |
| Phone routes mounted before the auth catch-all | `apps/api/src/app.ts` | `mountPhoneSigninRoutes(app, { prisma, auth, env, clientIp })` runs `POST /api/auth/phone/start` and `/api/auth/phone/verify` inside the existing `runAsSystem("authentication")` middleware and before Better Auth's `/api/auth/*` handler, the same precedence pattern `/api/auth/capabilities` uses. | No. |
| Router call site adapted to the real module | `apps/api/src/messaging-runtime.ts` | Packet F's temporary seam passed a curried shape; the mount now reads `signIn: whatsAppSignInHandler(prisma, { identityHashKey: env.meIdentityHashKey })` from `me/phone-signin/index.ts`. One line plus the import; F owns the rest of that file. | No. |
| Welcome email skips phone-created people | `apps/api/src/marketing-email.ts` | A phone person's email is synthetic (`@phone.invalid`, undeliverable by construction) until onboarding connects one; the guard stops the first sign-in from producing a welcome delivery that can only bounce. | No. |
| Row-security model registry | `packages/db/src/row-security.ts` | `MePhoneSignin` and `MePhoneSigninMessage` added to `ROW_SECURITY_MODELS`, so the fork's own RLS enforcement treats them like every protected table. | No. |

## Decisions (for FORK.md "Decisions taken while building")

| Decision | Reason | Date |
|---|---|---|
| One secret does both jobs: the browser's pending token and the `ME-<nonce>` in the wa.me link are the same value, stored only as its SHA-256 | The brief mints one nonce per door and stores only its hash. Two secrets would mean two stored hashes and a second binding surface; me.io's door worked the same way. | 2026-11-16 |
| Phone persons are portal users with a synthetic `@phone.invalid` email, not `@messaging.invalid` users | The fork's auth layer deliberately blocks every authentication path for `@messaging.invalid` users, and that guard must stay intact. A phone person is a portal person; their email is undeliverable by construction and never asserted as a mailbox. One phone hash is one user id, so concurrent first sign-ins converge on one row. | 2026-11-16 |
| The workspace is bootstrapped before the session is issued | The auth session hook admits a session only for a member or an open signup; with `SIGNUPS_ENABLED=false` on the host, a verified phone would otherwise be refused at the last step. `bootstrapUserSpace` is the fork's own provisioning primitive. | 2026-11-16 |
| The provider-message-id claim is committed even when the bind refuses | An unknown nonce, an expired door or a second message for a bound nonce is still a processed message: Meta's retry must not redo any of it. The claim and the bind are one transaction, so a transient failure rolls the claim back and the retry works. | 2026-11-16 |
| Strict single reply: a lost code is recovered by opening a new door, never by re-replying | The code is stored only as a hash, so a replay cannot resend it, and "the same nonce must never bind twice" forbids a second mint. If the reply send fails after the claim commits, the person restarts the door. Packet F's FORK.d note proposes an outbox send as the later fix; that send path is F's file. | 2026-11-16 |
| Doors are capped at 10 per client address per 15 minutes by a row count | Multi-instance safe (a database count, not an in-process counter), and the counter is the pending table itself, so no second meter exists. | 2026-11-16 |
| `start` takes an optional E.164 phone; when present, the bind refuses a different sender (`phone_mismatch`) | The number is normally learned from WhatsApp, but the web form may pass one; the door then belongs to that phone and the code can never belong to another. | 2026-11-16 |

## Tests

`apps/api/src/me/phone-signin/service.test.ts`: 9 vitest tests against an in-memory store
that mirrors the service's conditional-update predicates; no database needed. They cover
all six required behaviours plus single-use redemption, the per-address door cap, and the
fail-closed paths (`identity_key_missing`, invalid phone).

Mutation proofs (break, failing output, restore byte-identically, passing output; sha256
of `service.ts` identical before and after each round):

1. Replay claim ignored (catch swallows instead of returning `replayed`): "never mints a
   second code for a replayed provider message id" failed, 1 failed | 8 passed.
2. Wrong-phone guard removed: "never verifies a code minted for phone A against phone B"
   failed; the stranger's message minted a code, 1 failed | 8 passed.
3. Lockout ceiling off by one (`>` instead of `>=`): "refuses the sixth attempt with a
   lockout name" failed; the sixth attempt verified successfully, 1 failed | 8 passed.

## Acceptance

- `pnpm --filter @rakazo/api check` -> EXIT=0.
- `pnpm --filter @rakazo/api test -- phone-signin` runs the whole API suite (the repo's
  test script takes no extra filter): 100 files, 1754 passed -> EXIT=0.
- Targeted: `pnpm --filter @rakazo/api exec vitest run --root ../.. apps/api/src/me/phone-signin`
  -> 1 file, 9 passed -> EXIT=0.
- `pnpm --filter @rakazo/auth check` -> EXIT=0; `pnpm --filter @rakazo/db check` -> EXIT=0;
  db package tests 553 passed (postgres-dependent files skipped, not run); the
  marketing-email and messaging-webhook tests touched by this change: 260 passed.

## Not verified here

- The migration has not been applied to a real Postgres (no database in this
  environment); `prisma migrate deploy` and the RLS policy check run on the host.
- No live Better Auth round trip: `issueSession`'s hook path, the signed session cookie
  and the person creation are type-checked and read against Better Auth 1.7.18's source,
  but the first real sign-in (Wave 3 harness or T-suite) must watch for the session hook
  admitting the phone person.
- The full webhook flow (Meta POST -> F's router -> this module -> reply) is wired per
  F's FORK.d integration note but not executed here.
- Owner item: `ME_IDENTITY_HASH_KEY` must be set on the host (non-secret, high-entropy
  random value) for the door to open; `WHATSAPP_BUSINESS_NUMBER` (packet F's row) for the
  deep links.
