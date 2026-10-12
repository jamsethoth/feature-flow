import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig, parseCommands, loadConfig, loadPersona, budgetFor } from '../lib/config.mjs';
import { topoSort } from '../lib/publish.mjs';
import { isReady } from '../lib/github.mjs';
import { stageForRound, pool } from '../lib/run.mjs';
import { codexUsage, recordedSandbox, apiCost, lastQuotaPct } from '../lib/adapters.mjs';
import { styleBlock } from '../lib/stages.mjs';
import { withPrefixedTwins, claudeToolkit, findClaudePlugin, codexMcpServers, codexPlugins, codexToolkit, claudeTrusted, grantClaudeTrust } from '../lib/toolkit.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { commitAll, discardChanges } from '../lib/git.mjs';
import { parseOpts } from '../lib/opts.mjs';
import { diffStats, severityCounts } from '../lib/events.mjs';
import { summarize, renderSummary } from '../lib/stats.mjs';
import { planShape, claudeTranscriptMetrics, codexTranscriptMetrics, lastRequestContext } from '../lib/planmetrics.mjs';
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
  const md = '# Repo\n- test: `nope`\n\n## Commands\n\n- test: `npm test`\n* Lint: `npm run lint`\n- run: `TODO`\n\n## Other\n- run: `x`\n';
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
