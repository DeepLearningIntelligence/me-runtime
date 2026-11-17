# Packet H: the onboarding flow (Wave 2)

Rows for the fork ledger (`FORK.md` patch log and decisions). Written by the packet H
subagent; the lead folds them in at integration.

## Patch rows (for FORK.md "Patch log")

| Patch | Files | Reason | Replaceable by upstream config |
|---|---|---|---|
| Onboarding flow module | `apps/web/src/me/onboarding/` (new: `flow.tsx`, `flow.test.tsx`, `welcome.tsx`, `welcome.test.tsx`, `phone-signin.tsx`, `door.ts`, `door.test.ts`, `entry.ts`) | D-RUN-5, D-RUN-7, the Wave 2 H row: one path, six screens. `door.ts` is the browser half of the phone door: `start` carries the invite token (admission is invite-only; the invitations service redeems the hash the pending row kept, so the token rides with the start call and nowhere else), `verify` sends only nonce and code, and every server refusal (`invite_required`, `invite_invalid`, `rate_limited`, `code_expired`, `too_many_attempts`, …) is shown with named, actionable copy. `welcome.tsx` is the invite landing page: it calls the public `invites.inspect`, names the inviter, says what the product is in one sentence, and hands the token to `/sign-in?invite=<token>`. `flow.tsx` is the one onboarding path at `/onboarding`: name (saved with `authClient.updateUser`), email ("Skip for now" only, because the Google redirect is not configured; the copy says so), choose WhatsApp, link WhatsApp (real linking: `ensureFirstBot`, then `messaging.link.start`, a wa.me deep link prefilled with the link code, and a poll of `messaging.status` that advances when the identity lands; skip is offered and honest), the invites meter read from `invites.list` (quota row, never a client number) with the one concrete reward line, and the done screen. A person who opened an invite link (session flag from the welcome page) ends on one primary button, Back to WhatsApp (`https://wa.me/<number>`); a person who started on the web ends in the portal with WhatsApp offered. An account that is already set up is moved to `/app`, and an account with no bot always reaches the step that creates one, so the empty-space route into `/onboarding` cannot bounce. | No. |
| One onboarding path | `apps/web/src/pages/Onboarding.tsx` and `Onboarding.test.tsx` deleted, `apps/web/src/pages/onboarding/model-step.tsx` and `use-onboarding-model.ts` deleted, `apps/web/src/components/SignupSurvey.tsx` deleted, e2e specs `onboarding-signup-survey.spec.ts` and `onboarding-model-required.spec.ts` deleted | The authority table gives onboarding one owner (`apps/web/src/me/onboarding/*`); the upstream survey/model/BYOK steps contradict the house-models rule (D-RUN-8) and would be a second path. Deleted, not hidden (no shim). `pages/onboarding/first-bot.tsx` stays: the flow reuses its idempotent first-bot creation. Packet K should re-cover the removed screens in the new E2E suite. | No. |
| Phone-first sign-in page | `apps/web/src/pages/Auth.tsx` (modified), `apps/web/src/pages/Auth.test.tsx` (modified) | D-RUN-5: when the server reports the phone door (`phoneSignin` capability), the sign-in page opens on the WhatsApp door with a small "Sign in with email" link that reveals the existing email form, which stays for the owner and admins; passkeys and emailed codes on that form are unchanged. Email sign-up is removed with the form: accounts are created only through the invite link and the door. The footer's "Sign up" link became the invite-only line ("me.io is invite-only. Open the invite link you were sent, or ask your inviter for one."), so nobody is sent to a dead form. The auth frame's abstract circle mark became the real me.io mark (`/brand/me-mark.png`, packet A's asset). | Partially: the tab default could be config; the removal of sign-up is a product decision. |
| Routes and landing | `apps/web/src/App.tsx` (modified) | The `/welcome` route (public), `/sign-up` reduced to a redirect to `/sign-in`, and `/` now lands everyone on `/sign-in` (invite-only product; `hasSignedInBefore` no longer picks a sign-up page). The `/onboarding/:step?` route element is `MeOnboardingPage`. Nothing else routes to a removed surface. | No. |
| Public capabilities for the door and deep links | `packages/contracts/src/auth.ts`, `apps/api/src/app.ts` (capabilities route) | `phoneSignin` (the door is configured: identity hash key and business line) and `whatsappChatUrl` (`https://wa.me/<digits>`; the same shape the router's deep-link builder mints) let the sign-in page and the onboarding build wa.me links without a second config surface. Optional fields, so older servers parse unchanged. The digit normalization is a second read of `WHATSAPP_BUSINESS_NUMBER` beside the router's builder; both live behind the one env key. | No (it is config-derived output, not behaviour). |
| Inspection carries the person-facing copy | `packages/contracts/src/invites.ts`, `apps/api/src/routes/invites.ts` | `invites.inspect`'s refusal branch now returns `message` from the invitations module's one copy map (`INVITE_FAILURE_MESSAGE`), so the welcome page never re-implements invite copy. One authority for the words; the client renders what the server says. | No. |
| E2E helpers follow the flow | `apps/web/e2e/helpers.ts`, `apps/web/e2e/auth-lifecycle.spec.ts` | `signup()` lands on `/onboarding` (no sign-up page, no verify-email branch), `completeOnboarding()` walks the me flow (skip the link step, meter Continue, Open the portal), `signupThroughForm` is deleted with the form. `auth-lifecycle.spec.ts` retargets the blank-until-ready and narrow-phone tests at `/sign-in`, drops the sign-up-form tests, gains a phone-door test (mocked capabilities with `phoneSignin`, asserting the start call carries `{inviteToken}` and the wa.me link shape), and uses the API signup like every other spec. Note: e2e dev servers without `ME_IDENTITY_HASH_KEY`/`WHATSAPP_BUSINESS_NUMBER` keep the email form, so the other ~40 signup-based specs are untouched. | No. |
| WhatsApp brand colour exception | `biome.jsonc` | The onboarding's WhatsApp icon carries WhatsApp's own green (`#25D366`), the same class of exception as the existing `bot-avatar.tsx` and `WindowChrome.tsx` ignores in the no-hex plugin. One line in the plugin's exclude list. | No. |

## Decisions (for FORK.md "Decisions taken while building")

| Decision | Reason | Date |
|---|---|---|
| The invite token travels only in the start call, never in the verify call | The phone door's pending row carries the token's hash through the WhatsApp round trip (the W1-fixes decision); the browser sending it again would be a second copy of the binding. The unit test pins the start payload; the e2e phone-door test asserts the same wire shape. | 2026-11-17 |
| Entry origin is a session flag set by the welcome page, not a referrer check | "Started in WhatsApp" is not observable server-side; opening an invite link is the WhatsApp arrival, so the welcome page records `me.started-from=invite` in sessionStorage and the done screen branches on it. A direct web arrival has no flag and ends in the portal with WhatsApp offered. Storage failures degrade to the portal ending, never to a broken screen. | 2026-11-17 |
| The "Phone person" name is the marker of an unfinished onboarding | Packet C's module created phone persons with that neutral display name and the brief gives onboarding the name step; the flow uses it to decide where a returning sign-in resumes (name step when untouched, link step when the bot or WhatsApp identity is missing, `/app` when complete). Replacing it would need a server-side flag; none was added. | 2026-11-17 |
| The email step offers "Skip for now" only, and the copy says Google is not set up yet | The brief's exact instruction until the Google redirect URI is an owner item. A fake connect button or a client-side email change would either be a dead step or a second identity path (Better Auth would create a second account, not merge); the real design for account linking is deferred until the redirect exists. | 2026-11-17 |
| The link step links through the fork's own mechanism, never a second one | The fork binds a WhatsApp to a bot only through a redeemed link code (`messaging-inbound`'s `tryRedeemLinkCode`). Onboarding mints that code, deep-links it into wa.me, and polls `messaging.status`; it does not write a messaging identity directly. Skip is offered with the honest consequence visible in Settings later. | 2026-11-17 |

## Verification (packet H)

- `pnpm --filter @rakazo/web check` -> EXIT=0.
- `pnpm --filter @rakazo/web build` -> EXIT=0 (built twice; the second run also fed the
  screenshot pass).
- `pnpm check` -> EXIT=0 (24/24 turbo tasks; at one intermediate point it was EXIT=1 on
  another packet's in-progress `gfin-connection.ts`, which that session fixed; the final
  run is green).
- `pnpm --filter @rakazo/web test` -> EXIT=0 (2076 passed, 230 files) after the type-scale
  guard caught an off-scale `text-[16px]` in `flow.tsx` (fixed with the same `off-scale:`
  comment the Auth page uses).
- Targeted: `apps/web/src/me/onboarding` + `apps/web/src/pages/Auth.test.tsx` -> 28 passed.
- API surface: `pnpm --filter @rakazo/api exec vitest run --root ../.. apps/api/src/router.test.ts`
  -> 390 passed (covers the `invites.*` RPC surface, including the inspect message field).
- Biome check over every touched file -> clean (two pre-existing `DB_POOL_MAX`
  undeclared-env warnings in `apps/api/src/app.ts`, lines 268/345, not from this packet).

### The invite-token handoff test and its mutation

`apps/web/src/me/onboarding/door.test.ts` asserts the start call's body is exactly
`{ inviteToken: "tok_en1" }` (and that verify sends only nonce and code).

Mutation: replaced `{ inviteToken: input.inviteToken }` in `door.ts` with `{}` ->
`sends the invite token with the start call, because admission is invite-only` failed with
`expected {} to deeply equal { inviteToken: 'tok_en1' }` (1 failed | 4 passed). Restored
byte-identically (sha256 `737c92fc704cfb9bc1acf6a9cda5a7470e95dcab24cdadbd4a73132aeea88ecf`
before and after) -> 5 passed. The same wire shape is asserted end-to-end in
`apps/web/e2e/auth-lifecycle.spec.ts` ("the WhatsApp door is the sign-in page's default…",
`expect(startBodies[0]).toEqual({ inviteToken: "token-1" })`).

## Design pre-flight (design-taste-frontend)

The skill is loaded; the desktop browser tool was unavailable in this session, so the
pre-flight ran on the built app served by a scratch local server with canned answers,
driven by the app's own headless Chromium (Playwright) instead of the skill's static-page
shooter. Screenshots of all changed screens at 390x844 and 1280x900 are in
`FORK.d/shots/h/` (01-welcome through 10-done, both widths).

Reported against the skill checklist (landing-page-only rules skipped for this dense app
UI, per the taste family's own rule):

- One system: every screen reuses the auth frame's plate, type scale, radius and the
  single primary button style; the meter and option card use the theme tokens only.
  One real brand icon (WhatsApp's own glyph, in its own green).
- Copy: short, plain, specific. No filler; every refusal names what to do next. The
  welcome screen says what the product is in one sentence.
- Equal edges, no sideways scroll at 390 (checked by the narrow-viewport screenshots);
  labels on every input; the code field shows the design system's visible focus ring.
- No placeholder data, no fake progress: every button on every screen performs real work
  (the email step's "Skip for now" is the brief's own instruction, and its copy says why).
- Two findings were fixed during the pass: the email step's copy was tightened, and an
  off-scale text size got the scale-guard comment. One runtime defect the screenshots
  caught: a `t` identifier leaked into effect deps after the macro compiles it away
  ("t is not defined" on the built chunk); fixed by keeping only macro calls in deps.
- Not checked: screen-reader passes and the 200 ms interaction budget (measure, not
  assert) belong to the Wave 3 gates; no local measurement was taken here.

## Not verified here

- No live end-to-end round trip: the screenshots run against canned answers, and the
  real webhook path (Meta -> router -> door -> person -> session -> onboarding) has not
  been executed on this machine. The first live sign-in is Wave 3's harness and T-suite.
- The e2e suite (Playwright) was updated for the new flow but not run locally (it needs
  the dev server stack with a database, which this environment lacks); the updated specs
  are type-checked (`pnpm --filter @rakazo/web check` covers `e2e/tsconfig.json`).
- `messaging.link.start` was exercised only through the canned server; on a deployment
  with messaging disabled the step shows its honest unconfigured state.
- The Google path of the email step is deliberately not wired (see decision above).
- Working-tree note for the lead: mid-packet, another session ran `git stash` + `git
  reset` and then popped the stash back; after the round trip every packet-H edit was
  re-verified present and the gates were re-run green. Do not reset the shared tree
  while Wave 2 packets hold uncommitted work.
- Owner items this packet leans on: the Google redirect URI (until then the email step
  is skip-only) and the business number / identity hash key config for the live door.
