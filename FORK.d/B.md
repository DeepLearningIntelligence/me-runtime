# Packet B: house models only (D-RUN-8)

Rows for the fork ledger (`FORK.md` patch log and decisions). Written by the packet B
subagent; the lead agent folds them into `FORK.md` at integration so the shared ledger
keeps one writer.

## Patch rows (for FORK.md "Patch log")

| Patch | Files | Reason | Replaceable by upstream config |
|---|---|---|---|
| Model policy module and guard | `apps/api/src/me/model-policy.ts` (new), `apps/api/src/me/model-policy.test.ts` (new) | `ME_MODEL_POLICY=house_only` refuses every create or update of a user model connection with a named 403 (`model_policy_house_only`) before any write. One guard function; every write path consults it. | No. Rakazo has no operator switch for user model keys (spike H1 disproven). |
| `ME_MODEL_POLICY` and `ME_HOUSE_CREDITS` config keys | `apps/api/src/env.ts` | Both read once in the fork's config module (`loadEnv`). An unknown `ME_MODEL_POLICY` value fails the deployment at boot, so a typo never silently allows writes. | No. |
| Policy wired into the router deps and `me` DTO | `apps/api/src/router.ts`, `apps/api/src/app.ts`, `apps/api/src/routes/shared.ts` | `RouterDeps.env.modelPolicy` is required, so the compiler refuses a build that forgets to wire it. `me.houseModelsOnly` (optional field, absent from older servers) tells the web app to hide the connect affordances. | No. |
| Guard on every connection write path | `apps/api/src/model-credentials.ts`, `apps/api/src/agent-import-services.ts`, `apps/api/src/routes/models.ts` | Enforcement points, each one call to the same guard: `verifyModelConnection` (before a key-verification call reaches a provider), `prepareModelCredential` (before the secret store sees the key), `persistModelCredential` (oRPC `models.connect`, `models.finishOAuth`), `writeModelCredential` (the lowest-level transaction writer, now exported, so any direct caller is also refused), `createImportedModelCredential` (agent import), and `beginOAuth` (refuses the OAuth connect attempt before any sign-in is created). | No. |
| `ME_HOUSE_CREDITS=true` runs hosted credits without a billing provider | `apps/api/src/app.ts` | With no Stripe config, `deploymentSettings.modelCreditsEnabled` was always false, so the metering observer never attached (spike H2). The env key turns it on at boot; billing, if configured, still wins. | No. |
| Hosted-credit funding CLI | `apps/api/src/cli/model-credit-grant.ts` (new), `apps/api/package.json` build list | `model-credit-grant.js grant <email> <amount-usd> [--cap <total-usd>]` funds one person's organization through the existing `reconcileCreditPurchase` lot machinery and optionally sets their ceiling. Without a balance the observer refuses with `HostedModelCreditsRequiredError` and run start refuses with the model-access error, both before the provider, so the grant must run when credits turn on. | No. |
| Web hides the add-your-own-key affordance | `packages/contracts/src/domain.ts` (one optional `Me.houseModelsOnly` field), `apps/web/src/pages/ModelSettingsOverlay.tsx`, `apps/web/src/pages/ModelRoleSettings.tsx`, `apps/web/src/pages/model-settings/providers-section.tsx`, `apps/web/src/pages/model-settings/role-model-picker.tsx` | With `houseModelsOnly`: the "Add provider" row is gone (the whole Providers section disappears when the account has no connections), and the model pickers no longer offer "Connect" entries for unconnected providers. The onboarding model step needs no change: it only opens when `me.needsModel` is true, which is false whenever the deployment model (the house key) is configured. | Partially: upstream has no model-policy switch, but if it ever grows one, the DTO field and UI prop stay and only the env read changes. |

## Decisions (for FORK.md "Decisions taken while building")

| Decision | Reason | Date |
|---|---|---|
| The per-person ceiling reuses the fork's existing cap; no second ceiling was built | `ME_HOUSE_CREDITS=true` attaches the existing metering observer (`hostedModelCreditObserver`), whose `beforeCall` reserves credits through `reserveModelCredits` before the provider is called. The existing per-user cap (`user.modelCreditCapMicros`, operator-set via `model-credit-cap.js set <email> <total-usd>`) is enforced inside that same reservation (`enforceModelCreditCap`), so a call over the ceiling is refused before the provider sees it. The grant CLI's `--cap` is a convenience over `setModelCreditCap`, not a new rule. | 2026-11-17 |
| A connection created before the policy existed stays, but cannot be modified | Grandfathered rows remain readable and disconnectable (disconnect and rename are unchanged), but every save against them through the write path, including a re-key, refuses with the same 403. A pre-existing user key spends on the person's own provider account, not the house's, so read-only grandfathering risks no house money; the owner deletes their personal connection per D-RUN-8. | 2026-11-16 |
| Rename and disconnect stay available under house_only | They write no secret and add no spending power; they are how existing connections are tidied up and removed. The brief's "creating or updating" is enforced at the connection writer, which covers every spend-relevant write. | 2026-11-16 |
| The policy guards writes, not probes | `models.probeCatalog` and `models.probeOpenAiCompatible` verify a typed key against a provider without saving anything and spend no house money; they are left open. With nothing connectable they serve no purpose in the UI, and the pickers no longer reach them. | 2026-11-17 |
| `ME_HOUSE_CREDITS` is read loosely (`= "true"`), `ME_MODEL_POLICY` strictly | Credits on is an opt-in deployment feature where unset means off; a wrong policy value would silently allow writes, so any value other than empty or `house_only` fails the boot. | 2026-11-17 |

## Tests

`apps/api/src/me/model-policy.test.ts` (vitest, offline, 7 tests, all pass):
1. `house_only`: the oRPC connect path refuses with code `FORBIDDEN` (HTTP 403) and the message `This deployment runs house models only and does not accept user model keys (model_policy_house_only).`; the key verifier, the secret store and the transaction writer were never called (no row, no secret, no provider call).
2. `house_only`: the direct save path (`persistModelCredential`) refuses before the secret store sees the key.
3. Policy off: the same connect path runs end to end on stubs (key stored, connection row written), so the refusals are not passing by accident.
4. Policy off: the lowest-level writer (`writeModelCredential`, called directly) writes a row.
5. `house_only`: the lowest-level writer called directly also refuses (no caller can bypass by skipping the higher paths).
6. `house_only`: a save against a connection that predates the policy refuses (decision above).
7. `parseModelPolicy` reads the deployment config and throws on any value other than empty or `house_only`.

Mutation proof for tests 1 and 3 (the guard disabled with `if (false && ...)`):
- Mutated run: 4 failed, 3 passed. `refuses the connect path ...`: `AssertionError: expected { id: 'cred-1', …(8) } to match object { code: 'FORBIDDEN' }`, i.e. the connect returned a saved connection instead of the 403; `refuses the lowest-level writer directly ...`: `AssertionError: expected [Function] to throw error including 'This deployment runs house models onl…' but got 'tx.userModelCredential.findMany is no…'`, i.e. the write ran past the guard.
- Restored byte-identically: `shasum -a 256` before and after both `155ce3dc734158f65c413cfc3ce5f8da65bcb127eef851775135ad60086a20af`.
- Restored run: 7 passed.

## Acceptance

- `pnpm --filter @rakazo/api check` → EXIT=0 (run 2026-11-17 00:06; zero type errors; earlier runs were red only from packets C and D files while they were mid-edit).
- `pnpm --filter @rakazo/api test -- model-policy` → EXIT=0. Note: pnpm appends `-- model-policy` and vitest ORs the positional filters, so this command runs the whole API suite (151 files, 1754 tests passed), including the model-policy file, not just it. The narrow equivalent used during development: `vitest run apps/api/src/me/model-policy.test.ts` (7 passed).
- `pnpm --filter @rakazo/contracts check` → EXIT=0; `pnpm --filter @rakazo/web check` → EXIT=0.
- Biome clean on all 15 changed files.

## Unverified

- Nothing here touches a live deployment: the 403 from a real HTTP call, a chat actually running on the house key, a per-person usage row, and a real refusal at the ceiling are Wave 3/4 probes on the host (section 7), not unit tests. The ceiling's pre-provider enforcement is covered by existing `packages/db` postgres tests (`model-credit-cap.postgres.test.ts`, `model-credits.postgres.test.ts`) and code reading, not re-proven here.
- The house `OPENROUTER_API_KEY` is read through `loadEnv` (`resolveDeploymentModel`, surfaced as `env.deploymentModelKey`), and nothing in this packet reads it from `process.env` anywhere new. Pre-existing direct reads of the same variable remain in `packages/adapters` (`run-model.ts` Pi fallback, `pi-runtime-models.ts`, `auto-review.ts`) and `packages/testkit` CLIs; collapsing those is an upstream refactor outside this packet's file list and should go to the section 8 untangle pass or the lead.
- `web` billing surfaces that offer an own-key funding switch (`selectFunding("byok")`, Paywall, ModelCredits) are untouched: the deployment has no Stripe config, `me.billingEnabled` is false, and the subscription gate already keeps those pages closed. If billing is ever enabled on this deployment, hiding the own-key funding option needs a follow-up row.

## Integration notes

- Deployment env for the demo host (section 6 packet W0.3 / W4): `ME_MODEL_POLICY=house_only`, `ME_HOUSE_CREDITS=true`, plus per-person `model-credit-grant.js grant <email> <amount> [--cap <ceiling>]` after each account exists. `OPENROUTER_API_KEY` stays the deployment key (`PI_DEFAULT_PROVIDER=openrouter`), which `resolveDeploymentModel` already reads through `loadEnv`.
- Packet E1 (GFIN signup hook) may want to call the grant path at account creation so a new person is funded before their first chat; the CLI body is the reference for the service-level calls (`creditAccount`, `reconcileCreditPurchase`, `setModelCreditCap`).
- Packet A's brand scan will find "Rakazo" inside untouched upstream strings my web edits did not add.
