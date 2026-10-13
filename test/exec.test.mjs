import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, runShell } from '../lib/exec.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'ff-exec-'));
const script = (name, body) => { const p = join(tmp, name); writeFileSync(p, body); return p; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end && !fn()) await new Promise((r) => setTimeout(r, 50)); return fn(); };

// Only a restricted sandbox may refuse cleanup; there survivors need only be reported.
const sandboxed = process.env.FF_TEST_SANDBOXED === '1';

// Parent spawns a detached grandchild through an intermediate that lingers ~2 s (so the watcher sees the chain) and
// then exits, leaving the grandchild orphaned while the parent outlives the timeout.
function orphanScripts(name) {
  const pidFile = join(tmp, `${name}.pid`);
  const grandchild = script(`${name}-gc.mjs`, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`);
  const middle = script(`${name}-mid.mjs`, `import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(grandchild)}], { detached: true, stdio: 'ignore' }).unref(); setTimeout(() => {}, 2000);`);
  const top = script(`${name}-top.mjs`, `import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(middle)}], { stdio: 'ignore' }); setTimeout(() => {}, 60000);`);
  return { pidFile, cmd: `"${process.execPath}" "${top}"` };
}

test('run: child that exits early while 5 MB of stdin is written resolves/rejects with its exit code', async () => {
  const input = 'x'.repeat(5 * 1024 * 1024);
  const args = ['-e', 'process.exit(3)'];
  const res = await run(process.execPath, args, { input, allowFail: true });
  assert.equal(res.code, 3);
  await assert.rejects(run(process.execPath, args, { input }), (e) => e.code === 3);
});

test('run and runShell read a multi-byte character split across chunks exactly', async () => {
  const p = script('split.mjs', `process.stdout.write(Buffer.from([0xe2, 0x82])); setTimeout(() => process.stdout.write(Buffer.from([0xac, 0x0a])), 200);`);
  assert.equal((await run(process.execPath, [p])).stdout.trim(), '€');
  assert.equal((await runShell(`"${process.execPath}" "${p}"`)).output.trim(), '€');
});

test('runShell: a command waiting for stdin EOF returns promptly', async () => {
  const p = script('stdin.mjs', `process.stdin.resume(); process.stdin.on('end', () => console.log('eof'));`);
  const t = Date.now();
  const res = await runShell(`"${process.execPath}" "${p}"`, { timeoutMs: 20000 });
  assert.ok(Date.now() - t < 10000);
  assert.ok(!res.timedOut);
  assert.match(res.output, /eof/);
});

test('runShell with a timeout still returns the exit code and output of a command that finishes', async () => {
  const p = script('exit7.mjs', `console.log('hi'); process.exit(7);`);
  const res = await runShell(`"${process.execPath}" "${p}"`, { timeoutMs: 20000 });
  assert.equal(res.code, 7);
  assert.match(res.output, /hi/);
  assert.ok(!res.timedOut);
  assert.ok(!/FFJOB/.test(res.output));
});

test('runShell: a command outliving timeoutMs returns within budget, flagged as timed out', async () => {
  const p = script('sleep.mjs', `setTimeout(() => {}, 60000);`);
  const t = Date.now();
  const res = await runShell(`"${process.execPath}" "${p}"`, { timeoutMs: 500 });
  assert.ok(Date.now() - t < 500 + 2500, `took ${Date.now() - t} ms`);
  assert.equal(res.timedOut, true);
});

test('runShell timeout kills descendants by PID, including one whose parent already exited', async () => {
  const { pidFile, cmd } = orphanScripts('orphan');
  const res = await runShell(cmd, { timeoutMs: 3500 });
  assert.equal(res.timedOut, true);
  assert.ok(await waitFor(() => existsSync(pidFile), 1000), 'grandchild never started');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    if (sandboxed) assert.ok(res.survivors.length === 0 || res.survivors.some((s) => s.pid === pid && s.error), 'survivor not reported');
    else {
      assert.deepEqual(res.survivors, []);
      assert.ok(await waitFor(() => !alive(pid), 2000), 'descendant still running');
    }
  } finally {
    try { process.kill(pid); } catch {}
  }
});

test('runShell reports surviving PIDs and the kill error when termination fails', async () => {
  const { pidFile, cmd } = orphanScripts('refused');
  const res = await runShell(cmd, { timeoutMs: 3500, killPid: () => { throw new Error('EPERM refused'); }, denyTerminate: true });
  assert.equal(res.timedOut, true);
  await waitFor(() => existsSync(pidFile), 1000);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    assert.ok(res.survivors.some((s) => s.pid === pid && /EPERM refused|withheld/.test(s.error)), JSON.stringify(res.survivors));
  } finally {
    for (const s of res.survivors) try { process.kill(s.pid); } catch {} // the withheld job leaves its root running too
    try { process.kill(pid); } catch {}
  }
});

test('runShell with a failed process snapshot reports known descendants as unverified, not as cleaned up', { skip: process.platform === 'win32' && 'Windows contains descendants with a job object, no snapshot' }, async () => {
  const { pidFile, cmd } = orphanScripts('nosnap');
  const res = await runShell(cmd, { timeoutMs: 3500, killPid: () => { throw new Error('EPERM refused'); }, snapshotCommand: [process.execPath, ['-e', 'process.exit(1)']] });
  assert.equal(res.timedOut, true);
  await waitFor(() => existsSync(pidFile), 1000);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    assert.ok(res.survivors.some((s) => s.pid === pid), JSON.stringify(res.survivors));
    assert.ok(res.cleanupErrors.length > 0);
    assert.match(res.output, /cleanup incomplete/);
  } finally {
    try { process.kill(pid); } catch {}
  }
});

test('runShell with a timeout leaves background processes of a command that finished on its own running', async () => {
  const { pidFile, cmd } = orphanScripts('leftover');
  const quit = script('leftover-quit.mjs', `import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(join(tmp, 'leftover-gc.mjs'))}], { detached: true, stdio: 'ignore' }).unref();`);
  const res = await runShell(`"${process.execPath}" "${quit}"`, { timeoutMs: 20000 });
  assert.equal(res.code, 0);
  assert.ok(await waitFor(() => existsSync(pidFile), 3000), 'background process never started');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(alive(pid), 'background process was killed');
  } finally {
    try { process.kill(pid); } catch {}
  }
});

test('runShell timeout leaves an unrelated orphan alone', async () => {
  const pidFile = join(tmp, 'unrelated.pid');
  const sleeper = script('unrelated-sleeper.mjs', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`);
  const spawner = script('unrelated-spawner.mjs', `import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(sleeper)}], { detached: true, stdio: 'ignore' }).unref();`);
  await run(process.execPath, [spawner]); // the sleeper's parent exits at once: an orphan unrelated to the shell below
  assert.ok(await waitFor(() => existsSync(pidFile), 2000), 'sleeper never started');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    const hang = script('unrelated-hang.mjs', 'setTimeout(() => {}, 60000);');
    const res = await runShell(`"${process.execPath}" "${hang}"`, { timeoutMs: 800 });
    assert.equal(res.timedOut, true);
    assert.ok(alive(pid), 'unrelated orphan was killed');
  } finally {
    try { process.kill(pid); } catch {}
  }
});

test('run: failure message keeps the child stderr when the argument list is several KB', async () => {
  const args = ['-e', 'console.error("BOOM" + "-STDERR"); process.exit(2)', ...Array(1000).fill('argument')];
  await assert.rejects(run(process.execPath, args), (e) => e.message.includes('BOOM-STDERR'));
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
