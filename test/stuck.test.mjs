import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as run from '../lib/run.mjs';
import * as stats from '../lib/stats.mjs';
import * as gh from '../lib/github.mjs';

const issue = (number, labels = [], extra = {}) => ({ number, state: 'OPEN', labels: labels.map((name) => ({ name })), ...extra });

test('setLabels logs and records a failed label update with the ticket number, and reports failure', async () => {
  const logs = [], events = [];
  const gh = { editLabels: async () => { throw new Error('HTTP 502'); } };
  const ok = await run.setLabels(gh, 7, { add: ['ready-for-qa'], remove: ['in-progress'] }, '/repo', { log: (m) => logs.push(m), ev: (t, d) => events.push([t, d]) });
  assert.equal(ok, false);
  assert.ok(logs.some((l) => l.includes('#7') && l.includes('HTTP 502')));
  assert.ok(events.some(([t, d]) => t === 'label_failed' && d.ticket === 7));
});

test('setLabels returns true and records nothing when the update succeeds', async () => {
  const events = [];
  const gh = { editLabels: async () => '' };
  assert.equal(await run.setLabels(gh, 7, { add: ['in-progress'] }, '/repo', { log() {}, ev: (t) => events.push(t) }), true);
  assert.deepEqual(events, []);
});

test('runExitCode is non-zero when any ticket had a label failure, zero otherwise', () => {
  assert.equal(run.runExitCode([{ ticket: 1, state: 'ready-for-qa' }]), 0);
  assert.notEqual(run.runExitCode([{ ticket: 1, state: 'ready-for-qa', labelFailed: true }]), 0);
});

test('epicProblem explains an epic with no sub-issues or nothing ready; null when something is ready', () => {
  assert.match(run.epicProblem([], []), /no sub-issues/i);
  const busy = [issue(2, ['in-progress'])];
  assert.match(run.epicProblem(busy, []), /nothing ready/i);
  assert.equal(run.epicProblem([issue(3)], [issue(3)]), null);
});

test('validateRetryStuck refuses numbers that are not sub-issues or not in-progress', () => {
  const tickets = [issue(7, ['in-progress']), issue(8, ['needs-human']), issue(9)];
  assert.doesNotThrow(() => run.validateRetryStuck([7], tickets));
  assert.throws(() => run.validateRetryStuck([99], tickets), /#99/);
  assert.throws(() => run.validateRetryStuck([7, 8], tickets), /#8/);
  assert.throws(() => run.validateRetryStuck([9], tickets), /#9/);
});

const fakeReset = ({ branches, prs = [{ number: 70, state: 'OPEN', isDraft: true }], failDiscard = false, failLabel = false }) => {
  const calls = [];
  const gh = {
    openPrs: async () => prs,
    closePr: async (n) => calls.push(['closePr', n]),
    editLabels: async (n, change) => { if (failLabel) throw new Error('HTTP 502'); calls.push(['editLabels', n, change]); },
  };
  const git = {
    ticketBranches: async (root, n) => (calls.push(['ticketBranches', n]), branches),
    discardBranch: async (root, b) => { if (failDiscard) throw new Error('worktree locked'); calls.push(['discardBranch', b.branch]); },
  };
  const logs = [], events = [];
  const opts = { repo: { mainRoot: '/repo' }, gh, git, log: (m) => logs.push(m), ev: (t, d) => events.push([t, d]) };
  return { calls, logs, events, opts };
};
const wtBranch = { branch: 'ticket/7-thing', path: '/wt/ticket-7', local: true, remote: true };

test('resetTicket closes the draft PR, discards the ticket branch and worktree, clears the label', async () => {
  const { calls, opts } = fakeReset({ branches: [wtBranch] });
  await run.resetTicket(7, opts);
  assert.deepEqual(calls.find((c) => c[0] === 'closePr'), ['closePr', 70]);
  assert.deepEqual(calls.find((c) => c[0] === 'discardBranch'), ['discardBranch', 'ticket/7-thing']);
  assert.deepEqual(calls.find((c) => c[0] === 'editLabels'), ['editLabels', 7, { remove: ['in-progress'] }]);
});

test('resetTicket cleans a leftover branch and draft PR even when no worktree exists', async () => {
  const { calls, opts } = fakeReset({ branches: [{ branch: 'ticket/7-thing', path: null, local: true, remote: true }] });
  await run.resetTicket(7, opts);
  assert.ok(calls.some((c) => c[0] === 'discardBranch'));
  assert.ok(calls.some((c) => c[0] === 'closePr'));
});

test('resetTicket refuses a published PR and touches nothing', async () => {
  const { calls, opts } = fakeReset({ branches: [wtBranch], prs: [{ number: 71, state: 'OPEN', isDraft: true }, { number: 70, state: 'OPEN', isDraft: false }] });
  await assert.rejects(run.resetTicket(7, opts), /published PR #70/);
  assert.ok(!calls.some((c) => ['closePr', 'discardBranch', 'editLabels'].includes(c[0])));
});

test('resetTicket closes every open draft PR for the branch', async () => {
  const { calls, opts } = fakeReset({ branches: [wtBranch], prs: [{ number: 70, isDraft: true }, { number: 72, isDraft: true }] });
  await run.resetTicket(7, opts);
  assert.deepEqual(calls.filter((c) => c[0] === 'closePr'), [['closePr', 70], ['closePr', 72]]);
});

test('resetTicket keeps the in-progress label when cleanup fails', async () => {
  const { calls, opts } = fakeReset({ branches: [wtBranch], failDiscard: true });
  await assert.rejects(run.resetTicket(7, opts), /worktree locked/);
  assert.ok(!calls.some((c) => c[0] === 'editLabels'));
});

test('resetTicket records a failed label removal in the log and events, and throws', async () => {
  const { logs, events, opts } = fakeReset({ branches: [wtBranch], failLabel: true });
  await assert.rejects(run.resetTicket(7, opts), /#7/);
  assert.ok(logs.some((l) => l.includes('#7') && l.includes('HTTP 502')));
  assert.ok(events.some(([t, d]) => t === 'label_failed' && d.ticket === 7));
});

test('stuckTickets lists only in-progress tickets older than stuckAfterHours; stuckMessage names the retry command', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const tickets = [
    issue(1, ['in-progress'], { inProgressSince: '2026-10-12T01:00:00Z' }), // 11h
    issue(2, ['in-progress'], { inProgressSince: '2026-10-12T10:00:00Z' }), // 2h
    issue(3, ['needs-human'], { inProgressSince: '2026-10-01T00:00:00Z' }),
  ];
  const stuck = run.stuckTickets(tickets, 6, now);
  assert.deepEqual(stuck.map((t) => t.number), [1]);
  assert.match(run.stuckMessage(5, stuck), /#1.*--retry-stuck 1|--retry-stuck 1/);
  assert.equal(run.stuckMessage(5, []), null);
});

test('loadStuckAges logs the ticket number and error when the age lookup fails', async () => {
  const logs = [];
  const tickets = [issue(7, ['in-progress']), issue(8, ['in-progress'])];
  const gh = { labelNames: (t) => t.labels.map((l) => l.name), inProgressSince: async (n) => { if (n === 7) throw new Error('HTTP 401'); return '2026-10-12T01:00:00Z'; } };
  await run.loadStuckAges(tickets, gh, '/repo', (m) => logs.push(m));
  assert.equal(tickets[0].inProgressSince, null);
  assert.equal(tickets[1].inProgressSince, '2026-10-12T01:00:00Z');
  assert.ok(logs.some((l) => l.includes('#7') && l.includes('HTTP 401')));
});

test('safeDiffStats logs a numstat failure and returns null instead of zeros', async () => {
  const logs = [];
  const git = { numstat: async () => { throw new Error('bad revision'); } };
  const diff = await run.safeDiffStats(git, '/wt', 'origin/main', (m) => logs.push(m));
  assert.equal(diff, null);
  assert.ok(logs.some((l) => l.includes('bad revision')));
});

test('refreshOutcomes counts PRs it could not refresh', async () => {
  const events = [
    { run: 'r', epic: 1, ticket: 1, type: 'ticket_end', state: 'ready-for-qa', pr: 10, ts: '2026-10-01T00:00:00Z' },
    { run: 'r', epic: 1, ticket: 2, type: 'ticket_end', state: 'ready-for-qa', pr: 11, ts: '2026-10-01T00:00:00Z' },
  ];
  const appended = [];
  const runGh = async (_cmd, args) => (args.includes('10')
    ? { stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-02T00:00:00Z', closedAt: null, commits: [] }) }
    : { stdout: '' });
  const res = await stats.refreshOutcomes(events, '/repo', (t, d) => appended.push([t, d]), runGh);
  assert.deepEqual(res, { refreshed: 1, failed: 1 });
  assert.match(stats.refreshSummary(res), /1 .*fail/i);
});

test('ticketBranches finds and discardBranch removes a ticket\'s branches, worktree or not, leaving other tickets alone', async () => {
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const git = await import('../lib/git.mjs');
  const root = mkdtempSync(join(tmpdir(), 'ff-stuck-'));
  try {
    const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
    sh(root, 'init', '--bare', '-b', 'main', 'origin.git');
    sh(root, 'clone', 'origin.git', 'main');
    const main = join(root, 'main');
    sh(main, 'commit', '--allow-empty', '-m', 'init');
    sh(main, 'push', 'origin', 'HEAD:main');
    sh(main, 'branch', 'ticket/7-with-wt');
    sh(main, 'branch', 'ticket/7-no-wt');
    sh(main, 'branch', 'ticket/70-other');
    sh(main, 'push', 'origin', 'ticket/7-no-wt');
    const wt = join(root, 'wt7');
    sh(main, 'worktree', 'add', wt, 'ticket/7-with-wt');

    const found = await git.ticketBranches(main, 7);
    assert.deepEqual(found.map((b) => b.branch).sort(), ['ticket/7-no-wt', 'ticket/7-with-wt']);
    for (const b of found) await git.discardBranch(main, b);

    assert.ok(!existsSync(wt));
    assert.deepEqual(await git.ticketBranches(main, 7), []);
    assert.equal(sh(main, 'ls-remote', '--heads', 'origin', 'ticket/7-no-wt').trim(), '');
    assert.equal((await git.ticketBranches(main, 70)).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retryStuckTickets resets only the named tickets and returns them ready, leaving other in-progress tickets untouched', async () => {
  const { calls, opts } = fakeReset({ branches: [wtBranch] });
  const labels = { 7: ['in-progress'], 8: ['in-progress'], 9: [] };
  opts.gh.editLabels = async (n, change) => { calls.push(['editLabels', n, change]); labels[n] = labels[n].filter((l) => !change.remove?.includes(l)); };
  opts.gh.viewIssue = async (n) => issue(n, labels[n]);
  const subs = [{ number: 7 }, { number: 8 }, { number: 9 }];
  const tickets = await Promise.all(subs.map((s) => opts.gh.viewIssue(s.number)));
  const after = await run.retryStuckTickets([7], tickets, subs, { ...opts, ev() {} });
  assert.deepEqual(calls.filter((c) => c[0] === 'ticketBranches'), [['ticketBranches', 7]]);
  assert.deepEqual(calls.filter((c) => c[0] === 'editLabels').map((c) => c[1]), [7]);
  assert.deepEqual(after.filter(gh.isReady).map((t) => t.number), [7, 9]); // 8 stays in-progress
});

test('retryStuckTickets validates before touching anything', async () => {
  const { calls, opts } = fakeReset({ branches: [wtBranch] });
  const tickets = [issue(7, ['in-progress']), issue(9)];
  await assert.rejects(run.retryStuckTickets([7, 9], tickets, [], { ...opts, ev() {} }), /#9/);
  assert.deepEqual(calls, []);
});

test('after discardBranch, ensureWorktree starts the ticket again from the base branch, not the old attempt', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const git = await import('../lib/git.mjs');
  const root = mkdtempSync(join(tmpdir(), 'ff-fresh-'));
  try {
    const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
    sh(root, 'init', '--bare', '-b', 'main', 'origin.git');
    sh(root, 'clone', 'origin.git', 'main');
    const main = join(root, 'main');
    sh(main, 'commit', '--allow-empty', '-m', 'init');
    sh(main, 'push', 'origin', 'HEAD:main');
    const base = sh(main, 'rev-parse', 'HEAD');
    const opts = { mainRoot: main, path: join(root, 'wt7'), branch: 'ticket/7-thing', base: 'main' };
    const first = await git.ensureWorktree(opts);
    sh(first.path, 'commit', '--allow-empty', '-m', 'test: old attempt');
    assert.notEqual(sh(first.path, 'rev-parse', 'HEAD'), base);
    for (const b of await git.ticketBranches(main, 7)) await git.discardBranch(main, b);
    const second = await git.ensureWorktree(opts);
    assert.equal(sh(second.path, 'rev-parse', 'HEAD'), base);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const ghFailure = () => new Error("gh issue edit 7 --add-label in-progress exited 1\nfailed to update https://github.com/o/r/issues/7: 'in-progress' not found");

test('setLabels keeps the reason from the later lines of the error in the log and the event', async () => {
  const logs = [], events = [];
  const gh = { editLabels: async () => { throw ghFailure(); } };
  await run.setLabels(gh, 7, { add: ['in-progress'] }, '/repo', { log: (m) => logs.push(m), ev: (t, d) => events.push([t, d]) });
  assert.ok(logs.some((l) => l.includes("'in-progress' not found")));
  assert.ok(events.some(([t, d]) => t === 'label_failed' && d.error.includes("'in-progress' not found")));
});

test('loadStuckAges and safeDiffStats keep the reason from the later lines of the error', async () => {
  const logs = [];
  const gh = { labelNames: (t) => t.labels.map((l) => l.name), inProgressSince: async () => { throw ghFailure(); } };
  await run.loadStuckAges([issue(7, ['in-progress'])], gh, '/repo', (m) => logs.push(m));
  await run.safeDiffStats({ numstat: async () => { throw ghFailure(); } }, '/wt', 'origin/main', (m) => logs.push(m));
  assert.equal(logs.length, 2);
  assert.ok(logs.every((l) => l.includes("'in-progress' not found")));
});

test('error excerpts are bounded', async () => {
  const logs = [];
  const gh = { editLabels: async () => { throw new Error(`first\n${'x'.repeat(5000)}`); } };
  await run.setLabels(gh, 7, {}, '/repo', { log: (m) => logs.push(m), ev() {} });
  assert.ok(logs[0].length < 500);
});
