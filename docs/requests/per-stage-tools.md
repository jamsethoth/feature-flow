# Feature request: per-stage tool access (skills, MCP servers, plugins)

## Problem

Tool access is configured per CLI, not per stage. `toolkit.claude` (hooks, plugins) and `toolkit.codex`
(MCP off, plugins off, hooks off, injected modes) apply to every Claude or Codex stage alike; only `stageSkills`
varies per stage, and only as a prompt hint. A planner, implementer, reviewer and escalator need different tools:
e.g. a design-heavy repo's implementer may need a Penpot MCP server that a reviewer should not have, and a
`reviewer-strict` persona variant may want a different skill set than the default reviewer.

## What exists (verified)

- Claude headless: `--mcp-config <json>` loads exactly the given MCP servers (tools then need `mcp__<server>__*` in
  the allowlist); `--plugin-dir` per call; user skills are NOT loaded in the isolated headless base today;
  `--disable-slash-commands` disables all skills. A per-stage temporary plugin dir containing only that stage's skills
  (linked from `~/.agents/skills`) could expose exactly those skills.
- Codex exec: `-c mcp_servers.<name>.enabled=true|false` and `-c plugins."<name>".enabled=true|false` per call
  (verified); every skill in `~/.agents/skills` is always discoverable; no verified per-run skill allowlist yet.
- MCP server definitions already live in each CLI's own config (Claude `~/.claude.json`, Codex `~/.codex/config.toml`);
  ff should reference servers by name rather than redefine them.

## Leanings from an earlier design discussion (to be confirmed or overturned while planning)

- Access defined in persona frontmatter (`skills:`, `mcp:`, `plugins:`) as defaults, overridable per stage in config
  (`stageTools.<stage>`), so a persona variant carries its tools and a repo can add project-specific servers.
- Per stage only, not per phase: red/green/fix share one resumed session.
- Codex skills: research whether a per-run skill allowlist exists; if not, keep `stageSkills` as a soft hint.
- Tool-level non-access settings (Codex sandbox mode, hooks off, mode injection) stay in `toolkit`.
- `ff doctor` should report each stage's resolved tools and anything missing; events/stats should record which tools
  a stage had, so `ff eval` can compare tool sets.

## Constraints

See AGENTS.md (no dependencies, native Windows, unit tests never call real CLIs or GitHub).
