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

// Parent spawns a detached grandchild through an intermediate that exits at once, then outlives the timeout.
function orphanScripts(name) {
  const pidFile = join(tmp, `${name}.pid`);
  const grandchild = script(`${name}-gc.mjs`, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`);
  const middle = script(`${name}-mid.mjs`, `import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(grandchild)}], { detached: true, stdio: 'ignore' }).unref();`);
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

test('runShell: a command outliving timeoutMs returns within budget, flagged as timed out', async () => {
  const p = script('sleep.mjs', `setTimeout(() => {}, 60000);`);
  const t = Date.now();
  const res = await runShell(`"${process.execPath}" "${p}"`, { timeoutMs: 500 });
  assert.ok(Date.now() - t < 500 + 2500, `took ${Date.now() - t} ms`);
  assert.equal(res.timedOut, true);
});

test('runShell timeout kills descendants by PID, including one whose parent already exited (unless the sandbox forbids it)', async () => {
  const { pidFile, cmd } = orphanScripts('orphan');
  const res = await runShell(cmd, { timeoutMs: 1500 });
  assert.equal(res.timedOut, true);
  assert.ok(await waitFor(() => existsSync(pidFile), 1000), 'grandchild never started');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    const survivors = res.survivors ?? [];
    if (survivors.length) {
      // sandboxed: cleanup may be refused, but it must be reported rather than claimed
      assert.ok(survivors.some((s) => s.pid === pid));
    } else {
      assert.ok(await waitFor(() => !alive(pid), 2000), 'descendant still running');
    }
  } finally {
    try { process.kill(pid); } catch {}
  }
});

test('runShell reports surviving PIDs and the kill error when termination fails', async () => {
  const { pidFile, cmd } = orphanScripts('refused');
  const res = await runShell(cmd, { timeoutMs: 1500, killPid: () => { throw new Error('EPERM refused'); } });
  assert.equal(res.timedOut, true);
  await waitFor(() => existsSync(pidFile), 1000);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    assert.ok(res.survivors.some((s) => s.pid === pid && /EPERM refused/.test(s.error)), JSON.stringify(res.survivors));
  } finally {
    try { process.kill(pid); } catch {}
  }
});

test('run: failure message keeps the child stderr when the argument list is several KB', async () => {
  const args = ['-e', 'console.error("BOOM" + "-STDERR"); process.exit(2)', ...Array(1000).fill('argument')];
  await assert.rejects(run(process.execPath, args), (e) => e.message.includes('BOOM-STDERR'));
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
