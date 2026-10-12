import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig, parseCommands, loadConfig, loadPersona } from '../lib/config.mjs';
import { topoSort } from '../lib/publish.mjs';
import { isReady } from '../lib/github.mjs';
import { stageForRound, pool } from '../lib/run.mjs';
import { codexUsage, recordedSandbox } from '../lib/adapters.mjs';
import { styleBlock } from '../lib/stages.mjs';
import { withPrefixedTwins, claudeToolkit, findClaudePlugin, codexMcpServers, codexPlugins, codexToolkit } from '../lib/toolkit.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { commitAll, discardChanges } from '../lib/git.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('mergeConfig merges stage objects key by key, later layers win', () => {
  const out = mergeConfig({ implement: { cli: 'claude', model: 'sonnet' }, maxParallel: 2 }, { implement: { model: 'opus' }, maxParallel: 1 });
  assert.deepEqual(out, { implement: { cli: 'claude', model: 'opus' }, maxParallel: 1 });
});

test('plugin defaults load and every persona resolves', () => {
  const cfg = loadConfig(null);
  for (const s of ['plan', 'implement', 'review', 'escalate']) assert.ok(loadPersona(cfg[s].persona, null).hash.length === 8);
});

test('parseCommands reads the ## Commands section only', () => {
  const md = '# Repo\n- test: `nope`\n\n## Commands\n\n- test: `npm test`\n* Lint: `npm run lint`\n\n## Other\n- run: `x`\n';
  assert.deepEqual(parseCommands(md), { test: 'npm test', lint: 'npm run lint' });
});

test('topoSort orders dependencies first and rejects cycles/unknowns', () => {
  const order = topoSort([{ key: 'B', dependsOn: ['A'] }, { key: 'A' }, { key: 'C', dependsOn: ['A', 'B'] }]).map((t) => t.key);
  assert.deepEqual(order, ['A', 'B', 'C']);
  assert.throws(() => topoSort([{ key: 'A', dependsOn: ['B'] }, { key: 'B', dependsOn: ['A'] }]), /cycle/);
  assert.throws(() => topoSort([{ key: 'A', dependsOn: ['Z'] }]), /unknown/);
});

test('isReady needs open, idle and all blockers closed', () => {
  const base = { state: 'OPEN', labels: [{ name: 'ff:ticket' }], blockedBy: [{ state: 'CLOSED' }] };
  assert.equal(isReady(base), true);
  assert.equal(isReady({ ...base, blockedBy: [{ state: 'OPEN' }] }), false);
  assert.equal(isReady({ ...base, labels: [{ name: 'in-progress' }] }), false);
  assert.equal(isReady({ ...base, state: 'CLOSED' }), false);
});

test('stageForRound: first try, fix rounds, optional single escalation', () => {
  const cfg = { maxReviewRounds: 2, escalationEnabled: false };
  assert.deepEqual([0, 1, 2, 3].map((r) => stageForRound(r, cfg)), ['implement', 'implement', 'implement', null]);
  const esc = { ...cfg, escalationEnabled: true };
  assert.deepEqual([2, 3, 4].map((r) => stageForRound(r, esc)), ['implement', 'escalate', null]);
});

test('codexUsage sums turn.completed events and counts reasoning as output', () => {
  const jsonl = ['{"type":"turn.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":5,"reasoning_output_tokens":7}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1}}'].join('\n');
  assert.deepEqual(codexUsage(jsonl), { input: 110, cached: 40, output: 13 });
});

test('recordedSandbox reads the latest turn sandbox from a dated rollout file', () => {
  const home = mkdtempSync(join(tmpdir(), 'ff-codexhome-'));
  const d = new Date();
  const dir = join(home, 'sessions', ...[d.getFullYear(), d.getMonth() + 1, d.getDate()].map((x) => String(x).padStart(2, '0')));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rollout-2026-x-abc123.jsonl'), '{"type":"turn_context","payload":{"sandbox_policy":{"type":"read-only"}}}\n{"type":"turn_context","payload":{"sandbox_policy":{"type":"workspace-write","x":1}}}\n');
  assert.equal(recordedSandbox('abc123', home), 'workspace-write');
  assert.match(recordedSandbox('missing', home), /not found/);
});

test('styleBlock: caveman only for agent-facing prose, human fields stay natural', () => {
  assert.doesNotMatch(styleBlock({ internal: 'none' }, 'RULES'), /RULES|caveman-style/);
  assert.doesNotMatch(styleBlock({ internal: 'caveman-ultra' }, null), /caveman-style/);
  const s = styleBlock({ internal: 'caveman-ultra' }, 'RULES');
  assert.match(s, /\*\*ultra\*\*/);
  assert.match(s, /RULES/);
  assert.match(s, /never caveman/);
});

test('withPrefixedTwins adds rewritten forms of Bash rules only', () => {
  assert.deepEqual(withPrefixedTwins(['Read', 'Bash(git commit:*)'], ['rtk ']), ['Read', 'Bash(git commit:*)', 'Bash(rtk git commit:*)']);
  assert.deepEqual(withPrefixedTwins(['Bash(x)'], []), ['Bash(x)']);
});

test('claudeToolkit builds the rtk hook settings and reports unknown entries', () => {
  const tk = claudeToolkit({ hooks: ['rtk', 'nope'], plugins: [] });
  assert.equal(tk.args[0], '--settings');
  assert.match(tk.args[1], /rtk hook claude/);
  assert.deepEqual(tk.prefixes, ['rtk ']);
  assert.deepEqual(tk.missing, ['hook nope (unknown)']);
  assert.deepEqual(claudeToolkit(undefined), { args: [], prefixes: [], missing: [] });
});

test('findClaudePlugin resolves installed and nested synced plugins', () => {
  const home = mkdtempSync(join(tmpdir(), 'ff-home-'));
  const inst = join(home, 'cache', 'a');
  mkdirSync(inst, { recursive: true });
  mkdirSync(join(home, 'plugins'), { recursive: true });
  writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'alpha@mkt': [{ installPath: inst }] } }));
  const synced = join(home, 'plugins', 'synced', 'acct', 'uuid', '.claude-plugin');
  mkdirSync(synced, { recursive: true });
  writeFileSync(join(synced, 'plugin.json'), JSON.stringify({ name: 'beta' }));
  assert.equal(findClaudePlugin('alpha', home), inst);
  assert.equal(findClaudePlugin('beta', home), join(home, 'plugins', 'synced', 'acct', 'uuid'));
  assert.equal(findClaudePlugin('gamma', home), null);
});

test('codexMcpServers lists top-level server tables only', () => {
  const home = mkdtempSync(join(tmpdir(), 'ff-codex-'));
  writeFileSync(join(home, 'config.toml'), '[mcp_servers.playwright]\nargs=[]\n[mcp_servers.node_repl.env]\nX=1\n[mcp_servers.serena]\n[projects."/x"]\n');
  assert.deepEqual(codexMcpServers(home), ['playwright', 'serena']);
});

test('codexToolkit passes the Windows sandbox mode and hook switch', () => {
  const { args } = codexToolkit({ hooks: false, windowsSandbox: 'mxc' });
  assert.ok(args.join(' ').includes('features.hooks=false'));
  assert.equal(args.includes('windows.sandbox="mxc"'), process.platform === 'win32');
  assert.deepEqual(codexToolkit({ useUserConfig: false }).args, ['--ignore-user-config']);
});

test('codexPlugins lists configured plugin tables', () => {
  const home = mkdtempSync(join(tmpdir(), 'ff-codex-'));
  writeFileSync(join(home, 'config.toml'), '[plugins."browser@openai-bundled"]\nenabled=true\n[plugins."ponytail@ponytail"]\n[hooks.state."x"]\n');
  assert.deepEqual(codexPlugins(home), ['browser@openai-bundled', 'ponytail@ponytail']);
});

test('commitAll commits everything or returns null; discardChanges resets the worktree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-git-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  g('config', 'user.name', 't'); g('config', 'user.email', 't@t');
  assert.equal(await commitAll(dir, 'test: nothing'), null);
  writeFileSync(join(dir, 'a.txt'), 'a');
  const sha = await commitAll(dir, 'test: add a\n\nbody');
  assert.equal(g('log', '-1', '--format=%H %s'), `${sha} test: add a`);
  writeFileSync(join(dir, 'a.txt'), 'changed'); writeFileSync(join(dir, 'b.txt'), 'b');
  await discardChanges(dir);
  assert.equal(g('status', '--porcelain'), '');
});

test('pool never exceeds its limit and keeps result order', async () => {
  let live = 0, peak = 0;
  const res = await pool([1, 2, 3, 4, 5], 2, async (x) => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return x * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(res, [10, 20, 30, 40, 50]);
});
