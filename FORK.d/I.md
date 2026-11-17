# Packet I: portal information architecture (D-RUN-10)

Rows for the fork ledger (`FORK.md` patch log and decisions). Written by the packet I
subagent; the lead agent folds them into `FORK.md` at integration so the shared ledger
keeps one writer.

## What the portal is

The fork's portal is the existing authenticated shell (`/app`) with the account menu as
its navigation. Every destination is an existing surface, reached or relabelled, not a
new one:

| Reference destination | Portal surface |
|---|---|
| Vault | Settings, Vault section (existing `VaultSettings`), plus the Go Fund It Now row |
| People | Settings section relabelled People (the existing messaging panel), plus the space's members (existing `SpaceMembersSettings`) |
| Invites | New section in the same Settings overlay, reading packet D's `invites.*` RPC |
| Settings | Settings, General section: account, secure sign-in (passkeys), data controls, delete account (all existing) |
| Channels | inside People (the fork's one panel holds both; see decisions) |
| Connectors | the existing "Connect apps" pill and integrations overlay |
| Files, generated assets, pages an agent produced | the existing Artifacts page at `/app/artifacts`, relabelled Files |

## Patch rows (for FORK.md "Patch log")

| Patch | Files | Reason | Replaceable by upstream config |
|---|---|---|---|
| Portal menu: Vault, People, Invites, Settings, Files | `apps/web/src/components/SidebarFooter.tsx`, `apps/web/src/pages/shell/shell-sidebar.tsx` | The account menu is the portal's navigation. It gains Vault (settings vault section), People (settings People section), Invites (settings Invites section); the Artifacts entry is relabelled Files. "Get the mobile app" and the upstream self-host "Docs" link are removed (D-RUN-4 hides mobile prompts; self-hosting is not this product's surface). The referral-gated "Invite friends" entry and its `InviteDialog` are removed: invitations belong to the fork's own invites meter, which never depends on billing. | Partially: upstream hard-codes the app-store URLs and the docs link in the menu. |
| Invites section | `apps/web/src/pages/InvitesSettingsPanel.tsx` (new), `apps/web/src/pages/InvitesSettingsPanel.test.tsx` (new), `apps/web/src/pages/SettingsOverlay.tsx`, `apps/web/src/pages/settings-nav.ts`, `apps/web/src/pages/shell-overlay.ts` (new section id `invites`) | The meter (links minted of the allowance, from `invites.list`'s quota row, never client-supplied), minting through `invites.issue` with the link shown once, WhatsApp share first then copy, minted links with status and `invites.revoke` withdrawal. The reason line is the one honest reward (a person who joins can connect their agent with yours), per D-RUN-7. | No. Upstream's invite surfaces are org-member invites with no personal meter. |
| Vault hides cards | `apps/web/src/me/product.ts` (new), `apps/web/src/components/VaultSettings.tsx` | The New menu offers no Card kind (D-RUN-12: money stays out). An item of kind card that predates this build still lists and filters, so existing data is never orphaned; the editor's card fields stay for editing such an item. `OFFERED_VAULT_KINDS` is the one place the product's offered vault kinds are named. | No. Upstream offers cards unconditionally. |
| Vault shows the GFIN connection without the key | `apps/web/src/me/gfin.tsx` (new), `apps/web/src/components/VaultSettings.tsx` (mounts `GfinVaultBlock`), `apps/web/src/components/VaultSettings.test.tsx` | The vault lists the workspace's Go Fund It Now MCP connection with its current state ("Connected" and friends, from the existing `mcpServerConnection`), with nothing to reveal, edit or remove: the key lives only in the encrypted secret store and the DTO carries `hasSecret`, never a value. A failed read of the connector list shows the failure, never an empty block. | No. |
| Marketplace removed | `apps/web/src/pages/shell-overlay.ts` (templates overlay kind deleted), `apps/web/src/pages/shell/shell-overlays.tsx`, `apps/web/src/pages/shell/use-palette-actions.ts`, `apps/web/src/pages/PluginsOverlay.tsx`, `apps/web/src/components/integrations/skills-dialog.tsx` | The bot-templates marketplace is not part of this product (the brief's hide list). Deleted at every reachable entry: the URL kind no longer parses (`?templates` opens nothing), the command-palette action, the two overlay entry buttons and the props that fed them. `components/bot-templates/` itself is left in source (upstream code, unreferenced from any UI) and drops out of the built bundle; an upstream directory feature should not be cut out of `apps/api` here. | No. |
| People relabel and members | `apps/web/src/pages/settings-nav.ts`, `apps/web/src/pages/SettingsOverlay.tsx` | The messaging section is the fork's one "who can reach your agents" panel (requests with Approve/Decline, linked chat apps, channels, bot connections, external conversations with sender handling). The nav label is the portal's word: People. Under it, the space's members list (existing `SpaceMembersSettings`) appears, so the trusted-people surface (share a link, members, remove) sits on the same page instead of two levels deep. | No. |

## Decisions taken while building

| Decision | Reason | Date |
|---|---|---|
| No bottom bar; the account menu is the portal navigation | The brief's reference is flow and information architecture only. The fork's shell already has one nav surface (the account menu) with linkable overlay URLs; a second chrome layer would be a second authority for the same concern. | 2026-11-17 |
| People is the messaging section, not a new page | The messaging panel already holds requests (Approve/Decline), linked chat apps, channels, connections and external conversations. Building a second page would duplicate every list. Block and per-connection pause are not offered by the API, so they are hidden, not stubbed. Trusted people exist as space members and the space's own invite link; the members block joins the People page. | 2026-11-17 |
| Channels live under People | The messaging panel that holds channels is the same panel that holds who-reaches-you. A separate "Channels" nav item would point at the same panel, which is worse than one label. The brief's Settings list names channels; they are offered, one click away, with their real connect and unlink controls. | 2026-11-17 |
| The Invites share link targets `/welcome?invite=<token>` | The token is minted once and the stored hash cannot reproduce it, so the URL must be built in the browser (`inviteLinkUrl`, exported). Packet H owns the welcome page that reads `invites.inspect`; if H routes the welcome flow elsewhere, retargeting is this one exported function and this row. | 2026-11-17 |
| Artifacts relabelled Files | Plain short label for the page that lists files, generated assets and pages ("Files your bots create, like reports, docs and images, collect here"). The route `/app/artifacts` and the component name stay (internal identifiers keep upstream names). | 2026-11-17 |
| Memory, Voice, Computer, Usage sections stay in Settings | The brief names cards, payments, marketplace and model keys as the surfaces to hide. These four are real agent capabilities the runtime offers; wallet and billing are already hidden by deployment config (no wallet provider, no billing flag), and packet B removed the model-key affordance. | 2026-11-17 |
| The meter counts minted links (`grantedCount`), matching the invitations service | Withdrawing a link does not refund the allowance (packet D's decision), so "used" is what the row says. Left = allocation − grantedCount, floored at 0. | 2026-11-17 |

## Verification (packet I, 17 November 2026)

- `pnpm --filter @rakazo/web check` → EXIT=0 (tsc app + e2e projects).
- `pnpm --filter @rakazo/web build` → EXIT=0 (7 s, warnings only: chunk sizes, pre-existing).
- `pnpm check` (whole monorepo) → EXIT=0, 24/24 tasks.
- Web unit suite: 2076 passed, 1 failed; the one failure is `type-scale.test.ts` on
  `apps/web/src/me/onboarding/flow.tsx:27` (an off-scale text size without the
  `off-scale:` comment), packet H's in-progress file, not this packet's.
- Mutation proof, hidden surface unreachable:
  - `?templates` (marketplace): re-adding the parse line to `readShellOverlay` makes
    `shell-overlay.test.ts` fail ("opens nothing for the bot templates link: this
    deployment has no marketplace", 1 failed of 12); restored byte-identical, 12 passed.
    sha256 after restore `62fe438a7aa3937a90d3614051b54fdfddb844674ed3059a612d8b76ac508fd7`.
  - Vault card hide: changing `OFFERED_VAULT_KINDS`'s predicate from `kind !== "card"` to
    `kind !== "nope"` makes `VaultSettings.test.tsx` "offers no card to add" fail (menu
    offers Card again); restored symmetrically, the test passes and `product.ts` reads
    `kind !== "card"` (sha256 `1202b24d76edfecce49e1c8e38235e22216531b5372939e1a2924b20698d6b0f`).
- Built-bundle probe: after the final build, no `open-bot-templates` or
  `BotTemplatesDialog` reference remains in any built JS; the invites screen and the GFIN
  row ship inside the SettingsOverlay chunk.
- Deleted upstream test: `VaultSettings.test.tsx` "saves a card as one encoded value"
  drove the New menu into the card editor, which no longer renders; the card editor's
  edit path stays covered by "edits a card from its revealed value". Also updated
  `SidebarFooter.test.tsx` (menu contents, no app-store link, first entry now Vault) and
  `Artifacts.test.tsx` (heading expectation follows the label).

## Taste pre-flight (design-taste-frontend), 17 November 2026

Shots in `FORK.d/shots/` (`portal-snapshot-1440.png`, `portal-snapshot-390.png`,
`sign-in-1440.png`, `sign-in-390.png`; the last two are fresh captures of the unchanged
sign-in screen that replaced packet A's same-named files with the current tree's).

- Method: the authenticated screens need the API and no local database exists, so the
  changed panels (account menu, Invites section, Vault section with the GFIN row and two
  credentials) were rendered with their real components into a static snapshot styled by
  the built app's CSS plus the instance theme (`RAKAZO_THEME=infra/theme/me/theme.json`)
  served live from `vite preview` with the API proxied to the demo host (read-only;
  nothing was authenticated or submitted). `consistency.mjs` ran over the snapshot at
  1440/390 and over the real served sign-in at 1440/390.
- Real sign-in: 0 FAIL at 1440 and 390; the intermediate-width WARNs (hero-fill, nav,
  spill, cut-text) are the skill's landing-page hero heuristics on a centred auth card,
  judged false positives for app UI per the skill's scope rule (packet A's same
  judgement).
- Snapshot: the checks a dense app screen is judged on pass: contrast, body-size,
  button family/shape/contrast, font-load, links, forms, card family and layout, nav
  family/labels, reduced-motion, hidden-content, dark ground, cut-text, ui-fit. The FAIL
  rows are the landing-page structural deals (hero-screen, one-section, section-height,
  container-edges, copy-headline/actions, no-visual, overlap-text) driven by the harness
  itself (an open popover floating over panels, fragments with no hero or wrap), plus
  one real finding: the muted meta lines (`/70` opacity of `text-muted-foreground`, e.g.
  "Expires in 13 days", a vault row's subtitle) are low-contrast on the dark surface.
  That token is the fork's existing list style everywhere (the Meta pattern in the
  messaging panel, vault subtitles), not this packet's invention; flagged to the review
  packet as a product-wide contrast question, not a regression.
- Visual read of the shots: menu labels plain and ordered Vault, People, Invites,
  Settings; no dead or store entries; the vault shows "Go Fund It Now (public search)",
  "Connected", no button, no key; the Invites meter, share-once link block and minted
  list render with no filler copy.

## Not verified

- Nothing here ran against a live authenticated deployment: the meter's numbers come
  from the RPC contract, and the portal screens were checked through the snapshot
  harness, not a signed-in session on the demo host (no credentials exist here, and the
  secrets rule forbids using any). Wave 3's e2e suite (packet K) covers the live path.
- The `/welcome` route does not exist yet; packet H owns it. Until it lands, a minted
  link opens the 404 page. The URL is one exported function (`inviteLinkUrl`) and this
  file's decision table names it.
- The GFIN row has no live connection to read (packet E1's provisioning hook is in the
  tree but the demo host has not run it); the row was verified against the fixture in the
  unit tests and the snapshot. E1's slug (`GFIN_CONNECTION_SLUG = "gfin"` in
  packages/adapters) is the matching contract.
- `pnpm --filter @rakazo/web test` cannot go fully green in this tree while packet H's
  in-progress `me/onboarding/flow.tsx` fails the type-scale audit (noted above).
