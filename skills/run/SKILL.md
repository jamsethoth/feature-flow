---
name: run
description: Run feature-flow on an epic - implement, test-gate, review and hand off every ready ticket. Use when the user asks to run, continue or resume feature-flow for an epic issue number.
---

1. Run `ff run <epic#>` from the repo's main checkout **in the background** (it can take a long
   time) and wait for it to finish; don't poll.
2. When it finishes, report its final table: each ticket with state and PR link.
   - `ready-for-qa`: point the user at the PR's QA instructions.
   - `needs-human`: link the PR or issue and summarise the last review findings or error.
   - `blocked`: waiting on dependencies; merge the ready PRs then run again.
3. The per-epic log is at `<git common dir>/feature-flow/<epic#>.log` if something needs explaining.
4. Never merge PRs, change labels or edit tickets yourself; humans do QA and merging.
