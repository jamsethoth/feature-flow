import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as realGh from '../lib/github.mjs';
import * as git from '../lib/git.mjs';
import * as run from '../lib/run.mjs';

// A disposable origin + clone with the minimal config and AGENTS.md that runEpic needs.
function epicRepo(testCommand = 'node -e 0') {
  const root = mkdtempSync(join(tmpdir(), 'ff-e2e-'));
  const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
  sh(root, 'init', '--bare', '-b', 'main', 'origin.git');
  sh(root, 'clone', 'origin.git', 'repo');
  const main = join(root, 'repo');
  mkdirSync(join(main, '.agents', 'feature-flow'), { recursive: true });
  writeFileSync(join(main, '.agents', 'feature-flow', 'feature-flow.json'), JSON.stringify({ planApproval: false, worktreeRoot: join(root, 'wts') }));
  writeFileSync(join(main, 'AGENTS.md'), `## Commands\n\n- test: \`${testCommand}\`\n`);
  writeFileSync(join(main, 'fail.mjs'), "console.log('not ok 1 - rejects bad input');process.exit(1);\n");
  sh(main, 'add', '-A');
  sh(main, 'commit', '-m', 'init');
  sh(main, 'push', 'origin', 'HEAD:main');
  return { root, sh, main };
}

test('runEpic --retry-stuck resets only the named ticket and restarts it at red from the base branch', async () => {
  const { root, sh, main } = epicRepo();
  try {
    const base = sh(main, 'rev-parse', 'HEAD');

    // A stopped run's leftover attempt for #7: worktree, extra commit, pushed branch.
    const old = await git.ensureWorktree({ mainRoot: main, path: join(root, 'wts', 'repo', 'ticket-7'), branch: 'ticket/7-thing', base: 'main' });
    sh(old.path, 'commit', '--allow-empty', '-m', 'test: old attempt');
    sh(old.path, 'push', '-u', 'origin', 'ticket/7-thing');

    const labels = { 1: [], 7: ['in-progress'], 8: ['in-progress'], 9: [] };
    const calls = [];
    const issue = (n) => ({ number: n, title: n === 7 ? 'Thing' : `Other ${n}`, state: 'OPEN', labels: labels[n].map((name) => ({ name })), blockedBy: [], subIssues: [] });
    const gh = {
      ...realGh,
      viewIssue: async (n) => n === 1 ? { ...issue(1), subIssues: [{ number: 7 }, { number: 8 }, { number: 9 }] } : issue(n),
      inProgressSince: async () => '2026-10-12T00:00:00Z',
      findPr: async () => undefined,
      openPrs: async (b) => b === 'ticket/7-thing' ? [{ number: 70, state: 'OPEN', isDraft: true }] : [],
      closePr: async (n) => calls.push(['closePr', n]),
      editLabels: async (n, { add = [], remove = [] }) => { calls.push(['editLabels', n]); labels[n] = [...labels[n].filter((l) => !remove.includes(l)), ...add]; },
      commentIssue: async (n) => calls.push(['comment', n]),
    };
    const invoked = [];
    const invoke = async ({ cwd }) => {
      invoked.push({ cwd, head: sh(cwd, 'rev-parse', 'HEAD'), branch: sh(cwd, 'rev-parse', '--abbrev-ref', 'HEAD') });
      return { out: { status: 'blocked', notes: 'stop after red' }, usage: { input: 0, cached: 0, output: 0 }, session: 's' };
    };

    const results = await run.runEpic(1, { cwd: main, print() {}, retryStuck: [7], deps: { gh, invoke } });

    const seven = invoked.find((i) => i.branch === 'ticket/7-thing');
    assert.ok(seven, 'ticket 7 was run');
    assert.equal(seven.head, base, 'ticket 7 restarted from the base branch, not the old attempt');
    assert.equal(sh(main, 'ls-remote', '--heads', 'origin', 'ticket/7-thing'), '', 'old attempt removed from origin');
    assert.deepEqual(calls.filter((c) => c[0] === 'closePr'), [['closePr', 70]]);
    assert.ok(!invoked.some((i) => i.cwd.includes('ticket-8')), 'ticket 8 is untouched');
    assert.ok(labels[8].includes('in-progress') && !calls.some((c) => c[1] === 8));
    assert.deepEqual(results.map((r) => r.ticket).sort(), [7, 8, 9]);
    assert.equal(run.runExitCode(results), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runEpic surfaces a failed label update with the ticket number in the log and events, and the run exits non-zero', async () => {
  const { root, sh, main } = epicRepo();
  try {

    const issue = (n) => ({ number: n, title: `Ticket ${n}`, state: 'OPEN', labels: [], blockedBy: [], subIssues: n === 1 ? [{ number: 9 }] : [] });
    const gh = {
      ...realGh,
      viewIssue: async (n) => issue(n),
      findPr: async () => undefined,
      editLabels: async () => { throw new Error('HTTP 502'); },
      commentIssue: async () => {},
    };
    const invoke = async () => ({ out: { status: 'blocked', notes: 'stop after red' }, usage: { input: 0, cached: 0, output: 0 }, session: 's' });
    const logs = [];

    const results = await run.runEpic(1, { cwd: main, print: (l) => logs.push(l), deps: { gh, invoke } });

    assert.ok(logs.some((l) => l.includes('#9') && l.includes('HTTP 502')), 'log names the ticket and the error');
    const events = readFileSync(join(main, '.git', 'feature-flow', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(events.some((e) => e.type === 'label_failed' && e.ticket === 9 && e.error.includes('HTTP 502')), 'event names the ticket and the error');
    assert.equal(results.find((r) => r.ticket === 9).labelFailed, true);
    assert.equal(run.runExitCode(results), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a crashed ticket keeps the reason from the later lines of the error in the result and the ticket_end event', async () => {
  const { root, main } = epicRepo();
  try {
    const issue = (n) => ({ number: n, title: `Ticket ${n}`, state: 'OPEN', labels: [], blockedBy: [], subIssues: n === 1 ? [{ number: 9 }] : [] });
    const gh = { ...realGh, viewIssue: async (n) => issue(n), findPr: async () => undefined, editLabels: async () => '', commentIssue: async () => {} };
    const invoke = async () => { throw new Error("git push origin x exited 1\nremote: Permission to o/r denied to u"); };

    const results = await run.runEpic(1, { cwd: main, print() {}, deps: { gh, invoke } });

    assert.match(results.find((r) => r.ticket === 9).error, /Permission to o\/r denied/);
    const events = readFileSync(join(main, '.git', 'feature-flow', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.match(events.find((e) => e.type === 'ticket_end' && e.ticket === 9).error, /Permission to o\/r denied/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invoke and the stage_call event carry the stage tools', async () => {
  const { root, main } = epicRepo();
  try {
    const issue = (n) => ({ number: n, title: `Ticket ${n}`, state: 'OPEN', labels: [], blockedBy: [], subIssues: n === 1 ? [{ number: 9 }] : [] });
    const gh = { ...realGh, viewIssue: async (n) => issue(n), findPr: async () => undefined, editLabels: async () => '', commentIssue: async () => {} };
    const seen = [];
    const invoke = async ({ stageName, tools }) => {
      seen.push({ stageName, tools });
      return { out: { status: 'blocked', notes: 'stop' }, usage: { input: 0, cached: 0, output: 0 }, session: 's' };
    };
    await run.runEpic(1, { cwd: main, print() {}, deps: { gh, invoke } });
    const want = { skills: ['mattpocock-skills:tdd'], mcp: [], plugins: ['ponytail'] };
    assert.deepEqual(seen[0], { stageName: 'implement', tools: want });
    const events = readFileSync(join(main, '.git', 'feature-flow', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(events.find((e) => e.type === 'stage_call' && e.stage === 'implement').tools, want);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Drives a ticket through the red gate only: the agent "writes" a test file and reports names, green never passes.
async function redRun(testCommand, tests) {
  const { root, sh, main } = epicRepo(testCommand);
  try {
    const issue = (n) => ({ number: n, title: `Ticket ${n}`, state: 'OPEN', labels: [], blockedBy: [], subIssues: n === 1 ? [{ number: 9 }] : [] });
    const gh = { ...realGh, viewIssue: async (n) => issue(n), findPr: async () => undefined, editLabels: async () => '', commentIssue: async () => {} };
    const prompts = [];
    const invoke = async ({ cwd, prompt }) => {
      prompts.push(prompt);
      writeFileSync(join(cwd, 'new.test.mjs'), '// test\n');
      return { out: { status: 'ok', summary: 's', notes: '', tests }, usage: { input: 0, cached: 0, output: 0 }, session: 's' };
    };
    await run.runEpic(1, { cwd: main, print() {}, deps: { gh, invoke } });
    const events = readFileSync(join(main, '.git', 'feature-flow', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const subjects = sh(main, 'log', '--format=%s', 'ticket/9-ticket-9').split('\n');
    return { events, prompts, subjects };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a red gate whose runner cannot start is not committed; red_failed records the reason and the next attempt sees it', async () => {
  const { events, prompts, subjects } = await redRun('ff-no-such-runner-xyz', ['rejects bad input']);
  assert.ok(!subjects.some((s) => s.startsWith('test:')), 'no test: commit');
  const failed = events.filter((e) => e.type === 'red_failed');
  assert.ok(failed.length >= 2);
  assert.ok(failed[0].reason);
  assert.ok(prompts.some((p) => p.includes(failed[0].reason)), 'history carries the reason into the next red prompt');
});

test('a red gate whose output names none of the reported tests is not committed', async () => {
  const { events, subjects } = await redRun('node fail.mjs', ['some other test']);
  assert.ok(!subjects.some((s) => s.startsWith('test:')));
  assert.match(events.find((e) => e.type === 'red_failed').reason, /does not mention any reported failing test/);
});

test('a red gate with a nonzero exit naming a reported test is committed as test:', async () => {
  const { events, subjects } = await redRun('node fail.mjs', ['rejects bad input']);
  assert.ok(subjects.some((s) => s.startsWith('test:')));
  assert.ok(!events.some((e) => e.type === 'red_failed'));
});
