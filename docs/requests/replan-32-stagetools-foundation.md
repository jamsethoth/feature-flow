# Re-plan: ticket #32 (stageTools foundation) into smaller tickets

Ticket #32 of epic #31 ("stageTools config with per-stage plugins, preflight, doctor and events") failed review three
times across two attempts and is `needs-human`; #33–#37 are blocked behind it. Read epic #31, issue #32 (current body)
and the review comments on PR #51 (latest attempt) and PR #41 (earlier attempt).

## Why it failed

- Too big for one review cycle: config-key migration, a resolver for both CLIs, Codex discovery, preflight, doctor,
  events and README in one ticket. Implementers drifted out of scope (enabled Codex MCP, changed Claude MCP behaviour
  and weakened a test to match), and each round surfaced findings in a different part.
- A design gap the plan did not cover: Claude headless stages run with `--setting-sources project,local`, so a plugin
  enabled in the repo's own `.claude/settings.json` (or `settings.local.json`) still loads even when
  `stageTools.<stage>.plugins` does not list it, so the Claude allowlist is not exact and recorded tools are incomplete.
- Smaller gaps: listing validation only checked the outer array (`[{}]` produced `plugins."undefined"` overrides); a
  doctor test called the real gh/claude/codex (forbidden by AGENTS.md).

## Already decided (keep)

- Epic #31's decisions stand: config-only `stageTools.<stage>: { skills, mcp, plugins }`, exact allowlists.
- Q66: Codex discovery uses Codex's own `codex plugin list --json` (`installed[].pluginId`) and
  `codex mcp list --json` (`[].name`, includes plugin-provided servers), injectable for tests; a failing or malformed
  listing (including entries without a name/id) is an error, never an empty list.

## To decide with the user

- How Claude stages exclude plugins enabled by repo settings (e.g. pass `--settings` with an `enabledPlugins` map that
  disables every plugin not listed, alongside `--plugin-dir`; or drop `project` from `--setting-sources`; or something
  else). Verify the chosen mechanism actually works with the real `claude -p` before writing the tickets.
- How to split #32 into about three smaller vertical slices, each reviewable on its own.

## Publishing note

`ff publish` creates a new epic. Publish the replacement tickets as a small epic that references #31 and #32; afterwards
#32 and PR #51 get closed and #33–#37's blocked-by links are moved to the new tickets (the orchestrating session will do
those GitHub edits; do not edit issues by hand from the planner).

See AGENTS.md for constraints.
