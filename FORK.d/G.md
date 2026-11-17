# Packet G: safety config (D-RUN-12, egress, signups, recording, Treg)

Rows for the fork ledger (`FORK.md` patch log and decisions). Written by the packet G
subagent; the lead agent folds them into `FORK.md` at integration so the shared ledger
keeps one writer.

## Patch rows (for FORK.md "Patch log")

| Patch | Files | Reason | Replaceable by upstream config |
|---|---|---|---|
| Deployment action policy denies `request_purchase` at the evaluator | `packages/adapters/src/me-action-policy.ts` (new), `packages/adapters/src/me-action-policy.test.ts` (new), `packages/adapters/src/run-trust.ts` (one merge into `loadApprovalRules`), `packages/adapters/src/routine-watch.ts` (same merge at the watch-refusal rule load) | D-RUN-12: the denial is server-side for every execution path (chat, routine, subagent, API-triggered runs all consult `gateToolCall`, whose rules come from `createRunTrustLoaders.loadApprovalRules`), not merely hidden. The deployment's deny rules ride on every load of a space's saved rules, so the existing deny machinery refuses: a deny always wins, no approval mode or saved always-allow passes it, and the refusal names the rule (`"Request purchase"`) exactly like a saved one, with the audit row `tool.call denied reason=rule`. | No. Upstream has no deployment-level tool deny: `request_purchase` is approval-exempt because the wallet approves in the wallet, and upstream offers no operator switch. If upstream grows one, the module collapses to a config read. |
| The deployment's safety posture is stated in its own `.env` and enforced at every deploy | `build-me-runtime.sh` (guard before the build) | Egress, signups, session recording, paid services and the wallet are stated by the deployment's config, not inherited from the installer's choice or a stale value: `SANDBOX_COMPUTER_EGRESS=restricted` (required), `SIGNUPS_ENABLED=false` (required), `PI_SESSION_RECORDING` off (unset or `false`), `PAID_SERVICES_PROVIDER` disabled (unset or `disabled`), `PAYMENT_WALLET_PROVIDER` unset. Any other value refuses the deploy with the key named; nothing is printed but key names. | Partially: the compose files already pass every one of these through; upstream defaults (`auto` egress, signups unset) are upstream behavior with their own smoke asserting them, so the fork states the values in the deployment's `.env` instead of changing upstream defaults. |

## Where each policy is enforced (stated, not duplicated)

- **`request_purchase` (D-RUN-12).** Denied at the policy evaluation point by the deployment
  deny rule (above). Hidden independently: the wallet is unconfigured, so
  `createPaymentWalletProvider` returns null, `ExecutorDeps.paymentWallet` is null,
  `paymentWalletEnabled` is false and `selectBuiltinToolsForRun` never offers the three
  purchase tools on any run; the Settings wallet section renders only when
  `paymentWalletProvider` is present in the shared DTO, which it never is here. The deny
  does not depend on the hiding (proven in test 5 below). No payment, wallet or card
  capture exists in this build.
- **Signups (D-RUN-7).** One gate, no second one added. Three doors, each closed except
  the invite-gated phone door: (1) the email/password and email-OTP sign-up doors are
  closed by `SIGNUPS_ENABLED=false`, which `packages/auth` (`AuthEnv.signupsEnabled`)
  enforces, and the session admission hook refuses a session for a non-member when
  signups are off; (2) the phone door's admission is owned unconditionally by the
  invitations service, `apps/api/src/me/phone-signin/service.ts`: creating the person
  requires the invite hash stored on the pending row (`invite_required`, refused by
  name) and `redeemInviteByHash` claims it in the same transaction (packet D, W1-fixes
  row 2026-11-17); (3) SCIM and the `bootstrap-owner` CLI are operator doors this
  deployment does not configure or run. Nothing here re-checks what the invitations
  service already owns.
- **Session recording.** Off in code unless `PI_SESSION_RECORDING === "true"`
  (`isPiSessionRecordingEnabled`, `packages/adapters/src/pi-session.ts`); the deployment
  states `PI_SESSION_RECORDING=false` and the deploy guard refuses `true`. When off,
  `resolvePiSessionRoot` returns undefined, so no prompt or completion JSONL is written
  anywhere; even when on, transcripts write only under the deployment's own
  `DATA_DIR/pi-sessions` and never leave it.
- **Paid data services (Treg).** `PAID_SERVICES_PROVIDER=disabled` (deployment `.env`;
  compose default `disabled`) makes `createPaidServiceProvider` return undefined, so
  `paidServicesEnabled` is false and `service_search` / `service_call` are never offered.
  Note for review: a person can still add their own Treg MCP source with their own token
  (upstream connector behavior, charged to the person's own credential, no house money);
  blocking that is a connector/web change outside this packet's file list.

## Tests

`packages/adapters/src/me-action-policy.test.ts` (vitest, offline, 6 tests, all pass):
1. The evaluator refuses `request_purchase` and names the rule: `resolveActionApprovalForTools`
   with the deployment rules plus a person's saved always-allow returns `deny`, and
   `decisiveActionApprovalRules` is exactly the deployment rule, labelled `Request purchase`
   (the same composition the gate's refusal shows: `... is blocked in this space by the saved
   rule "Request purchase".`).
2. `planActionGate` returns `deny` in every approval mode (never ask, auto, ask), even with
   `purchase` set and the saved always-allow present: a person's Never-ask or Auto setting
   cannot override the deny (spike T5 negative c).
3. `watchToolRefusal` refuses a watch on the denied tool: "request_purchase is blocked, so a
   change trigger can't run it."
4. Mutation baseline: without the deployment rule, the same evaluator call with the saved
   always-allow returns `allow` (and with no rules returns `allow`) — the denial is the rule,
   not the hiding.
5. An owner chat run with no configured wallet offers no purchase tool (the deployment's
   posture), and the evaluator refuses the tool name even so.
6. `createRunTrustLoaders.loadApprovalRules` merges the deployment rules with the space's
   saved rules (the enforcement point itself, with `listApprovalRules` stubbed).

Mutation proof (rule removed, `DEPLOYMENT_DENIED_TOOLS` emptied):
- Mutated run: `Tests 4 failed | 2 passed (6)`. Failing: denies at the evaluator, refuses in
  every approval mode, refuses a watch, denies besides hiding. The decisive assertion:
  `AssertionError: expected 'allow' to be 'deny'` — with the rule gone the evaluator allows
  the action, exactly as required.
- Restored byte-identically (`git diff --exit-code` clean); restored run: 6 passed.

Deploy-guard proof (offline, temp git checkout and runtime dir):
- Posture violations each refuse with the key named, exit 1: egress not restricted,
  `SIGNUPS_ENABLED=true`, `PI_SESSION_RECORDING=true`, `PAID_SERVICES_PROVIDER=treg`,
  `PAYMENT_WALLET_PROVIDER=link`.
- Full posture passes the guard and proceeds to the build step (which then fails locally
  only because Docker is absent on this workstation).

## Acceptance

- `pnpm --filter @rakazo/api check` → EXIT=0 (2026-11-17).
- `pnpm check` (turbo, all 24 packages) → EXIT=0 (2026-11-17). One earlier red run
  (`@rakazo/adapters` type error from a test spread under noUncheckedIndexedAccess) fixed
  before the green run.
- `vitest run packages/adapters/src/me-action-policy.test.ts` → 6 passed. Also green:
  `executor.test.ts`, `index.test.ts`, `executor-readonly-approval.test.ts` (464 tests) and
  `routine-watch.test.ts`, `run-trust.test.ts` (94 tests), which exercise the two edited
  loaders end to end.
- Biome clean on all five changed files (the one warning under `packages/adapters/src`,
  `honcho-client.test.ts`, predates this packet).

## Unverified without a running deployment (spike T5 host proof)

Unit tests prove the evaluator refuses; they cannot prove which processes and paths reach it
live. For each path, the host proof and its assertion:

- **Chat**: with the wallet deliberately configured in a staging `.env` (so the tool is
  offered, proving "not merely hidden"), send a chat message asking the agent to buy
  something. Assert: the reply says it is blocked by the rule "Request purchase", the audit
  log has `tool.call` with `outcome: "denied"`, `reason: "rule"`, and the `ExternalEffect`
  table has zero rows of kind `request_purchase`.
- **Routine**: create a routine whose prompt asks for a purchase, let it fire. Same three
  assertions, plus the run's transcript shows the refusal, and the routine retry path never
  writes a purchase effect.
- **Subagent**: ask an agent (or drive `run_subagent`) to have a subagent make the purchase.
  Same assertions on the subagent's run.
- **API**: submit the task through the threads/oRPC API the way the me-stub harness does.
  Same assertions; this also proves a task that never passed through chat is denied.
- Repeat the four with the space set to Never ask and to Auto (negative c): the refusal
  persists, because the deny wins before the mode is consulted (unit-proven here; re-probed
  once on the host as T5 evidence).
- The deployment posture itself (egress `restricted` refusing computers without the host
  rules, per `egress-probe.ts`) is proven by packet J's T6 probes on the host, not here.

## Integration notes for the lead

- `FORK.md` patch log gets the two rows above; no `FORK.md` edit was made by this packet.
- The deny refusal wording says "blocked in this space"; the rule is deployment-level. The
  name is carried either way; changing the wording means touching the upstream message that
  `executor-readonly-approval.test.ts` asserts, which this packet did not do.
- The person's rule settings do not list the deployment rule (`routes/account.ts`
  `listApprovalRules` untouched): it is not theirs to change, and a listed unremovable rule
  would be worse. The refusal still names it.
- `purchase_status` (read-only status) and `paid_request` (completes an existing approved
  purchase) are unreachable without a wallet; if review wants them denied at the evaluator
  too, it is one entry in `DEPLOYMENT_DENIED_TOOLS`.
- The host's `.env` must satisfy the guard before the next deploy: `SANDBOX_COMPUTER_EGRESS`
  and `SIGNUPS_ENABLED` stated, the other three unset or off. W0.2's read of
  `T1-install.txt` confirms the egress value actually on the host; if it is not
  `restricted`, the installer's `restrict-computer-egress.sh` must run first (owner/lead,
  host-side).

## Owner items

- None new. The posture values themselves live in the host `.env` (already stated there per
  the brief's section 2, LIVE row); the guard only refuses a deploy that contradicts them.
