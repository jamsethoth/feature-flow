import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig, parseCommands, loadConfig, loadPersona } from '../lib/config.mjs';
import { topoSort } from '../lib/publish.mjs';
import { isReady } from '../lib/github.mjs';
import { stageForRound, pool } from '../lib/run.mjs';

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
