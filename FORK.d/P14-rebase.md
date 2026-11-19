# P14 rebase: `me-p14-whatsapp-default` onto `origin/me` at `78fc66936`

This file records the rebase of the WhatsApp-default packet onto the current `me`
(`78fc66936`, which adds P15 base green, P16 UTC timestamp fixes and P12 link
authority on verify), the conflict resolutions, and the gates, including one
base-branch e2e defect this proof had to fix to reach any verdict at all.

## The rebase

- Base: `a9fe0cc`; branch tip before rebase: `9184e960` (already carrying the
  review's selector fix). Rebased onto `78fc66936`.
- `git rebase origin/me` conflicted once, in `FORK.md`: the base side's patch
  rows P15, P16 and P12 against this branch's P14 row. Resolution: all four
  rows kept, P14 after P12 (the first continue left the two marker lines in;
  caught by re-reading the file, fixed and autosquashed into the record
  commit, `grep -c` on the markers is 0).
- `apps/api/src/me/phone-signin/routes.ts` merged textually clean but
  semantically broken: the auto-merge kept P12's row-driven structure but
  P14's post-link call inside it still read `linkUserId!`, a request-scoped
  name that no longer exists. Resolution, keeping both authorities with P12's
  winning on the mode: the row (`verified.linkUserId`) decides link versus
  sign-in, never the request; a `link` flag on a plain door is still refused
  `400 link_not_started` with nothing attached; the sender address is read
  only to attach WhatsApp after a success, and the attach targets `userId`,
  the session person P12's check just validated (a mismatch throws
  `session_mismatch` before anything attaches). No request-driven branch
  returned.
- `session.ts`, `service.ts` and `schema.prisma` did not conflict; the sender
  plumbing survived the merge whole (`attachWhatsappAfterSignin`, the sealed
  `senderAddress` column and migration `20261219100000` are present).
- `apps/api/src/me/phone-signin/routes.test.ts` (created on `me` by P12, never
  touched by P14) needed P14's new `jobs` dep on the mount helper, an explicit
  `senderAddress: null` in the fixture, and the two completion assertions now
  see the named `whatsapp: "not_attempted"` state these fixtures must produce.

## Gate results on the rebased branch

- `pnpm check`: 24/24 tasks, exit 0 (rerun on the final tree, after the e2e
  helper fix below).
- `pnpm --filter @rakazo/api test`: exit 0, 103 files passed, 52 skipped;
  1797 passed, 355 skipped (the database suites skip bare, by design).
- `pnpm --filter @rakazo/web test`: exit 0, 231 files, 2093 tests, all passed.
- Database gate `CI_POSTGRES_URL=.../me_p14_gate pnpm test:integration`
  (local `postgresql@18`, throwaway database, the harness's own migration and
  per-file copies): needed four runs. Runs 1-3 failed 4, 1 and 6 tests, each
  a different wandering set (`bootstrap-owner`, `journeys 17`, the two eval
  fixtures, `byok-trial-owner`, `group-history-speakers`, `history-files`,
  `history-product-loop`), every one a timeout under full parallel load on a
  default-config server (fsync on, max_connections 100; the container path
  the harness would otherwise start tunes 500 and fsync off). Every failing
  file passes alone, several 5-10x faster (338s to 37s). Run 4: exit 0, 157
  files, 1059 tests, all passed. Shape matches the load flakes P16 recorded
  on this machine; none of the failures overlaps a file this packet touches.
- Full e2e (`pnpm test:e2e`, 313 specs, 2 workers): red, and not by this
  rebase; see below.

## Base fix: the e2e onboarding walk (`apps/web/e2e/helpers.ts`)

The full e2e suite died at signup on 210 of 313 specs, all at one line:
`completeOnboarding` waited for "Open the portal" or "Chief" before any
click, but the me flow lands a fresh email account on the skippable Connect
WhatsApp step, where neither exists. Packet H's record says the updated e2e
suite was "not run locally" (`FORK.d/H.md`), and the suite has been red on
`me` since.

Proof it is not the rebase: the identical spec fails identically on a
detached checkout of `origin/me` at `78fc66936`, same helper line, same
stuck screenshot.

Fix (base fix, like P15 and P16's): `completeOnboarding` walks the real path
(Skip for now on the link step, Continue on the invite meter, Open the
portal) and asserts a complete account already moved to `/app` directly. The
P14 proof spec `me-whatsapp-default.spec.ts` does not use the helper, so the
packet's own screens are untouched.

With the fix, both sides were run once each, same worker count, comparable
load:

- Branch (`4c3ed686f`): 268 passed, 43 failed (23.4m).
- `origin/me` + the same helper fix: 262 passed, 47 failed (24.1m).
- Failure-set diff: zero tests fail on the branch but not on the base; the
  base has 4 extra failures (load flakes that passed on the branch run). The
  residual red is a pre-existing, matched set on `origin/me`: spec and UI
  drift from earlier fork packets (the removed "What do you want me on
  first?" choice step, the shared-spaces Invite selector colliding with the
  People nav button, nightly sign-in capability mocks), layout metrics, a
  CDP-based page helper returning `ok: false`, and 120s-cap timeouts. That
  set is a packet of its own (the shape P16 ran for the integration gate);
  this rebase packet does not own it.

Two later branch e2e attempts are discarded as results and noted honestly:
one ran against a gate database still holding the previous run's data (the
worker resumed its leftover jobs; wrong setup, my error), and one ran while
the machine sat at load average 367 on 8 cores (sibling sessions running
their own gates plus runaway OpenCode renderer processes); single API jobs
took 54 minutes. Their numbers describe the machine, not the branch. The
two-green-runs requirement needs a quiet window or CI; it is not met here
and is not claimed.

## Known product defect seen in the logs, not touched

`rpc invites/list` fails intermittently with `P2002 meInviteQuota.upsert`
(unique constraint `me_invite_quotas_pkey`), a concurrent-upsert race in
`apps/api/src/me/invitations/invitations.ts` around line 227, answering 500.
Present on `origin/me` as well; the meter still renders its Continue, so e2e
specs pass, but the 500s are real and the upsert needs an owner decision
(conflict target or catch-and-retry).

## Databases

All work ran on throwaway databases (`me_p14_gate` recreated fresh per run,
`me_p14_base_gate` for the baseline checkout, plus the harness's `me_p14_gate_`
and `me_p14_base_gate_%` per-file copies). Every copy and both gate databases
are dropped at the end; `me_io` and every other server database untouched.
The `rakazo_app` login role the harness creates stays, because sibling
sessions are running their own gates against the same local server right now.
