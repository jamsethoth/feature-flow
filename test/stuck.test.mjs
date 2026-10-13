import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as run from '../lib/run.mjs';
import * as stats from '../lib/stats.mjs';

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

const fakeReset = ({ branches, pr = { number: 70, state: 'OPEN', isDraft: true }, failDiscard = false, failLabel = false }) => {
  const calls = [];
  const gh = {
    findPr: async () => pr,
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
  const { calls, opts } = fakeReset({ branches: [wtBranch], pr: { number: 70, state: 'OPEN', isDraft: false } });
  await assert.rejects(run.resetTicket(7, opts), /published PR #70/);
  assert.ok(!calls.some((c) => ['closePr', 'discardBranch', 'editLabels'].includes(c[0])));
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
