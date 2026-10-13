import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import { runEpic, stageCall } from '../lib/run.mjs';
import { adapters } from '../lib/adapters.mjs';
import { stageTools, skillsBlock } from '../lib/toolkit.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const withRepoLayer = (json) => {
  const root = mkdtempSync(join(tmpdir(), 'ff-layer-'));
  mkdirSync(join(root, '.agents', 'feature-flow'), { recursive: true });
  writeFileSync(join(root, '.agents', 'feature-flow', 'feature-flow.json'), JSON.stringify(json));
  return root;
};

test('loadConfig rejects each replaced key and names stageTools', () => {
  for (const [json, key] of [
    [{ stageSkills: {} }, 'stageSkills'],
    [{ toolkit: { claude: { plugins: ['x'] } } }, 'toolkit.claude.plugins'],
    [{ toolkit: { codex: { disableMcp: true } } }, 'toolkit.codex.disableMcp'],
    [{ toolkit: { codex: { disablePlugins: ['x'] } } }, 'toolkit.codex.disablePlugins'],
  ]) {
    assert.throws(() => loadConfig(withRepoLayer(json)), (e) => e.message.includes(`"${key}"`) && /stageTools\./.test(e.message), key);
  }
});

test('shipped defaults carry stageTools and none of the replaced keys', () => {
  const cfg = loadConfig(null);
  assert.equal(cfg.stageSkills, undefined);
  assert.equal(cfg.toolkit.claude.plugins, undefined);
  assert.equal(cfg.toolkit.codex.disableMcp, undefined);
  assert.equal(cfg.toolkit.codex.disablePlugins, undefined);
  assert.deepEqual(cfg.stageTools, {
    plan: { skills: ['grilling', 'to-tickets', 'writing-for-agents'], mcp: [], plugins: [] },
    implement: { skills: ['mattpocock-skills:tdd'], mcp: [], plugins: ['ponytail'] },
    review: { skills: ['mattpocock-skills:code-review'], mcp: [], plugins: ['ponytail'] },
    escalate: { skills: ['mattpocock-skills:diagnosing-bugs', 'mattpocock-skills:tdd'], mcp: [], plugins: ['ponytail'] },
  });
  assert.match(skillsBlock(cfg.stageTools.implement.skills), /`mattpocock-skills:tdd`/);
});

test('stageTools: qualified Claude plugin name matches the full installed key; plan plugins are not validated', () => {
  const claudeHome = mkdtempSync(join(tmpdir(), 'ff-home-'));
  const inst = join(claudeHome, 'cache', 'alpha');
  mkdirSync(inst, { recursive: true });
  mkdirSync(join(claudeHome, 'plugins'), { recursive: true });
  writeFileSync(join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'alpha@mkt': [{ installPath: inst }] } }));
  const cfg = (plugins) => ({ implement: { cli: 'claude' }, plan: { cli: 'claude' }, toolkit: {}, stageTools: { implement: { plugins }, plan: { plugins } } });
  assert.deepEqual(stageTools(cfg(['alpha@mkt']), 'implement', { claudeHome }).args, ['--plugin-dir', inst]);
  assert.deepEqual(stageTools(cfg(['alpha@other']), 'implement', { claudeHome }).missing, ['plugin alpha@other']);
  const plan = stageTools(cfg(['nope']), 'plan', { claudeHome });
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.tools.plugins, ['nope']);
});

test('stageCall passes the resolved stage args to the adapter and puts tools in the stage_call event', async () => {
  const claudeHome = mkdtempSync(join(tmpdir(), 'ff-home-'));
  const inst = join(claudeHome, 'cache', 'alpha');
  mkdirSync(inst, { recursive: true });
  mkdirSync(join(claudeHome, 'plugins'), { recursive: true });
  writeFileSync(join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'alpha@mkt': [{ installPath: inst }] } }));
  const cfg = { implement: { cli: 'claude', model: 'm', effort: 'low' }, toolkit: {}, stageTools: { implement: { skills: ['s1'], mcp: ['m1'], plugins: ['alpha'] } } };
  const seen = [];
  const events = [];
  const real = adapters.claude;
  adapters.claude = async (opts) => { seen.push(opts); return { out: { status: 'done' }, usage: { input: 1, cached: 0, output: 1 }, session: 's' }; };
  try {
    await stageCall({ cfg, stageName: 'implement', phase: 'red', round: 0, prompt: 'P', cwd: '.', commands: {}, style: '', persona: { name: 'x', hash: 'h' }, ev: (t, d) => events.push([t, d]), log: () => {}, homes: { claudeHome } });
  } finally { adapters.claude = real; }
  assert.match(seen[0].prompt, /`s1`/);
  assert.deepEqual(seen[0].stageArgs, ['--plugin-dir', inst]);
  assert.deepEqual(events.find(([t]) => t === 'stage_call')[1].tools, { skills: ['s1'], mcp: ['m1'], plugins: ['alpha'] });
});

test('stageTools: Claude plugins become --plugin-dir args and a missing one is reported', () => {
  const claudeHome = mkdtempSync(join(tmpdir(), 'ff-home-'));
  const inst = join(claudeHome, 'cache', 'alpha');
  mkdirSync(inst, { recursive: true });
  mkdirSync(join(claudeHome, 'plugins'), { recursive: true });
  writeFileSync(join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'alpha@mkt': [{ installPath: inst }] } }));
  const cfg = (plugins) => ({ implement: { cli: 'claude' }, toolkit: {}, stageTools: { implement: { skills: ['tdd'], mcp: [], plugins } } });
  const ok = stageTools(cfg(['alpha']), 'implement', { claudeHome });
  assert.deepEqual(ok.missing, []);
  assert.deepEqual(ok.tools, { skills: ['tdd'], mcp: [], plugins: ['alpha'] });
  assert.deepEqual(ok.args.filter((a, i) => ok.args[i - 1] === '--plugin-dir'), [inst]);
  assert.equal(ok.args.filter((a) => a === '--plugin-dir').length, 1);
  const bad = stageTools(cfg(['alpha', 'ghost']), 'implement', { claudeHome });
  assert.deepEqual(bad.missing, ['plugin ghost']);
  assert.equal(stageTools(cfg([]), 'implement', { claudeHome }).args.includes('--plugin-dir'), false);
});

const codexHomeWith = (toml) => {
  const codexHome = mkdtempSync(join(tmpdir(), 'ff-codex-'));
  writeFileSync(join(codexHome, 'config.toml'), toml);
  return codexHome;
};
const codexCfg = (plugins) => ({ review: { cli: 'codex' }, toolkit: { codex: {} }, stageTools: { review: { skills: [], mcp: ['serena'], plugins } } });

test('stageTools: Codex allowlist enables listed and disables unlisted plugins; bare name matches name@marketplace', () => {
  const codexHome = codexHomeWith('[plugins."ponytail@ponytail"]\nenabled=true\n[plugins."github@openai-curated"]\nenabled=true\n');
  const r = stageTools(codexCfg(['ponytail']), 'review', { codexHome });
  assert.deepEqual(r.missing, []);
  assert.ok(r.args.includes('plugins."ponytail@ponytail".enabled=true'));
  assert.ok(r.args.includes('plugins."github@openai-curated".enabled=false'));
  const q = stageTools(codexCfg(['github@openai-curated']), 'review', { codexHome });
  assert.ok(q.args.includes('plugins."github@openai-curated".enabled=true'));
  assert.ok(q.args.includes('plugins."ponytail@ponytail".enabled=false'));
  assert.deepEqual(stageTools(codexCfg(['nope']), 'review', { codexHome }).missing, ['plugin nope']);
});

test('stageTools: ambiguous bare Codex plugin name is reported with both candidates', () => {
  const codexHome = codexHomeWith('[plugins."p@one"]\n[plugins."p@two"]\n');
  assert.deepEqual(stageTools(codexCfg(['p']), 'review', { codexHome }).missing, ['plugin p ambiguous: p@one, p@two']);
});

test('stageTools: Codex disables every configured MCP server whatever the stage lists', () => {
  const codexHome = codexHomeWith('[mcp_servers.serena]\n[mcp_servers.playwright]\n[mcp_servers.node_repl.env]\nX=1\n');
  const { args } = stageTools(codexCfg([]), 'review', { codexHome });
  assert.ok(args.includes('mcp_servers.serena.enabled=false'));
  assert.ok(args.includes('mcp_servers.playwright.enabled=false'));
  assert.equal(args.some((a) => a.includes('enabled=true')), false);
});

test('stageTools: Codex headers with trailing comments are still disabled', () => {
  const codexHome = codexHomeWith('[plugins."extra@market"] # note\nenabled=true\n[mcp_servers.serena] # note\n');
  const { args } = stageTools(codexCfg([]), 'review', { codexHome });
  assert.ok(args.includes('plugins."extra@market".enabled=false'));
  assert.ok(args.includes('mcp_servers.serena.enabled=false'));
});

test('runEpic stops before any worktree when a stage plugin is missing, naming stage and plugin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-epic-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  writeFileSync(join(dir, 'AGENTS.md'), '## Commands\n- test: `npm test`\n');
  const wtRoot = join(dir, 'wt');
  mkdirSync(join(dir, '.agents', 'feature-flow'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'feature-flow', 'feature-flow.json'), JSON.stringify({ worktreeRoot: wtRoot, stageTools: { implement: { plugins: ['no-such-plugin'] } } }));
  await assert.rejects(runEpic(1, { cwd: dir, print: () => {} }), /implement: .*no-such-plugin/);
  assert.equal(existsSync(wtRoot), false);
});
