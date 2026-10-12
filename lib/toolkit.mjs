// Token-saving hooks and plugins added back on top of the isolated headless base.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const CLAUDE_HOME = join(homedir(), '.claude');
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');

// Hooks ff knows how to add. A hook that rewrites commands names the prefix it adds, so the
// allowlist can carry a prefixed twin of every Bash rule.
export const KNOWN_HOOKS = {
  rtk: { event: 'PreToolUse', matcher: 'Bash', command: 'rtk hook claude', rewritePrefix: 'rtk ' },
};

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// Installed (marketplace) plugins first, then account-synced ones under plugins/synced/<id>/[<id>/]<name>.
export function findClaudePlugin(name, home = CLAUDE_HOME) {
  const installed = readJson(join(home, 'plugins', 'installed_plugins.json'))?.plugins ?? {};
  const key = Object.keys(installed).find((k) => k.split('@')[0] === name);
  const path = key && [installed[key]].flat()[0]?.installPath;
  if (path && existsSync(path)) return path;
  const synced = join(home, 'plugins', 'synced');
  if (!existsSync(synced)) return null;
  const dirs = (d) => readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(d, e.name));
  for (const top of dirs(synced)) {
    for (const cand of [...dirs(top), ...dirs(top).flatMap(dirs)]) {
      if (readJson(join(cand, '.claude-plugin', 'plugin.json'))?.name === name) return cand;
    }
  }
  return null;
}

// CLI args + allowlist prefixes for a Claude stage; `missing` lists toolkit entries not found.
export function claudeToolkit(tk = {}) {
  const missing = [];
  const hooks = {};
  const prefixes = [];
  for (const h of tk.hooks ?? []) {
    const def = KNOWN_HOOKS[h];
    if (!def) { missing.push(`hook ${h} (unknown)`); continue; }
    (hooks[def.event] ??= []).push({ matcher: def.matcher, hooks: [{ type: 'command', command: def.command }] });
    if (def.rewritePrefix) prefixes.push(def.rewritePrefix);
  }
  const args = Object.keys(hooks).length ? ['--settings', JSON.stringify({ hooks })] : [];
  for (const p of tk.plugins ?? []) {
    const dir = findClaudePlugin(p);
    if (dir) args.push('--plugin-dir', dir);
    else missing.push(`plugin ${p}`);
  }
  return { args, prefixes, missing };
}

// Every Bash(...) rule also allowed/denied in its rewritten form, e.g. Bash(rtk git commit:*).
export const withPrefixedTwins = (rules, prefixes) =>
  [...rules, ...prefixes.flatMap((p) => rules.filter((r) => r.startsWith('Bash(')).map((r) => `Bash(${p}${r.slice(5)}`))];

// Top-level [mcp_servers.<name>] tables in the Codex config.
export function codexMcpServers(home = CODEX_HOME) {
  const p = join(home, 'config.toml');
  if (!existsSync(p)) return [];
  return [...readFileSync(p, 'utf8').matchAll(/^\[mcp_servers\.("[^"]+"|[^.\]\s]+)\]\s*$/gm)].map((m) => m[1]);
}

// Plugins named in the Codex config ([plugins."<name>"] tables).
export function codexPlugins(home = CODEX_HOME) {
  const p = join(home, 'config.toml');
  if (!existsSync(p)) return [];
  return [...readFileSync(p, 'utf8').matchAll(/^\[plugins\."([^"]+)"\]\s*$/gm)].map((m) => m[1]);
}

// Text a mode plugin injects at session start, produced by running its own activation hook.
// Used where hooks are off (headless Codex), so the mode still applies.
export function modeText(name) {
  if (name !== 'ponytail') return null;
  const cache = join(CODEX_HOME, 'plugins', 'cache', 'ponytail', 'ponytail');
  const roots = [
    ...(existsSync(cache) ? readdirSync(cache).sort().reverse().map((v) => join(cache, v)) : []),
    findClaudePlugin('ponytail'),
  ].filter(Boolean);
  const root = roots.find((r) => existsSync(join(r, 'hooks', 'ponytail-activate.js')));
  if (!root) return null;
  const out = execFileSync(process.execPath, [join(root, 'hooks', 'ponytail-activate.js')], {
    input: '{"hook_event_name":"SessionStart","source":"startup"}', env: { ...process.env, CLAUDE_PLUGIN_ROOT: root }, encoding: 'utf8', timeout: 10_000,
  });
  return out.trim() || null;
}

// Headless Codex: keep the user config but turn off what breaks or bloats unattended sandboxed runs.
// - MCP servers: startup cost and tokens.
// - plugins in disablePlugins: the bundled computer-use runtime starts node_repl.exe, which locks a file
//   the Windows sandbox setup must re-ACL ("setup refresh had errors").
// - hooks: a command-rewriting hook (rtk) points at a binary the sandbox user cannot run; modes that
//   arrive by hook are re-injected into the prompt via `inject`.
export function codexToolkit(tk = {}) {
  if (tk.useUserConfig === false) return { args: ['--ignore-user-config'], preamble: '', missing: [] };
  const args = tk.disableMcp ? codexMcpServers().flatMap((n) => ['-c', `mcp_servers.${n}.enabled=false`]) : [];
  const configured = codexPlugins();
  for (const p of tk.disablePlugins ?? []) if (configured.includes(p)) args.push('-c', `plugins."${p}".enabled=false`);
  if (tk.hooks === false) args.push('-c', 'features.hooks=false');
  const missing = [];
  const texts = (tk.inject ?? []).map((m) => modeText(m) ?? (missing.push(`mode ${m}`), null)).filter(Boolean);
  return { args, preamble: texts.length ? texts.join('\n\n') + '\n\n---\n\n' : '', missing };
}

export function skillsBlock(skills) {
  if (!skills?.length) return '';
  return `\n## Skills\nIf available, use these skills for this stage (they may be namespaced, e.g. \`mattpocock-skills:tdd\`): ${skills.map((s) => `\`${s}\``).join(', ')}. Your persona and these instructions win if a skill conflicts with them.\n`;
}
