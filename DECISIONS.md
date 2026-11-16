# DECISIONS.md

Decisions taken while building that the brief did not make. One line each: what, why,
when. The brief's D-RUN-1 to D-RUN-15 are not repeated.

| # | Decision | Reason | Date |
|---|---|---|---|
| 1 | Full clone at the tag, pushed to `origin` as branch `me` | The source-audit clone was partial (`--filter=blob:none`) and the receiver rejects a push without blobs | 2026-11-16 |
| 2 | The build script takes the git sha as its only argument and refuses a dirty tree | A tag that does not name the code it built cannot be rolled back to with confidence | 2026-11-16 |
| 3 | Health for the runtime is the web container's own `/api/health`, not the container being up | A container that runs but cannot answer is exactly the failure a demo hides | 2026-11-16 |
| 4 | A phone-only person gets a synthetic `@phone.invalid` address, never a mailbox | The phone door is the identity; inventing a deliverable address would send mail to nobody and would be a second identity | 2026-11-17 |
| 5 | Model connections created before the policy are grandfathered as readable but every save refuses | They spend the person's own key, so no house money is at risk; deleting them would take away something the person set up | 2026-11-17 |
| 6 | The invite allocation seeds a person's quota row once; the row then owns the number | A later config change must never silently rewrite an allowance someone already used | 2026-11-17 |
| 7 | A batched WhatsApp payload carrying both a nonce and text is split, not dropped | Dropping half a delivery is a lost message; the two halves have different owners and both must run | 2026-11-17 |
