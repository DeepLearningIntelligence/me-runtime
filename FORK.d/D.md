# Packet D: invitations (D-RUN-7)

Rows for the fork ledger (`FORK.md` patch log and decisions). Written by the packet D
subagent; the lead agent folds them into `FORK.md` at integration so the shared ledger
keeps one writer.

## Patch rows (for FORK.md "Patch log")

| Patch | Files | Reason | Replaceable by upstream config |
|---|---|---|---|
| Invitation service module | `apps/api/src/me/invitations/invitations.ts` (new), `apps/api/src/me/invitations/invitations.test.ts` (new), `apps/api/src/me/invitations/invitations.postgres.test.ts` (new) | D-RUN-7 as one owner: hashed tokens only (SHA-256, the raw token is never stored or returned after issue), issue/redeem/inspect/list/revoke. Redeem is one interactive transaction: the claim is a compare-and-swap on `status = "issued"`, so of two concurrent redeemers exactly one wins and the loser's quota increment rolls back with its transaction; every refusal carries a named reason (`invalid`, `already_redeemed`, `expired`, `revoked`, `quota_exceeded`). The quota lives in the person's quota row; every guard reads it there, never from client input. Inspect returns the inviter's display name for the welcome page. | No. |
| Quota and invite tables | `packages/db/prisma/schema.prisma` (`MeInviteQuota`, `MeInvite` models plus User relations), `packages/db/prisma/migrations/20261116120000_me_invitations/migration.sql` (new) | Additive tables `me_invite_quotas` (one row per person: `allocation`, `grantedCount`, `redeemedCount`, CHECK constraints) and `me_invitations` (unique `tokenHash`, status, expiry, redeemed-by, revoked-at). The org `invitation` and `space_invites` tables are unrelated and untouched. | No. |
| Row-level security for the two tables | `packages/db/prisma/migrations/20261116120000_me_invitations/migration.sql`, `packages/db/src/row-security.ts` | Both tables ENABLE ROW LEVEL SECURITY with a tenant policy (the inviter's own rows) and a system policy. The models join `ROW_SECURITY_MODELS`, so any read outside `runAsTenant`/`runAsSystem` is refused and logged. Cross-person reads (redeem, public inspect) run as system inside the service, each with a named reason. | No. |
| `ME_INVITE_ALLOCATION` and `ME_INVITE_TTL_DAYS` config | `apps/api/src/env.ts` | Defaults 10 invites per person and 14 days per link, read once in the fork's config module. A set value must be a positive whole number or the deployment refuses to boot. The config value only seeds a person's first quota row; the row then owns the number, so later config changes never silently rewrite an existing allowance. | No. |
| RPC surface for the invites screen and welcome page | `packages/contracts/src/invites.ts` (new), `packages/contracts/src/index.ts`, `packages/contracts/src/rpc.ts` (`invites` section), `apps/api/src/routes/invites.ts` (new), `apps/api/src/router.ts`, `apps/api/src/app.ts`, `apps/api/src/rpc-errors.ts` | `invites.issue` (authed), `invites.list` (authed: the 0/10 meter plus the person's links), `invites.revoke` (authed), `invites.inspect` (public: the welcome page names the inviter, or the named refusal, before anyone signs in). `InviteError` maps to CONFLICT (`quota_exceeded`) or BAD_REQUEST (the rest) with the reason in `error.data.reason` and the person-facing copy in one map owned by the invitations module. | No. |

## Decisions (for FORK.md "Decisions taken while building")

- D-2026-11-16. The new tables are `MeInvite`/`MeInviteQuota`, not `Invitation`: Rakazo's own
  `Invitation` (org member invites) and `SpaceInvite` already own those names; the me tables map
  to `me_invitations`/`me_invite_quotas`. Reason: no collision, no rename of upstream tables.
- D-2026-11-16. Redeeming twice refuses with `already_redeemed` rather than me.io's
  idempotent-same-user retry. Reason: the fork redeems inside the account-creation transaction,
  so a retry always runs against an un-redeemed row; a second claim of a spent token is
  indistinguishable from an attack and is refused.
- D-2026-11-16. Revoking a link does not refund the inviter's allowance; the meter counts minted
  links. Reason: a refund path can be raced to mint more than the allocation; me.io made the same
  choice. Revisit only if the demo shows it matters.
- D-2026-11-16. The failure message map lives in the invitations module and `rpc-errors.ts` maps
  `InviteError`, instead of the route handlers catching. Reason: one authority for the copy, and
  any future caller (account creation) gets the same named refusal for free.

## Verification (packet D)

- `pnpm --filter @rakazo/api check` EXIT=0 (after the concurrent packets' in-progress
  `me/phone-signin` files settled; two intermediate runs failed only on those files, none on
  packet D's).
- `pnpm --filter @rakazo/api test -- invitations` EXIT=0 (1754 passed, 354 skipped; the skip
  count includes the Postgres-marked suite below).
- Biome check over every touched file: clean.
- Mutations on the guards (file restored byte-identically after each, sha256
  `0a7ea35aaaf6191ccdbc951f2a91f466e88a4781` before and after):
  - Claim predicate `where: { id: invite.id, status: "issued" }` broken to
    `where: { id: invite.id }`: suite fails with
    "a racer whose read predates another's claim still cannot claim it: promise resolved
    `{ inviterId: 'inviter', ... }` instead of rejecting" (both racers claimed). Restored: pass.
  - Quota CAS predicate `redeemedCount: { lt: quota?.allocation ?? 0 }` dropped: suite fails with
    "a full quota refuses a redemption by name: promise resolved `{ inviterId: 'inviter', ... }`
    instead of rejecting". Restored: pass.

## Not verified

- `invitations.postgres.test.ts` (two concurrent `Promise.allSettled` redeems of one token, one
  success, `redeemedCount` exactly 1) was written but NOT RUN: it needs Postgres
  (`VERIFY_DATABASE=1` plus `DATABASE_URL`), and no local Postgres is reachable here
  (`pg_isready 127.0.0.1:5432` gives no response). It is collected and skipped by the suite; the
  lead should run it once a database exists (the host or `VERIFY_DATABASE=1` locally).
- The `invites.*` RPC surface has no HTTP-level test; the route handlers are thin (date
  serialization plus the shared error mapping) and the service carries the logic. Packet H's
  screen exercises it end to end.
