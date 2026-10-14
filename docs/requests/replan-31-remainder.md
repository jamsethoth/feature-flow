# Re-plan: the rest of epic #31 (skills and Claude MCP)

Epic #31 (per-stage tool access) is half done. This file records the state, the verified facts and the decisions agreed
with the user on 2026-10-14, so a fresh planning session can rewrite the remaining tickets without re-deriving them.
Read epic #31, its sub-issues, epic #54 and the review comments on PR #65 (#36's failed attempt) alongside this file.

## State (2026-10-14, main at 89e1d67)

| Item | State |
|---|---|
| #32 | Closed, superseded by epic #54 (#55-#57 merged as #58-#60: `stageTools` config, exact plugin allowlists on both CLIs, Codex MCP off, preflight, doctor `tools <stage>` lines) |
| #34 Codex MCP | Closed, PR #62 merged (listed config.toml servers on via the one `mcp_servers={...}` inline table) |
| #38 plans folder | Closed, PR #40 merged (+ #63 test follow-up) |
| #61 preflight checks hooks/inject; doctor skips disabled escalate | `ready-for-qa`, PR #64 passed review and human QA, awaiting the user's merge |
| #36 Codex skills | `needs-human`, PR #65 open (3 review rounds + escalation failed), worktree `C:\dev\worktrees\feature-flow\ticket-36`. Its body describes the superseded prompt-input design |
| #37 doctor shows Codex's effective skills | Open, blocked by #36. Body assumes prompt-input parsing (superseded) |
| #33 Claude MCP | Open, blocked by #37. Body mostly valid; definition order is wrong (see D9) |
| #35 Claude skills | Open, blocked by #33. Body needs the D4/D9 additions |

The chain is serial on purpose: #36 → #37 → #33 → #35 all edit `resolveStageTools`, `claudeToolkit`/`codexToolkit` in
`lib/toolkit.mjs` and the doctor block. Leftover worktrees: `ticket-38` (merged; the next `ff run` cleans it),
`ticket-36`, `ticket-61`.

## Why #36 failed

Every blocker across its review rounds came from getting Codex's skill catalog by parsing the text of
`codex debug prompt-input`: skill roots are aliased (`r9/...`), Windows backslashes arrive JSON-escaped, a description can
contain `(file: ...)`, and the last line may lack a newline. Two further findings: `useUserConfig: false` never worked
(`--ignore-user-config` is rejected outside `codex exec`), and tests that skipped injecting the catalog spawned the real
`codex` (forbidden by AGENTS.md). The escalator also found a real, unrelated flake (D8).

## Verified facts

Codex (codex-cli 0.162.1; source pinned to tag `rust-v0.162.1`, https://github.com/openai/codex/tree/rust-v0.162.1/codex-rs):

- `codex app-server` method `skills/list` is documented (https://learn.chatgpt.com/docs/app-server) and is in the stable v2
  protocol schema (`codex app-server generate-json-schema`), though the `codex app-server` command is labelled
  experimental. Params `{ cwds, forceReload }`; response `{ data: [{ cwd, skills, errors }] }`; each skill has `name`,
  `path` (absolute `SKILL.md` path), `scope` (`user` | `repo` | `system` | `admin`), `enabled`, optional `pluginId`.
  Plugin skills are named `<plugin>:<skill>`. Verified live on this machine.
- Handshake: `initialize` request, then `initialized` notification, then requests (docs). Closing stdin right after
  sending the requests makes the server exit before answering `skills/list` (verified live), so the client must keep the
  connection open until the response arrives.
- `skills/list` honours `-c` overrides given to `codex app-server` (code: `catalog_processor.rs` loads config with the CLI
  overrides). A skill disabled by `skills.config` is listed with `enabled: false`; skills of a disabled plugin are not
  listed at all (`load_outcome.rs` filters inactive plugins). Verified live.
- `skills.config` entries: documented selector `path` (config reference: https://learn.chatgpt.com/docs/config-file/config-reference);
  `name` exists in code but is undocumented. A `path` selector must be the `SKILL.md` file path (code:
  `host_service.rs`), and works with Windows paths (verified live).
- `-c skills.config=[...]` is applied on top of the user's own `[[skills.config]]` rules, not instead of them: rules are
  read per layer (User, then SessionFlags), later rules win per selector (code: `skill_config_rules_from_stack`).
  Verified live with a temp `CODEX_HOME` whose rule stayed in force next to a `-c` rule. Project `.codex/config.toml`
  skill rules are ignored. PR #65's round-2 "replaces the user's rules" blocker came from passing `-c skills.config` twice:
  within one invocation a second `-c` with the same root key replaces the first (`apply_toml_override`).
- Bundled Codex skills (`imagegen`, `openai-docs`, `review-agent`, `skill-creator`, `skill-installer`) are listed with
  `scope: "system"`. Repo skills come from `.agents/skills` up to the repo root (docs: https://learn.chatgpt.com/docs/build-skills)
  and `.codex/skills` (code only) with `scope: "repo"`.
- `--ignore-user-config` exists only on `codex exec` (docs: https://learn.chatgpt.com/docs/developer-commands?surface=cli;
  code: `exec/src/cli.rs`). `codex app-server` always reads the user config.
- MCP servers run outside the Codex sandbox (code: `rmcp-client/src/stdio_server_launcher.rs` spawns them unwrapped; the
  docs are silent). Seen live: playwright wrote `.playwright-mcp/` into the repo during a `--sandbox read-only` review.
- `-c` keys are split on `.` with quotes kept literally, so `plugins."x@y".enabled` matches nothing; values parse as TOML
  and deep-merge (tables) into the config; an unparsable value silently becomes a string.

Claude Code (2.1.296; docs at https://code.claude.com/docs/en/):

- MCP definition precedence: local (`~/.claude.json` `projects[<path>].mcpServers`) > project (`.mcp.json`) > user
  (`~/.claude.json` `mcpServers`) > plugin-provided > claude.ai connectors; the whole entry from the winning source is used
  (mcp.md).
- `--mcp-config` accepts JSON strings as well as files (cli-reference.md).
- `--strict-mcp-config` drops MCP servers bundled in plugins (including `--plugin-dir` plugins) and claude.ai connectors.
  Verified live via the `system/init` stream-json event: strict → `mcp_servers: []`; without strict → the plugin's server
  plus "claude.ai Claude Docs". So Claude stages on main today receive the user's claude.ai connectors.
- MCP permission rule `mcp__<server>__*` (or `mcp__<server>`) allows every tool of one server (permissions.md).
- MCP servers run outside Claude's sandbox: "The sandbox covers shell commands only. Claude's file tools, MCP servers,
  and hooks run outside it" (sandboxing.md); native Windows has no sandbox at all.
- Per-skill controls: `skillOverrides` hides non-plugin skills but "Plugin skills are not affected by `skillOverrides`";
  `Skill(name)` permission rules block invocation only (skills.md). So a per-stage plugin-skill allowlist still needs the
  copied `ff-skills` plugin (#35). `disableBundledSkills` turns off bundled skills (skills.md).
- A `--plugin-dir` plugin needs no manifest (named after its folder) and gets the id `<name>@inline`; an enabled
  `--plugin-dir` plugin silently replaces a same-named installed plugin (plugins/create.md, plugins/loading.md).
- `~/.agents/skills` is not a Claude Code skill location (skills.md); ff may still copy skills from it.
- With `-p --output-format stream-json --verbose`, the `system/init` event lists `mcp_servers`, `plugins` and errors,
  which is the way to verify a stage's tools in QA (headless.md).

QA lessons: Codex rollouts do not record tool definitions, and asking the model which MCP servers it has is unreliable
(it omits deferred MCP tools even in a control run). Verify Codex MCP by a listed server's start attempt or a real tool
call; verify Claude via `system/init`. The global `ff` is an npm snapshot: reinstall after merges and use
`node <worktree>/bin/ff.mjs` for unmerged code.

## Decisions (agreed 2026-10-14)

Everything decided for epic #31 and epic #54 stands unless changed here.

- **D1** Codex's skill catalog comes from `codex app-server` `skills/list` (one short-lived connection kept open until
  the response; run once per ff process; remote plugins off and every installed plugin enabled so plugin skills appear;
  injectable runner, tests never spawn `codex`). The prompt-input parsing is dropped.
- **D2** Split #36 into two serial tickets: #36a "listed Codex skills are validated" (catalog + matching; unknown or
  ambiguous listed skills fail `ff run`'s preflight and `ff doctor`; no filtering yet), then #36b "Codex stages see
  exactly their listed skills" (filtering, enabling the plugin that provides a listed skill). Then #37, rewritten to
  render the effective set from `skills/list` run with the stage's real args (`enabled` flags), not prompt text.
- **D3** Disable unlisted skills by `path` (the `SKILL.md` paths `skills/list` returns), all in one
  `-c skills.config=[...]` argument. No special handling for the user's own rules (they stay in force).
- **D4** Built-in skills are filtered too: Codex `system` skills are disabled unless listed; Claude stages get
  `disableBundledSkills: true` in their `--settings` JSON (#35). Claude built-in plugins (`*@builtin`, e.g.
  `cc-plugin-agents-md`) stay untouched, as #54 decided. This overturns #54's "built-in skills never filtered".
- **D5** `useUserConfig: false` with Codex skills is unsupported: each listed Codex skill is missing as
  `skill <name> (useUserConfig is false)` and no skill filtering happens in that mode (documented).
- **D6** Claude stages always run with `--strict-mcp-config` and an inline `--mcp-config` JSON holding only the listed
  servers (empty list → empty object). Plugin-bundled MCP servers and claude.ai connectors are therefore unavailable on
  Claude stages; README documents it (workaround: define the server in local/project/user scope and list it).
- **D7** Restart #36: rewrite #36 as #36a, file #36b, re-chain #36a → #36b → #37 → #33 → #35, then
  `ff run 31 --retry-stuck 36`, which discards PR #65's branch.
- **D8** New independent ticket: in `lib/exec.mjs`, raise the 500 ms / 700 ms `taskkill` limits to the existing
  `CLEANUP_BUDGET_MS` (1500 ms), with a test using a deliberately slow taskkill (the escalator's fix on PR #65's branch;
  under load `taskkill /T` exceeded 500 ms and left the process tree alive). No blockers.
- **D9** Corrections: #33 uses the documented order local > project > user, `--strict-mcp-config` with inline
  `--mcp-config`, and keeps its README note that MCP servers run outside the sandbox on both CLIs (cite the sources
  above). #35 adds `disableBundledSkills`, notes the `ff-skills@inline` id and the silent same-name replacement, and its
  QA reads the `system/init` event.

## Open for the planning session

- How to apply the rewrite: edit #33/#35/#36/#37 in place and file #36b plus the D8 ticket as sub-issues of #31 (what the
  orchestrating session did for #33-#37 after #54), or publish a small replacement epic as for #54. Ask the user.
- Ticket bodies must name the merged functions (`resolveStageTools`, `claudeToolkit`, `codexToolkit`, `codexListings`,
  `toolsChecks`) and the injectable runner pattern, and keep tests off the real CLIs.
- Not verified yet: whether `disableBundledSkills` works under `--settings` in a headless run (make it #35's QA check).

See AGENTS.md for constraints.
