import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import * as toolkit from '../lib/toolkit.mjs';
import * as runMod from '../lib/run.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// Namespace access so a missing export fails its own test, not the whole file.
const { findClaudePlugin, skillsBlock } = toolkit;
const stageTools = (...a) => toolkit.stageTools(...a);
const runTicket = (...a) => runMod.runTicket(...a);
const runEpic = (...a) => runMod.runEpic(...a);

const tmp = (p = 'ff-st-') => mkdtempSync(join(tmpdir(), p));
const repoWithConfig = (cfg) => {
  const d = tmp();
  mkdirSync(join(d, '.agents', 'feature-flow'), { recursive: true });
  writeFileSync(join(d, '.agents', 'feature-flow', 'feature-flow.json'), JSON.stringify(cfg));
  return d;
};
const claudeHome = (installed) => {
  const home = tmp('ff-claude-');
  mkdirSync(join(home, 'plugins'), { recursive: true });
  const plugins = {};
  for (const key of installed) {
    const path = join(home, 'plugins', 'cache', key.replace('@', '-'));
    mkdirSync(path, { recursive: true });
    plugins[key] = [{ installPath: path }];
  }
  writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins }));
  return { home, path: (key) => plugins[key][0].installPath };
};
const stageCfg = (cli, plugins, extra = {}) => ({
  implement: { cli, model: 'm', effort: 'low', persona: 'implementer' },
  toolkit: { claude: { hooks: [] }, codex: { useUserConfig: true, hooks: false } },
  stageTools: { implement: { skills: ['tdd'], mcp: [], plugins, ...extra } },
});
const pluginFixture = (...ids) => JSON.stringify({ installed: ids.map((pluginId) => ({ pluginId, name: pluginId.split('@')[0], marketplaceName: pluginId.split('@')[1] })) });
// Injected lister: gets the codex args (`plugin list --json` / `mcp list --json`), returns stdout text.
const codexFixture = ({ plugins = pluginFixture(), mcp = '[]' } = {}) => (args) => (args.includes('plugin') ? plugins : mcp);
const pluginDirs = (args) => args.flatMap((a, i) => (args[i - 1] === '--plugin-dir' ? [a] : []));

test('loadConfig rejects each replaced key and names stageTools', () => {
  for (const [old, layer] of [
    ['stageSkills', { stageSkills: {} }],
    ['toolkit.claude.plugins', { toolkit: { claude: { plugins: ['x'] } } }],
    ['toolkit.codex.disableMcp', { toolkit: { codex: { disableMcp: true } } }],
    ['toolkit.codex.disablePlugins', { toolkit: { codex: { disablePlugins: ['x'] } } }],
  ]) {
    assert.throws(() => loadConfig(repoWithConfig(layer)), (e) => e.message.includes(`"${old}"`) && e.message.includes('stageTools'), old);
  }
});

test('loadConfig names every old key found in a layer', () => {
  const root = repoWithConfig({ stageSkills: {}, toolkit: { codex: { disableMcp: true } } });
  assert.throws(() => loadConfig(root), (e) => e.message.includes('"stageSkills"') && e.message.includes('"toolkit.codex.disableMcp"'));
});

test('shipped defaults carry stageTools and none of the old keys', () => {
  const cfg = loadConfig(null);
  assert.equal(cfg.stageSkills, undefined);
  assert.equal(cfg.toolkit.claude.plugins, undefined);
  assert.equal(cfg.toolkit.codex.disableMcp, undefined);
  assert.equal(cfg.toolkit.codex.disablePlugins, undefined);
  for (const s of ['plan', 'implement', 'review', 'escalate']) {
    for (const k of ['skills', 'mcp', 'plugins']) assert.ok(Array.isArray(cfg.stageTools[s][k]), `${s}.${k}`);
  }
  for (const s of ['implement', 'review', 'escalate']) {
    assert.deepEqual(cfg.stageTools[s].plugins, ['ponytail'], s);
    assert.ok(cfg.stageTools[s].skills.every((k) => k.includes(':')), `${s} skills are qualified`);
  }
});

test('findClaudePlugin resolves bare and qualified names', () => {
  const { home, path } = claudeHome(['alpha@mkt']);
  assert.equal(findClaudePlugin('alpha', home), path('alpha@mkt'));
  assert.equal(findClaudePlugin('alpha@mkt', home), path('alpha@mkt'));
  assert.equal(findClaudePlugin('alpha@other', home), null);
});

test('stageTools (claude): listed plugins become the only --plugin-dir args; a missing one is reported', async () => {
  const { home, path } = claudeHome(['alpha@mkt', 'beta@mkt']);
  const r = await stageTools(stageCfg('claude', ['alpha']), 'implement', { claudeHome: home });
  assert.deepEqual(pluginDirs(r.args), [path('alpha@mkt')]);
  assert.deepEqual(r.tools, { skills: ['tdd'], mcp: [], plugins: ['alpha'] });
  assert.deepEqual(r.missing, []);
  const q = await stageTools(stageCfg('claude', ['alpha@mkt']), 'implement', { claudeHome: home });
  assert.deepEqual(pluginDirs(q.args), [path('alpha@mkt')]);
  const m = await stageTools(stageCfg('claude', ['alpha', 'nope']), 'implement', { claudeHome: home });
  assert.deepEqual(m.missing, ['plugin nope']);
});

test('stageTools (codex): exact plugin allowlist, bare names match name@marketplace', async () => {
  const codexJson = codexFixture({ plugins: pluginFixture('ponytail@ponytail', 'github@openai-curated') });
  const r = await stageTools(stageCfg('codex', ['ponytail']), 'implement', { codexJson });
  assert.ok(r.args.includes('plugins."ponytail@ponytail".enabled=true'));
  assert.ok(r.args.includes('plugins."github@openai-curated".enabled=false'));
  assert.deepEqual(r.missing, []);
  const q = await stageTools(stageCfg('codex', ['github@openai-curated']), 'implement', { codexJson });
  assert.ok(q.args.includes('plugins."github@openai-curated".enabled=true'));
  assert.ok(q.args.includes('plugins."ponytail@ponytail".enabled=false'));
});

test('stageTools (codex): unknown plugin is missing, ambiguous bare name lists both candidates', async () => {
  const codexJson = codexFixture({ plugins: pluginFixture('dup@a', 'dup@b', 'github@openai-curated') });
  const r = await stageTools(stageCfg('codex', ['dup', 'ghost']), 'implement', { codexJson });
  assert.ok(r.missing.includes('plugin dup ambiguous: dup@a, dup@b'), r.missing.join('|'));
  assert.ok(r.missing.includes('plugin ghost'));
});

test('stageTools (codex): every listed MCP server, including plugin-provided ones, is disabled', async () => {
  const codexJson = codexFixture({ mcp: JSON.stringify([{ name: 'context7' }, { name: 'github-plugin-server' }]) });
  const r = await stageTools(stageCfg('codex', [], { mcp: ['context7'] }), 'implement', { codexJson });
  assert.ok(r.args.includes('mcp_servers.context7.enabled=false'));
  assert.ok(r.args.includes('mcp_servers.github-plugin-server.enabled=false'));
  assert.equal(r.args.some((a) => a.startsWith('mcp_servers.') && a.endsWith('.enabled=true')), false);
});

test('stageTools (codex): a failing or unparsable listing throws, never yields an empty list', async () => {
  const cfg = stageCfg('codex', []);
  await assert.rejects(async () => stageTools(cfg, 'implement', { codexJson: () => { throw new Error('codex exploded'); } }));
  await assert.rejects(async () => stageTools(cfg, 'implement', { codexJson: () => 'not json' }));
  await assert.rejects(async () => stageTools(cfg, 'implement', { codexJson: codexFixture({ mcp: 'not json' }) }));
});

test('skillsBlock is built from stageTools.<stage>.skills', () => {
  const cfg = { stageTools: { implement: { skills: ['mattpocock-skills:tdd'] } } };
  assert.match(skillsBlock(cfg.stageTools?.implement?.skills), /`mattpocock-skills:tdd`/);
});

test('runTicket records the resolved tools in the stage_call event and hands them to invoke', async () => {
  const cfg = { ...loadConfig(null), maxReviewRounds: 0, escalationEnabled: false };
  const wt = tmp('ff-wt-dir-');
  const resolved = { tools: { skills: ['s:one'], mcp: ['m1'], plugins: ['alpha'] }, missing: [], args: ['--plugin-dir', 'x'] };
  const events = [];
  const invokes = [];
  const noop = async () => {};
  await runTicket({ number: 7, title: 'T', body: '' }, {
    repo: { mainRoot: wt, name: 'r' }, cfg, commands: { test: 'true' }, log: () => {}, ev: (type, data) => events.push({ type, ...data }),
  }, {
    stageTools: () => resolved,
    invoke: async (opts) => { invokes.push(opts); return { out: { status: 'blocked', notes: 'stop' }, usage: { input: 0, cached: 0, output: 0 }, session: 's' }; },
    git: { worktreePath: () => wt, slugify: (s) => s, ensureWorktree: async () => ({ path: wt, branch: 'ticket/7-t' }), numstat: async () => '' },
    gh: { editLabels: noop, commentIssue: noop, findPr: async () => null },
  });
  const call = events.find((e) => e.type === 'stage_call');
  assert.deepEqual(call.tools, resolved.tools);
  assert.equal(invokes.length > 0, true);
});

test('runEpic stops before any worktree when a stage plugin is missing, naming stage and plugin', async () => {
  const root = tmp('ff-epic-');
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'AGENTS.md'), '## Commands\n\n- test: `true`\n');
  mkdirSync(join(root, '.agents', 'feature-flow'), { recursive: true });
  writeFileSync(join(root, '.agents', 'feature-flow', 'feature-flow.json'), JSON.stringify({
    worktreeRoot: join(root, 'wts'),
    implement: { cli: 'claude' }, review: { cli: 'claude' },
    stageTools: { implement: { plugins: ['no-such-plugin'] } },
  }));
  await assert.rejects(runEpic(1, { cwd: root, print: () => {} }), (e) => /implement/.test(e.message) && /no-such-plugin/.test(e.message));
  assert.equal(existsSync(join(root, 'wts')), false);
});

test('ff doctor: one tools line per stage; plan ignores a nonexistent plugin', () => {
  const root = repoWithConfig({ stageTools: { plan: { plugins: ['no-such-plugin'] } } });
  execFileSync('git', ['init', '-q', root]);
  let out;
  try { out = execFileSync(process.execPath, [fileURLToPath(new URL('../bin/ff.mjs', import.meta.url)), 'doctor'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { out = String(e.stdout); }
  for (const s of ['plan', 'implement', 'review']) assert.match(out, new RegExp(`tools ${s}\\b`), `tools ${s} line`);
  assert.match(out, /^ok\s+tools plan\s.*ignored \(interactive\)/m);
  assert.doesNotMatch(out, /^FAIL\s+tools plan/m);
});
