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

| Patch | Files | Reason | Replaceable by upstream config |
|---|---|---|---|
| (none yet) | | | |

## Decisions taken while building

One line each: decision, reason, date. The brief's own decisions (D-RUN-1 to D-RUN-15)
are not repeated here.

| Decision | Reason | Date |
|---|---|---|
| Fork pushed from a full clone at the tag, not the partial clone used for the source audit | A partial clone has no blobs and `git push` is rejected by the receiver | 2026-11-16 |
