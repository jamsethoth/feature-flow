# feature-flow

Plan a feature with a strong model, implement it ticket by ticket with a cheaper one, review it
with a different model, and hand it to a human for QA. Every stage's CLI, model, effort and persona
is configurable.

```
ff plan ──► grill ──► vertical-slice tickets (GitHub epic + sub-issues, blocked-by links)
                              │  (plan-approved label, if planApproval)
ff run <epic> ──► for each ready ticket (maxParallel at a time, own worktree):
    implement (TDD) ──► test gate ──► push + draft PR ──► review
        ▲   CHANGES (≤ maxReviewRounds)              │ PASS
        └─────────────────────────────────────────────┤──► PR ready + ready-for-qa
            optional escalator attempt ──► needs-human
```

Routing is plain Node code; models only do the work inside each stage. Agents never touch GitHub:
`ff` pushes, opens PRs, posts reviews and sets labels. Humans merge.

## Install

Prerequisites: Node 20+, git, [GitHub CLI](https://cli.github.com) 2.94+ (logged in), and the CLIs
your config uses ([Claude Code](https://code.claude.com), [Codex](https://developers.openai.com/codex)) logged in.

```sh
npm install -g github:jamsethoth/feature-flow   # puts `ff` / `feature-flow` on PATH
ff doctor
```

Optional Claude Code skills (`/feature-flow:plan-feature`, `/feature-flow:run`):
```
/plugin marketplace add jamsethoth/feature-flow
/plugin install feature-flow@feature-flow
```

## Per repo

```sh
cd <repo main checkout>
ff init        # labels, .agents/feature-flow/, "## Commands" in AGENTS.md
```

`AGENTS.md` must declare at least the test command; `ff` runs it as the gate after every implementation:
```markdown
## Commands

- test: `npm test`
- lint: `npm run lint`
- run: `npm start`
```

## Use

```sh
ff plan "users can export their data as CSV"   # interactive grilling, then ff publish
ff approve 42                                  # if planApproval is true
ff run 42                                      # repeat after merging PRs to unblock dependents
```

`ff run` prints a table of tickets and states (`ready-for-qa`, `needs-human`, `blocked`, ...) and logs to
`<git common dir>/feature-flow/<epic>.log`. Each PR carries the definition of done, red/green test
evidence, QA instructions and a provenance table (CLI, model, effort, persona hash per stage).

## Measure

Every run appends to `<git common dir>/feature-flow/events.jsonl`: run start (with the stage configuration),
each stage call (stage, phase, CLI/model/effort/persona, duration, tokens, Claude's API-equivalent cost),
test gates, commits, reviews (verdict, findings by severity), blocked tickets and ticket end (state, rounds,
duration, diff size). `ff stats` summarises it:

```sh
ff stats                 # all runs in this repo
ff stats 42              # one epic
ff stats --refresh       # first ask GitHub what happened to each PR (merged? human commits? time to merge)
ff stats --by-label      # one summary per eval variant
ff stats --json
```

Efficacy: ready-for-qa / needs-human rate, first-round PASS rate, mean rounds, blocked tickets, escalations,
review findings, and after `--refresh`, PRs merged without human commits, closed unmerged, hours ready→merge.
Efficiency: minutes and tokens per ticket, retries (still-green, test-fix, failed red phases), diff size and
test share, per stage/model call counts, durations and tokens.

### Context budget

`contextBudget` (default 100k tokens for `plan`, `review` and `escalate`; implementation has none) is checked
against each session's peak per-request context, not its cumulative tokens. Going over logs a warning and a
`context_budget_exceeded` event; `ff plan` with Claude also shows a live notice when crossing it (and every further
50k). Nothing is blocked. `contextBudget.byModel` sets a per-model budget, e.g. `{ "byModel": { "opus": 150000 } }`.

The 100k default is a conservative convention, not a measured cliff: research shows quality degrading gradually with
context length, depending on model, task and distracting content. `ff stats` shows review pass rate, serious findings,
implementation first-round pass and downstream plan quality bucketed by peak context (<50k, 50-100k, 100-150k, 150k+),
so the budget can be tuned from your own runs.

To compare configurations, keep a throwaway sandbox repo with a fixed plan and a reset script, then:

```sh
ff eval --plan eval/plan.json --runs 2 --reset "node eval/reset.mjs" eval/variants/base.json eval/variants/codex-implements.json
```

Each variant file is a partial config merged over the repo's override; runs are interleaved and labelled.

## Configure

Layers, later wins: `defaults/feature-flow.json` (this package) → `~/.agents/feature-flow/feature-flow.json`
→ `<repo>/.agents/feature-flow/feature-flow.json`. Plain objects merge key by key at every level; arrays and scalars replace the lower layer's value. So an override can be just:

```json
{ "review": { "cli": "claude", "model": "opus" }, "escalationEnabled": true }
```

| Key | Default | Meaning |
|---|---|---|
| `plan`, `implement`, `review`, `escalate` | see defaults | `{ cli, model, effort, persona }`; `cli` is `claude` or `codex` |
| `planApproval` | `true` | `ff run` waits for the `plan-approved` label |
| `escalationEnabled` | `false` | one `escalate` attempt after review rounds run out |
| `maxParallel` | `2` | tickets worked at once |
| `stuckAfterHours` | `6` | `ff run` lists tickets `in-progress` longer than this as possibly stuck; re-run them with `--retry-stuck <ticket#>[,...]` |
| `maxReviewRounds` | `2` | fix rounds after the first attempt |
| `baseBranch` | `main` | PR base |
| `worktreeRoot` | `~/worktrees` | ticket worktrees at `<root>/<repo>/ticket-<n>` |
| `allowNetwork` | `false` | let implementation agents use the network |
| `toolkit.claude` | `{ hooks: [] }` | added on top of the isolated headless Claude base (user settings are not loaded). `hooks: ["rtk"]` is supported but off: neither our sandbox A/B (+4% est. cost) nor [JetBrains' benchmark](https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/) showed a saving. The Caveman input proxy is not supported: it does not compress headless `claude -p` traffic ([caveman#1020](https://github.com/JuliusBrussee/caveman/issues/1020)) and routing subscription OAuth through it is a terms-of-service grey area |
| `toolkit.codex` | see defaults | keep `~/.codex/config.toml` (plugins, skills) but for headless runs turn off MCP servers, the bundled browser/computer-use plugins (`disablePlugins`) and hooks (`hooks: false`: the rtk hook points at a binary the sandbox cannot run). Modes that arrive by hook are re-injected into the prompt (`inject: ["ponytail"]`). `disableFeatures` passes `features.<name>=false`. `windowsSandbox: "mxc"` (falls back to `unelevated`) avoids the elevated sandbox's "setup refresh had errors" race with Codex's own `node_repl.exe` ([openai/codex#52415](https://github.com/openai/codex/issues/52415)) |
| `stageTools` | see defaults | per stage `{ skills, mcp, plugins }`, each an exact allowlist. `skills` are named in the prompt as a hint (the only field the interactive `plan` stage uses). A headless Claude stage loads exactly its `plugins` plus Claude built-ins (`*@builtin`, never filtered): every installed plugin and every plugin enabled in the repo's `.claude/settings*.json` is turned off via a `--settings` `enabledPlugins` override, and each listed plugin is added back with `--plugin-dir`. A plugin is `name@marketplace` (exact) or bare `name` (must match one installed plugin; also searched in account-synced plugins). A missing or ambiguous plugin fails the stage before it starts. Codex filtering and MCP/skill filtering arrive in later tickets |
| `style.internal` | `none` | `caveman-lite\|full\|ultra`: compress agent-only prose with the shared `caveman` skill; human-facing text stays natural. Measured on the sandbox (2 runs per arm): no output savings and about 25% more input tokens, so it is off by default |

Personas live in `personas/<name>.md`; a file of the same name in `~/.agents/feature-flow/personas/` or
`<repo>/.agents/feature-flow/personas/` replaces it. Point a stage at a new persona (e.g.
`"persona": "reviewer-strict"`) to try a variant. `ff persona <name>` prints the effective text.

## Permissions

- Claude stages run `claude -p` with an allowlist: read tools, edits, local git and the repo's declared
  commands. `git push`, `gh` and web tools are denied.
- Codex stages run `codex exec` in its sandbox: `workspace-write` (no network unless `allowNetwork`) for
  implementation, `read-only` for review.
- No bypass modes are used.

## Adding a CLI

Add an adapter to `lib/adapters.mjs`. It takes a prompt, a persona and a JSON schema, and returns the
parsed object. Add an interactive launcher if the CLI should be able to plan.

## License

AGPL-3.0-or-later
