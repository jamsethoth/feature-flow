# Feature request: an ff usage skill, and a flow scaled to the size of the change

## Problem

1. Nothing tells an agent (Claude or Codex, in any repo) when and how to use ff. The plugin's two skills
   (`plan-feature`, `run`) only start the planner or run an epic. In practice an agent skipped planning: it wrote a
   7-ticket plan itself from review findings, in a session far past the 100k planning context budget, published it
   through the library, and approved it on the user's behalf. Grilling, the planner's fresh context and the human
   plan-approval gate were all bypassed.
2. The full flow (grill, epic, tickets, red/green, cross-model review, QA) is overkill for a one- or two-line fix.
   Without a lighter path, agents either over-process trivial changes or bypass ff entirely.

## Wanted

- A skill (shared by Claude and Codex, e.g. in this repo's `skills/` and linkable from `~/.agents/skills`) that
  describes how ff should be used: when to use it, which size of flow fits which change, the non-negotiables
  (planning happens in a fresh planner session; agents never approve plans or merge on the user's behalf), and the
  commands for each path.
- A flow scoped to the size of the issue: e.g. trivial changes handled directly with a regression test, small
  well-understood changes as a single ticket without an epic or grilling, and features through the full flow.

## Open questions for planning

- How is size decided: by the agent with stated criteria, by the user, or proposed by the agent and confirmed by the
  user? What criteria (lines/files touched, behaviour change, new API/schema, cross-cutting, ambiguity)?
- What does the small path keep: TDD red/green verification? cross-model review? a GitHub issue and PR? QA steps?
- Is the small path a new command (e.g. `ff ticket "<description>"`), or a way to run one ticket from an issue?
- Where does the skill live and how is it installed for both CLIs; should repo AGENTS.md point to it?
- How do we stop agents from bypassing the planner again (skill wording, a check in `ff publish` / `ff approve`, an
  event when a plan is published without a planning session)?

## Context

- docs/requests/per-stage-tools.md is a separate feature being planned in parallel.
- Epic #1 (robustness fixes) is running now; it was the plan published without grilling.
- See AGENTS.md for constraints.
