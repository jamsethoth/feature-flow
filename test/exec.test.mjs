import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, runShell } from '../lib/exec.mjs';

const node = process.execPath;
const tmp = mkdtempSync(join(tmpdir(), 'ff-exec-'));
const script = (name, body) => {
  const p = join(tmp, name).replaceAll('\\', '/');
  writeFileSync(p, body);
  return p;
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (fn, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (fn()) return true;
  return fn();
};

test('run: child exiting early while large stdin is written rejects with its exit code', async () => {
  const input = 'x'.repeat(5 * 1024 * 1024);
  await assert.rejects(run(node, ['-e', 'process.exit(3)'], { input }), (e) => e.code === 3);
  const res = await run(node, ['-e', 'process.exit(3)'], { input, allowFail: true });
  assert.equal(res.code, 3);
});

test('run: multi-byte character split across chunks is read back exactly', async () => {
  const s = script('split.mjs', `process.stdout.write(Buffer.from([0xe2, 0x82]), () => setTimeout(() => process.stdout.write(Buffer.from([0xac, 0x0a])), 200));`);
  const res = await run(node, [s]);
  assert.equal(res.stdout, '€\n');
});

test('runShell: split multi-byte output is decoded exactly', async () => {
  const s = script('split2.mjs', `process.stderr.write(Buffer.from([0xe2, 0x82]), () => setTimeout(() => process.stderr.write(Buffer.from([0xac])), 200));`);
  const res = await runShell(`"${node}" "${s}"`);
  assert.equal(res.output, '€');
});

test('runShell: a command waiting for stdin EOF returns promptly', async () => {
  const s = script('stdin.mjs', `process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`);
  const t = Date.now();
  const res = await runShell(`"${node}" "${s}"`, { timeoutMs: 20000 });
  assert.ok(Date.now() - t < 5000, 'should not wait on stdin');
  assert.ok(!res.timedOut);
});

test('runShell: timeout returns within budget and is flagged', async () => {
  const s = script('sleep.mjs', `setTimeout(() => {}, 60000);`);
  const t = Date.now();
  const res = await runShell(`"${node}" "${s}"`, { timeoutMs: 500 });
  const took = Date.now() - t;
  assert.equal(res.timedOut, true);
  assert.ok(took < 500 + 2500, `took ${took}ms`);
});

// Parent spawns an intermediate that spawns a detached grandchild and exits, then the parent hangs.
const orphanScripts = (pidFile) => {
  const grandchild = script('grandchild.mjs', `setTimeout(() => {}, 60000);`);
  const middle = script('middle.mjs', `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const c = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore', detached: true });
writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
c.unref();`);
  return script('parent.mjs', `
import { spawn } from 'node:child_process';
spawn(process.execPath, [${JSON.stringify(middle)}], { stdio: 'ignore' });
setTimeout(() => {}, 60000);`);
};

test('runShell: timed-out command leaves no descendant, even with an exited intermediate parent', async () => {
  const pidFile = join(tmp, 'pid-a').replaceAll('\\', '/');
  const parent = orphanScripts(pidFile);
  const res = await runShell(`"${node}" "${parent}"`, { timeoutMs: 1500 });
  assert.equal(res.timedOut, true);
  assert.ok(existsSync(pidFile), 'grandchild should have started');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    if (res.survivors?.includes(pid)) {
      // Cleanup may be refused only when the tests themselves run in a restricted sandbox.
      assert.ok(process.env.FF_TEST_SANDBOXED, `descendant ${pid} survived in an unsandboxed process`);
    } else {
      assert.ok(await waitFor(() => !alive(pid)), `descendant ${pid} still running`);
    }
  } finally {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('runShell: kill failure is reported with surviving PIDs and the error', async () => {
  const pidFile = join(tmp, 'pid-b').replaceAll('\\', '/');
  const parent = orphanScripts(pidFile);
  const kill = () => { throw new Error('EPERM: operation not permitted'); };
  const res = await runShell(`"${node}" "${parent}"`, { timeoutMs: 1500, kill });
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined;
  try {
    assert.equal(res.timedOut, true);
    assert.ok(Array.isArray(res.survivors) && res.survivors.length > 0, 'survivors listed');
    assert.match(String(res.killError), /EPERM/);
  } finally {
    for (const p of [pid, ...(res.survivors ?? [])]) if (p) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
  }
});

test('run: error message keeps stderr when the argument list is several KB', async () => {
  const args = ['-e', 'console.error("boom-" + "marker"); process.exit(2)', ...Array(2000).fill('argument')];
  await assert.rejects(run(node, args), (e) => e.code === 2 && e.message.includes('boom-marker'));
});
