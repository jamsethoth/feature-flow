import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, runShell, killTree } from '../lib/exec.mjs';

const dir = mkdtempSync(join(tmpdir(), 'ff-exec-'));
const script = (name, src) => { const p = join(dir, name).replace(/\\/g, '/'); writeFileSync(p, src); return p; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// '€' is E2 82 AC; the first write ends mid-character.
const splitWriter = script('split.mjs', `
process.stdout.write(Buffer.from([0xe2, 0x82]));
setTimeout(() => process.stdout.write(Buffer.from([0xac, 0x0a])), 100);
`);

test('run: child that exits at once while 5 MB of stdin is written rejects with its exit code', async () => {
  await assert.rejects(
    run(process.execPath, ['-e', 'process.exit(3)'], { input: 'x'.repeat(5 * 1024 * 1024) }),
    (e) => e.code === 3,
  );
});

test('run: allowFail resolves with the exit code of an early-exiting child', async () => {
  const res = await run(process.execPath, ['-e', 'process.exit(3)'], { input: 'x'.repeat(5 * 1024 * 1024), allowFail: true });
  assert.equal(res.code, 3);
});

test('run: multi-byte character split across chunks is read back exactly', async () => {
  const res = await run(process.execPath, [splitWriter]);
  assert.equal(res.stdout, '€\n');
});

test('runShell: multi-byte character split across chunks is read back exactly', async () => {
  const res = await runShell(`node "${splitWriter}"`);
  assert.equal(res.output, '€\n');
});

test('runShell: a command waiting for stdin EOF returns promptly', async () => {
  const waiter = script('wait-stdin.mjs', `process.stdin.resume(); process.stdin.on('end', () => console.log('eof'));`);
  const t0 = Date.now();
  const res = await runShell(`node "${waiter}"`, { timeoutMs: 20000 });
  assert.ok(Date.now() - t0 < 5000, 'should not wait for the timeout');
  assert.equal(res.code, 0);
  assert.ok(!res.timedOut);
});

test('runShell: timeout returns promptly, flags timedOut and leaves no child running', async () => {
  const pidFile = join(dir, 'grandchild.pid').replace(/\\/g, '/');
  const grandchild = script('grandchild.mjs', `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => {}, 60000);
`);
  const parent = script('parent.mjs', `
import { spawn } from 'node:child_process';
spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' });
setTimeout(() => {}, 60000);
`);
  const t0 = Date.now();
  const res = await runShell(`node "${parent}"`, { timeoutMs: 1000 });
  assert.ok(Date.now() - t0 < 3000, 'should return within ~2s of the timeout');
  assert.equal(res.timedOut, true);
  await sleep(300);
  assert.ok(existsSync(pidFile), 'grandchild should have started');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const stillAlive = alive(pid);
  if (stillAlive) process.kill(pid); // don't leak it when the assertion fails
  assert.ok(!stillAlive, 'grandchild should be killed with the tree');
});

test('killTree: reports a failed termination instead of swallowing it', async () => {
  assert.ok(await killTree(2 ** 22 + 12345), 'a missing process should yield an error message');
});

test('runShell: a hanging killer cannot push the return past the allowance', async () => {
  const sleeper = script('sleeper.mjs', `setTimeout(() => {}, 8000);`);
  const t0 = Date.now();
  const res = await runShell(`node "${sleeper}"`, { timeoutMs: 500, killer: () => new Promise(() => {}) });
  assert.ok(Date.now() - t0 < 2500, 'should return within ~2s of the timeout');
  assert.equal(res.timedOut, true);
  assert.ok(res.killError);
});

test('runShell: when tree termination fails the calling process can still exit promptly', async () => {
  const sleeper = script('sleeper2.mjs', `setTimeout(() => {}, 8000);`);
  const caller = script('caller.mjs', `
import { runShell } from ${JSON.stringify(new URL('../lib/exec.mjs', import.meta.url).href)};
const r = await runShell('node "${sleeper}"', { timeoutMs: 300, killer: async () => 'boom' });
console.log(r.killError);
`);
  const t0 = Date.now();
  const res = await run(process.execPath, [caller]);
  assert.equal(res.stdout.trim(), 'boom');
  assert.ok(Date.now() - t0 < 5000, 'caller should exit without waiting for the surviving child');
});

test('run: failure message keeps the child stderr even with a several-KB argument list', async () => {
  const args = ['-e', 'console.error("BOOM" + "-STDERR"); process.exit(2)', 'a'.repeat(6000)];
  await assert.rejects(run(process.execPath, args), (e) => e.message.includes('BOOM-STDERR'));
});
