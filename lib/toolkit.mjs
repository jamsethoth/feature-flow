// Token-saving hooks and plugins added back on top of the isolated headless base.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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

export function codexToolkit(tk = {}) {
  if (tk.useUserConfig === false) return { args: ['--ignore-user-config'], missing: [] };
  const args = tk.disableMcp ? codexMcpServers().flatMap((n) => ['-c', `mcp_servers.${n}.enabled=false`]) : [];
  return { args, missing: [] };
}

export function skillsBlock(skills) {
  if (!skills?.length) return '';
  return `\n## Skills\nIf available, use these skills for this stage (they may be namespaced, e.g. \`mattpocock-skills:tdd\`): ${skills.map((s) => `\`${s}\``).join(', ')}. Your persona and these instructions win if a skill conflicts with them.\n`;
}
