import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as realGh from '../lib/github.mjs';
import * as git from '../lib/git.mjs';
import * as run from '../lib/run.mjs';

test('runEpic --retry-stuck resets only the named ticket and restarts it at red from the base branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ff-e2e-'));
  try {
    const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
    sh(root, 'init', '--bare', '-b', 'main', 'origin.git');
    sh(root, 'clone', 'origin.git', 'repo');
    const main = join(root, 'repo');
    mkdirSync(join(main, '.agents', 'feature-flow'), { recursive: true });
    writeFileSync(join(main, '.agents', 'feature-flow', 'feature-flow.json'), JSON.stringify({ planApproval: false, worktreeRoot: join(root, 'wts') }));
    writeFileSync(join(main, 'AGENTS.md'), '## Commands\n\n- test: `node -e 0`\n');
    sh(main, 'add', '-A');
    sh(main, 'commit', '-m', 'init');
    sh(main, 'push', 'origin', 'HEAD:main');
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
