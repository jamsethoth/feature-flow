// Token-saving hooks and plugins added back on top of the isolated headless base.
import { readFileSync, existsSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
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
// `alpha@mkt` matches that installed key exactly; a bare `alpha` matches `alpha@<any>` and must be unique.
// `strict: false` keeps the old first-match lookup for Codex's mode fallback.
function resolveClaudePlugin(name, home, strict = true) {
  const installed = readJson(join(home, 'plugins', 'installed_plugins.json'))?.plugins ?? {};
  const keys = Object.keys(installed).filter((k) => (name.includes('@') ? k === name : k.split('@')[0] === name));
  if (strict && keys.length > 1) return { missing: `plugin ${name} ambiguous: ${keys.join(', ')}` };
  const path = keys[0] && [installed[keys[0]]].flat()[0]?.installPath;
  if (path && existsSync(path)) return { path };
  const synced = join(home, 'plugins', 'synced');
  if (existsSync(synced)) {
    const dirs = (d) => readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(d, e.name));
    for (const top of dirs(synced)) {
      for (const cand of [...dirs(top), ...dirs(top).flatMap(dirs)]) {
        if (readJson(join(cand, '.claude-plugin', 'plugin.json'))?.name === name) return { path: cand };
      }
    }
  }
  return { missing: `plugin ${name}` };
}

export const findClaudePlugin = (name, home = CLAUDE_HOME) => resolveClaudePlugin(name, home, false).path ?? null;

// CLI args + allowlist prefixes for a Claude stage; `missing` lists hooks/plugins not found.
// Project settings still load, so every installed/project/local plugin is switched off and only the
// stage's plugins come back via --plugin-dir. @builtin plugins are left alone.
export function claudeToolkit(tk = {}, tools = {}, { home = CLAUDE_HOME, cwd = process.cwd() } = {}) {
  const missing = [];
  const hooks = {};
  const prefixes = [];
  for (const h of tk?.hooks ?? []) {
    const def = KNOWN_HOOKS[h];
    if (!def) { missing.push(`hook ${h} (unknown)`); continue; }
    (hooks[def.event] ??= []).push({ matcher: def.matcher, hooks: [{ type: 'command', command: def.command }] });
    if (def.rewritePrefix) prefixes.push(def.rewritePrefix);
  }
  const keys = [readJson(join(home, 'plugins', 'installed_plugins.json'))?.plugins,
    ...['settings.json', 'settings.local.json'].map((f) => readJson(join(cwd, '.claude', f))?.enabledPlugins)]
    .flatMap((o) => Object.keys(o ?? {})).filter((k) => !k.endsWith('@builtin'));
  const enabledPlugins = Object.fromEntries(keys.map((k) => [k, false]));
  const args = ['--settings', JSON.stringify({ ...(Object.keys(hooks).length ? { hooks } : {}), enabledPlugins })];
  for (const p of tools?.plugins ?? []) {
    const r = resolveClaudePlugin(p, home);
    if (r.path) args.push('--plugin-dir', r.path);
    else missing.push(r.missing);
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
// - MCP servers and the bundled browser/computer-use plugins: startup cost and tool-list tokens.
// - hooks: a command-rewriting hook (rtk) points at a binary the sandbox user cannot run; modes that
//   arrive by hook are re-injected into the prompt via `inject`.
// - windowsSandbox: "mxc" avoids the elevated mode's setup race; adapters fall back to "unelevated" if mxc fails.
export function codexToolkit(tk = {}) {
  if (tk.useUserConfig === false) return { args: ['--ignore-user-config'], preamble: '', missing: [] };
  const args = tk.disableMcp ? codexMcpServers().flatMap((n) => ['-c', `mcp_servers.${n}.enabled=false`]) : [];
  const configured = codexPlugins();
  for (const p of tk.disablePlugins ?? []) if (configured.includes(p)) args.push('-c', `plugins."${p}".enabled=false`);
  if (tk.hooks === false) args.push('-c', 'features.hooks=false');
  // The elevated Windows sandbox races Codex's own node_repl.exe ("setup refresh had errors", openai/codex#52415).
  if (tk.windowsSandbox && process.platform === 'win32') args.push('-c', `windows.sandbox="${tk.windowsSandbox}"`);
  for (const f of tk.disableFeatures ?? []) args.push('-c', `features.${f}=false`);
  const missing = [];
  const texts = (tk.inject ?? []).map((m) => modeText(m) ?? (missing.push(`mode ${m}`), null)).filter(Boolean);
  return { args, preamble: texts.length ? texts.join('\n\n') + '\n\n---\n\n' : '', missing };
}

// Whether Claude Code's workspace-trust prompt was accepted for this folder. Read-only: trust is a
// security decision, granted by the user in Claude Code, never written by ff.
// shortcut: reads Claude's undocumented ~/.claude.json projects map; returns null if it can't tell.
export function claudeTrusted(dir, home = homedir()) {
  const cfg = readJson(join(home, '.claude.json'));
  if (!cfg?.projects) return null;
  const want = dir.replace(/\\/g, '/').toLowerCase();
  const entry = Object.entries(cfg.projects).find(([p]) => p.replace(/\\/g, '/').toLowerCase() === want)?.[1];
  return entry?.hasTrustDialogAccepted === true;
}

// Opt-in only (`ff init --trust`): accept Claude Code workspace trust for a repo root using the route Claude's
// permissions docs describe (projects["<path>"].hasTrustDialogAccepted in ~/.claude.json). Running Claude
// processes also write this file, so it is re-read, changed in one key, written atomically and verified.
export function grantClaudeTrust(dir, home = homedir()) {
  const file = join(home, '.claude.json');
  const cfg = readJson(file) ?? {};
  cfg.projects ??= {};
  const want = dir.replace(/\\/g, '/');
  const key = Object.keys(cfg.projects).find((p) => p.replace(/\\/g, '/').toLowerCase() === want.toLowerCase()) ?? want;
  cfg.projects[key] = { ...cfg.projects[key], hasTrustDialogAccepted: true };
  const tmp = `${file}.ff-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  renameSync(tmp, file);
  return claudeTrusted(dir, home) === true;
}

export const TRUST_HINT =(dir) => `Claude Code has not trusted ${dir}. Open it in Claude Code once and accept the trust prompt (e.g. run \`claude\` there, or start a session in it from agent view).`;

export function skillsBlock(skills) {
  if (!skills?.length) return '';
  return `\n## Skills\nIf available, use these skills for this stage (they may be namespaced, e.g. \`mattpocock-skills:tdd\`): ${skills.map((s) => `\`${s}\``).join(', ')}. Your persona and these instructions win if a skill conflicts with them.\n`;
}
