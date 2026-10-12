# feature-flow

Node CLI (`ff`) and Claude Code plugin that orchestrates plan → vertical-slice tickets → TDD implementation →
cross-model review → human QA, with a configurable CLI/model/effort/persona per stage. See README.md.

## Layout

- `bin/ff.mjs`: CLI entry (doctor, init, plan, publish, approve, run, stats, eval, config, persona)
- `bin/context-hook.mjs`: Claude Stop hook used by `ff plan` for the live context warning
- `lib/run.mjs`: the orchestrator (ticket loop, red/green/fix phases, gates, commits, PRs, reviews, events)
- `lib/adapters.mjs`: headless `claude -p` / `codex exec` adapters (permissions, sandbox, resume, usage, guards)
- `lib/toolkit.mjs`: hooks/plugins/MCP/feature switches per CLI
- `lib/config.mjs`: layered config (`defaults/` < `~/.agents/feature-flow/` < repo `.agents/feature-flow/`), personas, budgets
- `lib/stages.mjs`: stage prompts and strict JSON schemas; `lib/render.mjs`: issue/PR/review markdown
- `lib/github.mjs`, `lib/git.mjs`, `lib/exec.mjs`: gh / git / process helpers
- `lib/events.mjs`, `lib/stats.mjs`, `lib/eval.mjs`, `lib/planmetrics.mjs`: metrics, `ff stats`, `ff eval`, planning metrics
- `personas/*.md`, `defaults/feature-flow.json`, `skills/*/SKILL.md`, `.claude-plugin/`
- `test/core.test.mjs`: unit tests (`node:test`)

## Conventions

- Plain Node ESM (`.mjs`), Node 20+, no runtime dependencies. Prefer node built-ins.
- Must work on native Windows: spawn real executables without a shell (`lib/exec.mjs`), forward-slash-safe paths.
- Unit tests must not call the real `claude`, `codex` or `gh`, or touch GitHub; test pure functions and use temp dirs/repos.
- Codex `--output-schema` needs strict schemas: every property required, `additionalProperties: false`.
- Keep comments to the non-obvious "why", matching the existing code.

## Commands

- test: `npm test`
