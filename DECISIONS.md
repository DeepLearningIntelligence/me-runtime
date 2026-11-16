# DECISIONS.md

Decisions taken while building that the brief did not make. One line each: what, why,
when. The brief's D-RUN-1 to D-RUN-15 are not repeated.

| # | Decision | Reason | Date |
|---|---|---|---|
| 1 | Full clone at the tag, pushed to `origin` as branch `me` | The source-audit clone was partial (`--filter=blob:none`) and the receiver rejects a push without blobs | 2026-11-16 |
| 2 | The build script takes the git sha as its only argument and refuses a dirty tree | A tag that does not name the code it built cannot be rolled back to with confidence | 2026-11-16 |
| 3 | Health for the runtime is the web container's own `/api/health`, not the container being up | A container that runs but cannot answer is exactly the failure a demo hides | 2026-11-16 |
