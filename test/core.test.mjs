import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig, parseCommands, loadConfig, loadPersona, budgetFor } from '../lib/config.mjs';
import { topoSort } from '../lib/publish.mjs';
import { isReady } from '../lib/github.mjs';
import { stageForRound, pool, cleanupMerged, checkRed } from '../lib/run.mjs';
import * as runMod from '../lib/run.mjs';
import { codexUsage, recordedSandbox, apiCost, lastQuotaPct, invoke } from '../lib/adapters.mjs';
import { styleBlock } from '../lib/stages.mjs';
import { withPrefixedTwins, claudeToolkit, findClaudePlugin, codexMcpServers, codexPlugins, codexToolkit, claudeTrusted, grantClaudeTrust } from '../lib/toolkit.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { commitAll, discardChanges, ensureWorktree } from '../lib/git.mjs';
import { parseOpts, positiveInt } from '../lib/opts.mjs';
import { diffStats, severityCounts } from '../lib/events.mjs';
import { summarize, renderSummary } from '../lib/stats.mjs';
import { planShape, claudeTranscriptMetrics, codexTranscriptMetrics, lastRequestContext } from '../lib/planmetrics.mjs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('mergeConfig merges stage objects key by key, later layers win', () => {
  const out = mergeConfig({ implement: { cli: 'claude', model: 'sonnet' }, maxParallel: 2 }, { implement: { model: 'opus' }, maxParallel: 1 });
  assert.deepEqual(out, { implement: { cli: 'claude', model: 'opus' }, maxParallel: 1 });
});

test('plugin defaults load and every persona resolves', () => {
  const cfg = loadConfig(null);
  for (const s of ['plan', 'implement', 'review', 'escalate']) assert.ok(loadPersona(cfg[s].persona, null).hash.length === 8);
});

test('parseCommands reads the ## Commands section only', () => {
  const md = '# Repo\n- test: `nope`\n\n## Commands\n\n- test: `npm test`\n* Lint: `npm run lint`\n- run: `TODO`\n\n## Other\n- run: `x`\n';
  assert.deepEqual(parseCommands(md), { test: 'npm test', lint: 'npm run lint' });
});

test('mergeConfig deep-merges nested objects; arrays and scalars replace', () => {
  const low = { toolkit: { claude: { hooks: ['a'], plugins: ['p1', 'p2'] } }, contextBudget: { plan: 5, byModel: { opus: 1, sonnet: 2 } } };
  const out = mergeConfig(low, { toolkit: { claude: { plugins: ['p3'] } }, contextBudget: { byModel: { opus: 9 } } });
  assert.deepEqual(out.toolkit.claude, { hooks: ['a'], plugins: ['p3'] });
  assert.deepEqual(out.contextBudget, { plan: 5, byModel: { opus: 9, sonnet: 2 } });
  assert.deepEqual(low.contextBudget.byModel, { opus: 1, sonnet: 2 });
});

test('mergeConfig ignores __proto__, constructor and prototype keys', () => {
  const out = mergeConfig({ a: { b: 1 } }, JSON.parse('{"__proto__":{"polluted":1},"constructor":{"x":1},"prototype":{"y":1},"a":{"__proto__":{"deep":1}}}'));
  assert.equal({}.polluted, undefined);
  assert.equal(out.polluted, undefined);
  assert.equal(Object.hasOwn(out, 'constructor'), false);
  assert.equal(Object.hasOwn(out, 'prototype'), false);
  assert.equal(out.a.deep, undefined);
  assert.deepEqual(out.a, { b: 1 });
});

test('parseCommands accepts hyphenated names', () => {
  assert.deepEqual(parseCommands('## Commands\n- lint-js: `x`\n'), { 'lint-js': 'x' });
});

test('parseCommands warns about duplicate names via the warn callback', () => {
  const warnings = [];
  const out = parseCommands('## Commands\n- test: `a`\n- test: `b`\n', (m) => warnings.push(m));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /test/);
  assert.equal(out.test, 'b');
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

test('codexUsage takes the last cumulative turn.completed and does not double-count reasoning', () => {
  const jsonl = ['{"type":"turn.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":5,"reasoning_output_tokens":3}}',
    '{"type":"turn.completed","usage":{"input_tokens":150,"cached_input_tokens":60,"cache_write_input_tokens":10,"output_tokens":9,"reasoning_output_tokens":4}}'].join('\n');
  assert.deepEqual(codexUsage(jsonl), { input: 150, cached: 60, cacheWrite: 10, output: 9 });
});

test('apiCost prices fresh, cached, cache-write and output tokens per 1M', () => {
  const p = { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 };
  // fresh 1M x $2 + cached 1M x $0.1 + write 1M x $2.5 + output 1M x $10
  assert.equal(apiCost({ input: 3e6, cached: 1e6, cacheWrite: 1e6, output: 1e6 }, p), 14.6);
  assert.equal(apiCost({ input: 1, cached: 0, output: 0 }, undefined), null);
});

test('lastQuotaPct reads the latest primary used_percent from a rollout', () => {
  const r = '{"payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":78.0,"window_minutes":10080}}}}\n{"payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":79.0,"window_minutes":10080}}}}';
  assert.equal(lastQuotaPct(r), 79);
  assert.equal(lastQuotaPct('{}'), null);
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
  const home = mkdtempSync(join(tmpdir(), 'ff-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'ff-cwd-'));
  const tk = claudeToolkit({ hooks: ['rtk', 'nope'] }, { plugins: [] }, { home, cwd });
  assert.equal(tk.args[0], '--settings');
  assert.match(tk.args[1], /rtk hook claude/);
  assert.deepEqual(tk.prefixes, ['rtk ']);
  assert.deepEqual(tk.missing, ['hook nope (unknown)']);
  assert.deepEqual(claudeToolkit(undefined, undefined, { home, cwd }), { args: ['--settings', JSON.stringify({ enabledPlugins: {} })], prefixes: [], missing: [] });
});

// A Claude home with alpha@mkt and beta@mkt installed, and a cwd whose project/local settings enable more.
function claudeFixture(installed = { 'alpha@mkt': 'alpha', 'beta@mkt': 'beta' }) {
  const home = mkdtempSync(join(tmpdir(), 'ff-home-'));
  const plugins = {};
  for (const [key, dir] of Object.entries(installed)) {
    const p = join(home, 'cache', dir);
    mkdirSync(p, { recursive: true });
    plugins[key] = [{ installPath: p }];
  }
  mkdirSync(join(home, 'plugins'), { recursive: true });
  writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins }));
  const cwd = mkdtempSync(join(tmpdir(), 'ff-cwd-'));
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'gamma@other': true, 'cc-plugin-x@builtin': true } }));
  writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'delta@x': true } }));
  return { home, cwd };
}

const settingsOf = (args) => {
  assert.equal(args.filter((a) => a === '--settings').length, 1);
  return JSON.parse(args[args.indexOf('--settings') + 1]);
};
const pluginDirs = (args) => args.flatMap((a, i) => (a === '--plugin-dir' ? [args[i + 1]] : []));

test('claudeToolkit loads only the listed plugin and disables every other installed/project/local one', () => {
  const { home, cwd } = claudeFixture();
  const tk = claudeToolkit({}, { plugins: ['alpha'] }, { home, cwd });
  assert.deepEqual(tk.missing, []);
  assert.deepEqual(pluginDirs(tk.args), [join(home, 'cache', 'alpha')]);
  assert.deepEqual(settingsOf(tk.args).enabledPlugins, { 'alpha@mkt': false, 'beta@mkt': false, 'gamma@other': false, 'delta@x': false });
});

test('claudeToolkit merges hooks into the same single --settings', () => {
  const { home, cwd } = claudeFixture();
  const s = settingsOf(claudeToolkit({ hooks: ['rtk'] }, { plugins: ['alpha'] }, { home, cwd }).args);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'rtk hook claude');
  assert.equal(s.enabledPlugins['alpha@mkt'], false);
});

test('claudeToolkit plugin names: qualified exact match, qualified miss, ambiguous bare name', () => {
  const { home, cwd } = claudeFixture();
  assert.deepEqual(pluginDirs(claudeToolkit({}, { plugins: ['alpha@mkt'] }, { home, cwd }).args), [join(home, 'cache', 'alpha')]);
  assert.deepEqual(claudeToolkit({}, { plugins: ['alpha@other'] }, { home, cwd }).missing, ['plugin alpha@other']);
  const two = claudeFixture({ 'alpha@a': 'a', 'alpha@b': 'b' });
  assert.deepEqual(claudeToolkit({}, { plugins: ['alpha'] }, two).missing, ['plugin alpha ambiguous: alpha@a, alpha@b']);
});

test('claude adapter rejects a stage with a missing plugin before spawning', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'ff-cwd-'));
  let called = false;
  const runner = async () => { called = true; return { stdout: '{}' }; };
  // Belt and braces: an adapter that ignored `runner` must not reach the real claude.
  const path = process.env.PATH;
  process.env.PATH = '';
  t.after(() => { process.env.PATH = path; });
  await assert.rejects(invoke({ stage: { cli: 'claude', persona: 'implementer', model: 'x', effort: 'low' }, stageName: 'review',
    persona: { path: 'p', text: '' }, prompt: '', schema: {}, cwd, write: false, commands: {}, toolkit: {},
    tools: { skills: [], mcp: [], plugins: ['ff-no-such-plugin-xyz'] }, runner }),
  (err) => /review tools not found: .*plugin ff-no-such-plugin-xyz/.test(err.message));
  assert.equal(called, false);
});

test('loadConfig rejects replaced stageSkills / toolkit.claude.plugins keys, naming stageTools', () => {
  const layer = (json) => {
    const repo = mkdtempSync(join(tmpdir(), 'ff-repo-'));
    mkdirSync(join(repo, '.agents', 'feature-flow'), { recursive: true });
    writeFileSync(join(repo, '.agents', 'feature-flow', 'feature-flow.json'), JSON.stringify(json));
    return repo;
  };
  assert.throws(() => loadConfig(layer({ stageSkills: {} })), (e) => e.message.includes('stageSkills') && e.message.includes('stageTools.<stage>.skills'));
  assert.throws(() => loadConfig(layer({ toolkit: { claude: { plugins: [] } } })),
    (e) => e.message.includes('toolkit.claude.plugins') && e.message.includes('stageTools.<stage>.plugins'));
  assert.throws(() => loadConfig(layer({ stageSkills: {}, toolkit: { claude: { plugins: [] } } })),
    (e) => e.message.includes('stageSkills') && e.message.includes('toolkit.claude.plugins'));
});

const SHIPPED_STAGE_TOOLS = {
  plan: { skills: ['grilling', 'to-tickets', 'writing-for-agents'], mcp: [], plugins: [] },
  implement: { skills: ['mattpocock-skills:tdd'], mcp: [], plugins: ['ponytail'] },
  review: { skills: ['mattpocock-skills:code-review'], mcp: [], plugins: ['ponytail'] },
  escalate: { skills: ['mattpocock-skills:diagnosing-bugs', 'mattpocock-skills:tdd'], mcp: [], plugins: ['ponytail'] },
};

test('shipped defaults carry stageTools and drop the old Claude keys', () => {
  const cfg = loadConfig(null);
  assert.deepEqual(cfg.stageTools, SHIPPED_STAGE_TOOLS);
  assert.equal(cfg.stageSkills, undefined);
  assert.equal(cfg.toolkit.claude.plugins, undefined);
  assert.deepEqual(cfg.toolkit.claude.hooks, []);
});

test('stageCallTools and configSummary carry stageTools; stage_call logs tools', () => {
  const cfg = loadConfig(null);
  assert.deepEqual(runMod.stageCallTools(cfg, 'review'), { skills: ['mattpocock-skills:code-review'], mcp: [], plugins: ['ponytail'] });
  assert.deepEqual(runMod.stageCallTools({}, 'review'), { skills: [], mcp: [], plugins: [] });
  assert.deepEqual(runMod.configSummary(cfg).stageTools, cfg.stageTools);
  const src = readFileSync(join(ROOT, 'lib', 'run.mjs'), 'utf8');
  assert.match(src, /ev\('stage_call', \{[^}]*\btools\b/);
});

test('no lib/, bin/ or README reference to the old keys outside the replaced-key table', () => {
  const files = ['lib', 'bin'].flatMap((d) => readdirSync(join(ROOT, d)).map((f) => join(ROOT, d, f))).concat(join(ROOT, 'README.md'));
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n').filter((l) => /stageSkills|toolkit\.claude\.plugins/.test(l));
    // The replaced-key table in config.mjs is the only allowed mention.
    const allowed = f.endsWith('config.mjs') ? lines.filter((l) => !/^\s*\[?\s*['"](stageSkills|toolkit\.claude\.plugins)['"]/.test(l)) : lines;
    assert.deepEqual(allowed, [], f);
  }
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

// A clone of a bare origin with one commit on main, so ensureWorktree can fetch origin/main.
function cloneWithOrigin() {
  const root = mkdtempSync(join(tmpdir(), 'ff-wt-'));
  const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
  sh(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  sh(root, 'clone', '-q', 'origin.git', 'main');
  const mainRoot = join(root, 'main');
  sh(mainRoot, 'config', 'user.name', 't'); sh(mainRoot, 'config', 'user.email', 't@t');
  sh(mainRoot, 'commit', '-q', '--allow-empty', '-m', 'init');
  sh(mainRoot, 'push', '-q', 'origin', 'main');
  return { root, mainRoot, sh };
}

test('ensureWorktree reuses the existing branch when the title (and so the derived branch) changed', async () => {
  const { root, mainRoot, sh } = cloneWithOrigin();
  const path = join(root, 'wt', 'ticket-4');
  await ensureWorktree({ mainRoot, path, branch: 'ticket/4-old-title', base: 'main' });
  const again = await ensureWorktree({ mainRoot, path, branch: 'ticket/4-new-title', base: 'main' });
  assert.equal(again.branch, 'ticket/4-old-title');
  assert.equal(sh(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'ticket/4-old-title');
});

test('ensureWorktree rejects a plain folder at the worktree path and names it', async () => {
  const { root, mainRoot } = cloneWithOrigin();
  const path = join(root, 'wt', 'ticket-4');
  mkdirSync(path, { recursive: true });
  await assert.rejects(ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' }), (e) => e.message.includes(path));
});

test('cleanupMerged keeps a merged ticket worktree that has uncommitted changes', async () => {
  const { root, mainRoot } = cloneWithOrigin();
  const path = join(root, 'wt', 'ticket-4');
  await ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' });
  writeFileSync(join(path, 'unsaved.txt'), 'work');
  const logs = [];
  await cleanupMerged({ mainRoot }, {}, (m) => logs.push(m), { findPr: async () => ({ state: 'MERGED' }) });
  assert.ok(existsSync(join(path, 'unsaved.txt')));
  assert.ok(logs.some((l) => l.includes('ticket/4-x')));
});

test('ensureWorktree rejects a plain folder that replaced a still-registered worktree', async () => {
  const { root, mainRoot } = cloneWithOrigin();
  const path = join(root, 'wt', 'ticket-4');
  await ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' });
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  await assert.rejects(ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' }), (e) => e.message.includes(path));
});

test('cleanupMerged keeps a merged worktree holding an ignored unsaved file', async () => {
  const { root, mainRoot } = cloneWithOrigin();
  const path = join(root, 'wt', 'ticket-4');
  await ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' });
  writeFileSync(join(path, '.gitignore'), 'secret.txt\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: path });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'ignore'], { cwd: path });
  execFileSync('git', ['push', '-q', 'origin', 'ticket/4-x'], { cwd: path });
  writeFileSync(join(path, 'secret.txt'), 'work');
  await cleanupMerged({ mainRoot }, {}, () => {}, { findPr: async () => ({ state: 'MERGED' }) });
  assert.ok(existsSync(join(path, 'secret.txt')));
});

test('cleanupMerged keeps an untracked file even when status.showUntrackedFiles=no', async () => {
  const { root, mainRoot } = cloneWithOrigin();
  const path = join(root, 'wt', 'ticket-4');
  await ensureWorktree({ mainRoot, path, branch: 'ticket/4-x', base: 'main' });
  execFileSync('git', ['config', 'status.showUntrackedFiles', 'no'], { cwd: mainRoot });
  writeFileSync(join(path, 'unsaved.txt'), 'work');
  await cleanupMerged({ mainRoot }, {}, () => {}, { findPr: async () => ({ state: 'MERGED' }) });
  assert.ok(existsSync(join(path, 'unsaved.txt')));
});

test('diffStats splits test and non-test insertions; severityCounts tallies findings', () => {
  const s = diffStats('3\t1\tsrc/cart.mjs\n10\t0\ttest/cart.test.mjs\n2\t2\tsrc/util.spec.ts\n-\t-\timg.png\n');
  assert.deepEqual(s, { files: 4, insertions: 15, deletions: 3, testFiles: 2, testInsertions: 12 });
  assert.deepEqual(severityCounts([{ severity: 'major' }, { severity: 'minor' }, { severity: 'minor' }]), { blocker: 0, major: 1, minor: 2 });
});

test('summarize computes first-round pass, rounds, retries, per-stage means and PR outcomes', () => {
  const base = { run: 'r1', epic: 5, label: 'A' };
  const call = (ticket, phase, stage, input, cached, output, extra = {}) => ({ ...base, ticket, type: 'stage_call', phase, stage, cli: 'claude', model: 'sonnet', effort: 'medium', input, cached, output, durationMs: 10_000, costUsd: 0.5, ...extra });
  const events = [
    call(1, 'red', 'implement', 100, 50, 10), call(1, 'green', 'implement', 100, 80, 10), call(1, 'review', 'review', 50, 0, 5),
    { ...base, ticket: 1, type: 'review', verdict: 'PASS', blocker: 0, major: 0, minor: 1, dodMet: true },
    { ...base, ticket: 1, type: 'ticket_end', state: 'ready-for-qa', rounds: 1, durationMs: 120_000, pr: 9, ts: '2026-10-12T10:00:00Z', diff: { files: 2, insertions: 20, deletions: 0, testFiles: 1, testInsertions: 10 } },
    call(2, 'red', 'implement', 100, 50, 10), call(2, 'test-fix', 'implement', 100, 50, 10), call(2, 'review', 'review', 50, 0, 5),
    { ...base, ticket: 2, type: 'review', verdict: 'CHANGES', blocker: 1, major: 0, minor: 0, dodMet: false },
    { ...base, ticket: 2, type: 'ticket_end', state: 'needs-human', rounds: 3, durationMs: 240_000, pr: 10 },
    { type: 'pr_outcome', pr: 9, state: 'MERGED', humanCommits: 0, hoursToMerge: 2 },
    { ...base, label: 'B', ticket: 3, type: 'ticket_end', state: 'ready-for-qa', rounds: 1, durationMs: 1 },
  ];
  const s = summarize(events, { label: 'A' });
  assert.equal(s.tickets, 2);
  assert.equal(s.efficacy.firstRoundPass, '50%');
  assert.equal(s.efficacy.meanRounds, '2.00');
  assert.deepEqual(s.efficacy.findings, { blocker: 1, major: 0, minor: 1 });
  assert.equal(s.efficacy.dodMissedInReview, 1);
  assert.equal(s.efficacy.prOutcomes.mergedWithoutHumanCommits, 1);
  assert.equal(s.efficiency.retries.testFix, 1);
  assert.equal(s.efficiency.meanTicketMinutes, '3.0');
  assert.equal(s.efficiency.apiEquivalentUsd, '3.00');
  assert.equal(s.efficiency.byStage['implement claude/sonnet/medium'].calls, 4);
  assert.match(renderSummary('A', s), /first-round PASS 50%/);
});

test('planShape measures size, dependency structure and specificity', () => {
  const s = planShape({ tickets: [
    { key: 'A', dod: ['x', 'y'], tests: ['t'] },
    { key: 'B', dependsOn: ['A'], dod: ['x'], tests: ['t', 'u'] },
    { key: 'C', dependsOn: ['B', 'A'], dod: ['x', 'y', 'z'], tests: [] },
  ] });
  assert.deepEqual(s, { tickets: 3, dependencyEdges: 3, longestChain: 3, independentTickets: 1, meanDodItems: 2, meanTestsFirst: 1 });
});

test('claudeTranscriptMetrics counts usage once per message and only real user turns', () => {
  const t = [
    { type: 'user', message: { content: 'plan my feature' } },
    { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 }, content: [{ type: 'text' }] } },
    { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 }, content: [{ type: 'tool_use', name: 'AskUserQuestion' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    { type: 'user', isMeta: true, message: { content: 'reminder' } },
    { type: 'user', message: { content: [{ type: 'text', text: 'yes' }] } },
  ].map((x) => JSON.stringify(x)).join('\n');
  assert.deepEqual(claudeTranscriptMetrics(t), { input: 115, cached: 100, output: 7, userTurns: 2, questionsAsked: 0, peakContext: 115, overBudgetRequests: 0 });
  assert.equal(claudeTranscriptMetrics(t, 100).overBudgetRequests, 1);
});

test('lastRequestContext reads the latest assistant request size', () => {
  const t = [
    { type: 'assistant', message: { id: 'a', usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } },
    { type: 'user', message: { content: 'x' } },
    { type: 'assistant', message: { id: 'b', usage: { input_tokens: 10, cache_read_input_tokens: 150000, cache_creation_input_tokens: 2000 } } },
  ].map((x) => JSON.stringify(x)).join('\n');
  assert.equal(lastRequestContext(t), 152010);
  assert.equal(lastRequestContext(''), 0);
});

test('codexTranscriptMetrics takes cumulative usage and the quota delta', () => {
  const t = [
    { type: 'event_msg', payload: { type: 'user_message' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 5, reasoning_output_tokens: 3 }, last_token_usage: { input_tokens: 100 } }, rate_limits: { primary: { used_percent: 70 } } } },
    { type: 'event_msg', payload: { type: 'user_message' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 9, reasoning_output_tokens: 1 }, last_token_usage: { input_tokens: 200 } }, rate_limits: { primary: { used_percent: 71.5 } } } },
  ].map((x) => JSON.stringify(x)).join('\n');
  assert.deepEqual(codexTranscriptMetrics(t, 150), { input: 300, cached: 200, output: 9, userTurns: 2, questionsAsked: 0, quotaUsedPct: 1.5, peakContext: 200, overBudgetRequests: 1 });
});

test('budgetFor: only budgeted stages, per-model override', () => {
  const cfg = { contextBudget: { plan: 100000, review: 100000, byModel: { opus: 150000 } } };
  assert.equal(budgetFor(cfg, 'review', 'sonnet'), 100000);
  assert.equal(budgetFor(cfg, 'review', 'opus'), 150000);
  assert.equal(budgetFor(cfg, 'implement', 'opus'), null);
});

test('contextVsOutcome buckets reviews, implementations and plans by peak context', () => {
  const call = (ticket, phase, stage, peak, round = 0) => ({ run: 'r', epic: 7, ticket, type: 'stage_call', phase, stage, round, peakContext: peak, input: 0, cached: 0, output: 0 });
  const events = [
    call(1, 'red', 'implement', 30000), call(1, 'review', 'review', 40000),
    { run: 'r', epic: 7, ticket: 1, type: 'review', round: 0, verdict: 'PASS', blocker: 0, major: 0 },
    { run: 'r', epic: 7, ticket: 1, type: 'ticket_end', state: 'ready-for-qa', rounds: 1 },
    call(2, 'red', 'implement', 120000), call(2, 'test-fix', 'implement', 125000), call(2, 'review', 'review', 130000),
    { run: 'r', epic: 7, ticket: 2, type: 'review', round: 0, verdict: 'CHANGES', blocker: 1, major: 1 },
    { run: 'r', epic: 7, ticket: 2, type: 'ticket_end', state: 'needs-human', rounds: 3 },
    { type: 'plan_session', planId: 'p', peakContext: 90000, input: 1, cached: 0, output: 1 },
    { type: 'plan_published', planId: 'p', epic: 7, tickets: 2 },
  ];
  const c = summarize(events).contextVsOutcome;
  assert.deepEqual(c.review, [{ bucket: '<50k', n: 1, passRate: '100%', seriousFindingsPerReview: '0.00' }, { bucket: '100-150k', n: 1, passRate: '0%', seriousFindingsPerReview: '2.00' }]);
  assert.deepEqual(c.implement.map((r) => [r.bucket, r.firstRoundPass, r.testFixRetriesPerTicket]), [['<50k', '100%', '0.00'], ['100-150k', '0%', '1.00']]);
  assert.deepEqual(c.plan, [{ bucket: '50-100k', n: 1, tickets: 2, downstreamFirstRoundPass: '50%', blockedTickets: 0 }]);
});

test('claudeTrusted reads (never writes) Claude Code folder trust', () => {
  const home = mkdtempSync(join(tmpdir(), 'ff-trust-'));
  assert.equal(claudeTrusted('C:\\x', home), null);
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { 'C:/dev/a': { hasTrustDialogAccepted: true }, 'C:/dev/b': {} } }));
  assert.equal(claudeTrusted('C:\\dev\\a', home), true);
  assert.equal(claudeTrusted('C:/dev/b', home), false);
  assert.equal(claudeTrusted('C:/dev/c', home), false);
  // grant keeps every other key and entry field, and matches the existing key case-insensitively
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 3, projects: { 'C:/Dev/B': { allowedTools: ['x'] } } }));
  assert.equal(grantClaudeTrust('c:\\dev\\b', home), true);
  const after = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  assert.deepEqual(after, { numStartups: 3, projects: { 'C:/Dev/B': { allowedTools: ['x'], hasTrustDialogAccepted: true } } });
});

test('parseOpts: boolean flags never swallow the next argument', () => {
  assert.deepEqual(parseOpts(['--bg', 'Plan the feature']), { _: ['Plan the feature'], bg: true });
  assert.deepEqual(parseOpts(['--finish', 'abc', '--session', 'xyz']), { _: [], finish: 'abc', session: 'xyz' });
  assert.deepEqual(parseOpts(['42', '--refresh', '--label', 'A']), { _: ['42'], refresh: true, label: 'A' });
});

const PLAN_SPEC = { values: ['name', 'session'], bools: ['bg'] };
const EVAL_SPEC = { values: ['plan', 'runs', 'reset'], bools: [] };

test('parseOpts: unknown flags are rejected', () => {
  assert.throws(() => parseOpts(['--bgg', 'x'], PLAN_SPEC), /unknown.*--bgg/i);
});

test('parseOpts: --flag=value is parsed, also for empty and = containing values', () => {
  assert.deepEqual(parseOpts(['--runs=3', 'a.json'], EVAL_SPEC), { _: ['a.json'], runs: '3' });
  assert.deepEqual(parseOpts(['--reset=a=b'], EVAL_SPEC), { _: [], reset: 'a=b' });
  assert.throws(() => parseOpts(['--bg=yes'], PLAN_SPEC), /--bg/);
});

test('parseOpts: a value flag with no value is an error', () => {
  assert.throws(() => parseOpts(['--plan'], EVAL_SPEC), /--plan.*value/i);
  assert.throws(() => parseOpts(['--plan', '--runs', '2'], EVAL_SPEC), /--plan.*value/i);
});

test('parseOpts: -- ends option parsing', () => {
  assert.deepEqual(parseOpts(['--bg', '--', '--weird', '--bgg'], PLAN_SPEC), { _: ['--weird', '--bgg'], bg: true });
});

test('parseOpts: inherited property names are not flags', () => {
  assert.throws(() => parseOpts(['--constructor', 'x'], PLAN_SPEC), /unknown/i);
  assert.throws(() => parseOpts(['--toString'], PLAN_SPEC), /unknown/i);
  assert.equal(Object.hasOwn(parseOpts(['--bg'], PLAN_SPEC), 'toString'), false);
});

const ff = (...args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [fileURLToPath(new URL('../bin/ff.mjs', import.meta.url)), ...args], { encoding: 'utf8', stdio: 'pipe' }), err: '' };
  } catch (e) { return { code: e.status, out: String(e.stdout), err: String(e.stderr) }; }
};

test('ff: --help and <command> --help print usage and exit 0', () => {
  for (const args of [['--help'], ['eval', '--help'], ['run', '--help']]) {
    const r = ff(...args);
    assert.equal(r.code, 0, args.join(' '));
    assert.match(r.out, /feature-flow \(ff\)/);
  }
});

test('ff: inherited command names print usage and exit 1', () => {
  const r = ff('constructor');
  assert.equal(r.code, 1);
  assert.match(r.out, /feature-flow \(ff\)/);
});

test('ff: non-numeric epic or --runs fail with a clear error', () => {
  assert.match(ff('run', 'abc').err, /epic.*abc/i);
  assert.equal(ff('run', 'abc').code, 1);
  assert.match(ff('eval', '--plan', 'p.json', '--runs', 'three', 'v.json').err, /--runs.*three/i);
  assert.match(ff('eval', '--plan', 'p.json', '--runs', '0', 'v.json').err, /--runs/i);
  assert.match(ff('eval', '--plan').err, /usage|--plan/i);
});

test('ff: argument errors print the error and usage', () => {
  for (const args of [['eval', '--plan'], ['plan', '--bgg', 'x'], ['run', 'abc']]) {
    const r = ff(...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, /feature-flow \(ff\)/, args.join(' '));
  }
});

test('ff: unknown options on every command print error and usage, no stack trace', () => {
  for (const cmd of ['doctor', 'publish', 'run', 'config']) {
    const r = ff(cmd, '--bogus', '1');
    assert.equal(r.code, 1, cmd);
    assert.match(r.err, /unknown option --bogus/, cmd);
    assert.match(r.err, /feature-flow \(ff\)/, cmd);
    assert.doesNotMatch(r.err, /\n\s+at /, cmd);
  }
});

test('ff: doctor and config reject unknown options', () => {
  assert.equal(ff('config', '--bogus').code, 1);
  assert.match(ff('doctor', '--bogus').err, /unknown option --bogus/);
});

test('ff: --help after -- is a positional, not help', () => {
  const r = ff('run', '--', '--help');
  assert.equal(r.code, 1);
  assert.match(r.err, /epic.*--help/i);
});

test('parseOpts: malformed dashed tokens before -- are rejected', () => {
  assert.throws(() => parseOpts(['--b.g', 'x'], PLAN_SPEC), /unknown.*--b\.g/i);
  assert.deepEqual(parseOpts(['--', '--b.g'], PLAN_SPEC), { _: ['--b.g'] });
});

test('positiveInt: rejects overflow and unsafe integers', () => {
  assert.equal(positiveInt('42', 'epic'), 42);
  assert.throws(() => positiveInt('9'.repeat(400), '--runs'), /--runs/);
  assert.throws(() => positiveInt('9007199254740993', 'epic'), /epic/);
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

test('red gate: a timed-out run is rejected even if it printed the test name', () => {
  const r = checkRed({ code: null, timedOut: true, output: 'not ok - rejects bad input' }, ['rejects bad input']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /timed out/i);
});

test('red gate: runner-not-found is rejected', () => {
  const r = checkRed({ code: 127, output: 'rejects bad input\n[ff: could not start command (win32 error 2)]\n' }, ['rejects bad input']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not start|not found/i);
});

test('red gate: nonzero exit without the reported test names is rejected', () => {
  const r = checkRed({ code: 1, output: 'SyntaxError: unexpected token' }, ['rejects bad input']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /rejects bad input/);
});

test('red gate: nonzero exit naming a reported failing test is accepted', () => {
  assert.deepEqual(checkRed({ code: 1, output: 'not ok 1 - rejects bad input' }, ['rejects bad input']), { ok: true });
});
