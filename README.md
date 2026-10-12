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

## Configure

Layers, later wins: `defaults/feature-flow.json` (this package) → `~/.agents/feature-flow/feature-flow.json`
→ `<repo>/.agents/feature-flow/feature-flow.json`. Stage objects merge key by key, so an override can be just:

```json
{ "review": { "cli": "claude", "model": "opus" }, "escalationEnabled": true }
```

| Key | Default | Meaning |
|---|---|---|
| `plan`, `implement`, `review`, `escalate` | see defaults | `{ cli, model, effort, persona }`; `cli` is `claude` or `codex` |
| `planApproval` | `true` | `ff run` waits for the `plan-approved` label |
| `escalationEnabled` | `false` | one `escalate` attempt after review rounds run out |
| `maxParallel` | `2` | tickets worked at once |
| `maxReviewRounds` | `2` | fix rounds after the first attempt |
| `baseBranch` | `main` | PR base |
| `worktreeRoot` | `~/worktrees` | ticket worktrees at `<root>/<repo>/ticket-<n>` |
| `allowNetwork` | `false` | let implementation agents use the network |
| `toolkit.claude` | `{ hooks: [], plugins: ["ponytail", "mattpocock-skills"] }` | added on top of the isolated headless Claude base (user settings are not loaded). Plugins are found by name in installed or account-synced plugins; `ff doctor` reports missing ones. `hooks: ["rtk"]` is supported but off: neither our sandbox A/B (+4% est. cost) nor [JetBrains' benchmark](https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/) showed a saving. The Caveman input proxy is not supported: it does not compress headless `claude -p` traffic ([caveman#1020](https://github.com/JuliusBrussee/caveman/issues/1020)) and routing subscription OAuth through it is a terms-of-service grey area |
| `toolkit.codex` | `{ useUserConfig: true, disableMcp: true }` | keep `~/.codex/config.toml` (hooks, plugins, skills) but turn every MCP server off for headless runs |
| `stageSkills` | see defaults | skills each stage is told to use when available (e.g. `implement: ["tdd"]`) |
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
