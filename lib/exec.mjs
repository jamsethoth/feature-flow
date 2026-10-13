import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// shortcut: no shell, so Windows needs real .exe binaries on PATH (claude, codex, gh, git all ship them);
// npm .cmd shims would need cross-spawn.
export function run(cmd, args, { cwd, input, allowFail = false, inherit = false, timeoutMs, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: timeoutMs, env: env ? { ...process.env, ...env } : undefined });
    let stdout = '', stderr = '';
    if (!inherit) {
      child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
      child.stdin.on('error', () => {}); // child exited before reading all input: 'close' reports it
      child.stdin.end(input ?? '');
    }
    child.on('error', reject);
    child.on('close', (code) => {
      const res = { code, stdout, stderr };
      if (code !== 0 && !allowFail) reject(Object.assign(new Error(`${(stderr || stdout).trim()}\n${cmd} ${args.join(' ').slice(0, 300)} exited ${code}`.slice(0, 4000)), res));
      else resolve(res);
    });
  });
}

const CLEANUP_BUDGET_MS = 1500;
const POLL_GAP_MS = 250;

// Result of a helper process: { code, stdout, stderr }. Never rejects; code is null if it failed to start or outlived ms.
function quick(cmd, args, ms) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const done = (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); };
    const t = setTimeout(() => { p.kill(); done(null); }, ms);
    p.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    p.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    p.on('error', (e) => { stderr += e.message; done(null); });
    p.on('close', done);
  });
}

// { procs: [pid, ppid, startMs][], error } for every process; error is set when the snapshot is unusable.
async function snapshot(ms, override) {
  const [cmd, args] = override ?? ['ps', ['-e', '-o', 'pid=,ppid=,etimes=']]; // POSIX only; Windows uses a job object
  const now = Date.now();
  const r = await quick(cmd, args, ms);
  const procs = r.stdout.split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((x) => x.length === 3 && x.every(Number.isFinite))
    .map(([pid, ppid, v]) => [pid, ppid, now - v * 1000]);
  const error = r.code !== 0 || !procs.length ? `process snapshot failed (${r.code === null ? 'timed out or did not start' : 'exit ' + r.code}): ${r.stderr.trim()}`.trim() : undefined;
  return { procs, error };
}

const sameProc = (a, b) => a[0] === b[0] && Math.abs(a[2] - b[2]) < 2000; // ps start times are second-granular

// Descendants of rootPid seen so far, keyed by pid with their start time, so they can still be recognised
// after their parent exits and they are reparented. Only processes positively linked to rootPid are recorded.
function watch(rootPid) {
  const seen = new Map();
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const { procs, error } = await snapshot(CLEANUP_BUDGET_MS);
      if (!error) {
        const mine = new Set([rootPid, ...seen.keys()]);
        for (let grew = true; grew;) {
          grew = false;
          for (const p of procs) if (!mine.has(p[0]) && mine.has(p[1]) && p[0] !== process.pid) { mine.add(p[0]); seen.set(p[0], p); grew = true; }
        }
      }
      await new Promise((r) => setTimeout(r, POLL_GAP_MS));
    }
  })();
  return { seen, stop: () => { stopped = true; return loop; } };
}

// Kill the root and every descendant observed under it, within the budget. Never touches other processes.
// Returns survivors ({ pid, error }) and cleanupErrors (strings) for anything that could not be confirmed gone.
// shortcut: a descendant that was reparented before the first poll saw it is missed; upgrade to a job object
// (Windows) or cgroup (POSIX) for exact containment.
async function killTree(rootPid, seen, killPid, snapshotCommand) {
  const deadline = Date.now() + CLEANUP_BUDGET_MS;
  const cleanupErrors = [];
  if (process.platform === 'win32') { // fallback only: the job-object helper could not start, so orphans are not contained
    const r = await quick('taskkill', ['/T', '/F', '/PID', String(rootPid)], 700);
    cleanupErrors.push('job object unavailable, orphaned descendants are not contained' + (r.code === 0 ? '' : `; taskkill exit ${r.code}: ${(r.stderr || r.stdout).trim()}`));
    return { survivors: [], cleanupErrors };
  }
  try { process.kill(-rootPid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') cleanupErrors.push(`kill group ${rootPid}: ${e.message}`); }
  const survivors = [];
  const tryKill = (pid) => { try { killPid(pid); } catch (e) { if (e.code !== 'ESRCH') survivors.push({ pid, error: e.message }); } };
  const { procs, error } = await snapshot(Math.max(deadline - Date.now(), 100), snapshotCommand);
  if (error) {
    // cannot tell what is alive: attempt the root, and report every known descendant rather than claim success
    cleanupErrors.push(error);
    tryKill(rootPid);
    for (const pid of seen.keys()) if (!survivors.some((s) => s.pid === pid)) survivors.push({ pid, error: 'not verified gone: ' + error });
    return { survivors, cleanupErrors };
  }
  const alive = new Set([rootPid]);
  for (const p of procs) if (seen.has(p[0]) && sameProc(seen.get(p[0]), p)) alive.add(p[0]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of procs) if (!alive.has(pid) && alive.has(ppid) && pid !== process.pid) { alive.add(pid); grew = true; }
  }
  for (const pid of alive) if (procs.some((p) => p[0] === pid)) tryKill(pid);
  return { survivors, cleanupErrors };
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

const JOB_NOTE = /\n\u0001FFJOB (\w+) ?([^\n]*)\n/g;

// Windows: run the command inside a job object (lib/winjob.ps1) so a timeout kills every descendant, orphans
// included, with no polling. Resolves null if the helper could not start the command (caller falls back).
// deny is a test seam: the helper leaves the job running and reports its processes as survivors.
function runInJob(commandLine, { cwd, timeoutMs, deny, taskkillCommand, drainMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./winjob.ps1', import.meta.url))],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FF_CMD: `cmd.exe /d /s /c "${commandLine}"`, FF_CWD: cwd ?? '', FF_DENY: deny ? '1' : '' } });
    child.stdin.on('error', () => {}); // helper already gone
    let raw = '', timedOut = false, closed;
    const exited = new Promise((r) => (closed = r));
    let helperExited;
    const helperExit = new Promise((r) => (helperExited = r));
    child.on('exit', () => helperExited());
    for (const s of [child.stdout, child.stderr]) s.setEncoding('utf8').on('data', (d) => (raw += d));
    const timer = setTimeout(onTimeout, timeoutMs);
    const notes = () => [...raw.matchAll(JOB_NOTE)].map((m) => [m[1], m[2]]);
    const output = () => raw.replace(JOB_NOTE, '');
    // taskkill /T on a pid; { ok, error } with ok also true when the pid is already gone (exit 128)
    const treeKill = async (pid, override) => {
      const [c, a] = override ?? ['taskkill', ['/T', '/F', '/PID', String(pid)]];
      const r = await quick(c, a, 500);
      return r.code === 0 || r.code === 128 ? { ok: true } : { ok: false, error: `taskkill exit ${r.code}: ${(r.stderr || r.stdout).trim()}`.trim() };
    };
    async function onTimeout() {
      timedOut = true;
      const cleanupErrors = [], survivors = [];
      const n0 = () => notes();
      const rootPid = () => Number(n0().find(([k]) => k === 'started')?.[1]);
      // the helper only listens for the stop byte once the command runs
      let helperGone = true;
      if (raw.includes('\u0001FFJOB started')) {
        child.stdin.end('k'); // helper terminates the job and reports who is left
        // 'exit', not 'close': descendants that inherited the helper's pipes keep them open until they are killed
        helperGone = await Promise.race([helperExit.then(() => true), new Promise((r) => setTimeout(r, CLEANUP_BUDGET_MS, false))]);
        if (helperGone) await new Promise((r) => setTimeout(r, 150)); // let its last notes arrive
      } else helperGone = false; // still compiling: kill it outright (its job handle closing takes a just-started command with it)
      if (!helperGone) {
        const k = await treeKill(child.pid, taskkillCommand);
        if (!k.ok) {
          cleanupErrors.push(`job helper did not stop and could not be killed: ${k.error}`);
          survivors.push({ pid: child.pid, error: `helper not verified gone: ${k.error}` });
        } else if (raw.includes('\u0001FFJOB started')) cleanupErrors.push(`job helper did not answer within ${CLEANUP_BUDGET_MS} ms and was killed`);
      }
      const n = notes();
      let left = n.filter(([k]) => k === 'survivors').flatMap(([, v]) => v.split(',').filter(Boolean).map(Number));
      const noJob = n.filter(([k]) => k === 'nojob' || k === 'noassign');
      if (noJob.length) {
        // no job to terminate: take down what the process tree still links to; orphans cannot be found
        const root = rootPid();
        cleanupErrors.push(`job object unavailable (win32 error ${noJob[0][1]}): orphaned descendants are not contained`);
        if (root) {
          const k = await treeKill(root, taskkillCommand);
          if (k.ok) left = left.filter((p) => p !== root);
          else {
            cleanupErrors.push(`taskkill on command pid ${root} failed: ${k.error}`);
            if (!left.includes(root)) left.push(root);
          }
          // children the helper listed (natively, while the links existed): any still alive are survivors
          for (const [kk, v] of n) {
            if (kk === 'linkedfail') cleanupErrors.push(`could not list the command's descendants (win32 error ${v}); they are not verified gone`);
            if (kk === 'linked') for (const pid of v.split(',').filter(Boolean).map(Number)) if (isAlive(pid) && !left.includes(pid)) left.push(pid);
          }
        }
      }
      for (const [k, v] of n) {
        if (k === 'termfail') cleanupErrors.push(`TerminateJobObject failed (win32 error ${v})`);
        if (k === 'unknown') {
          cleanupErrors.push(`could not verify the job is empty (win32 error ${v})`);
          const root = rootPid();
          if (root && !left.includes(root)) left.push(root);
        }
      }
      for (const pid of left) survivors.push({ pid, error: deny ? 'termination withheld (test)' : n.some(([k]) => k === 'unknown') ? 'not verified gone' : 'still running after cleanup' });
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); // never let a stalled helper keep ff running
      const note = `\n[ff: timed out after ${timeoutMs} ms]` + survivors.map((x) => `\n[ff: could not kill pid ${x.pid}: ${x.error}]`).join('') + (cleanupErrors.length ? `\n[ff: cleanup incomplete: ${cleanupErrors.join('; ')}]` : '');
      resolve({ code: null, output: output() + note, timedOut: true, survivors, cleanupErrors });
    }
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => closed());
    // 'exit', not 'close': a background process the command leaves behind can hold ff's pipes open indefinitely
    child.on('exit', async (code) => {
      if (timedOut) return;
      clearTimeout(timer); // the command is done: a timeout during the drain below must not turn it into a failure
      await Promise.race([exited, new Promise((r) => setTimeout(r, drainMs))]); // let buffered output drain
      child.stdout.destroy(); child.stderr.destroy();
      const n = notes();
      const fail = n.find(([k]) => k === 'fail');
      if (fail) return resolve({ code: 127, output: `${output()}[ff: could not start command (win32 error ${fail[1]})]\n` });
      if (!n.some(([k]) => k === 'started')) return resolve(null);
      const leftovers = n.filter(([k]) => k === 'leftover').flatMap(([, v]) => v.split(',').filter(Boolean).map(Number));
      resolve(leftovers.length
        ? { code, output: `${output()}\n[ff: command finished but left running: pid ${leftovers.join(', ')}]`, leftovers }
        : { code, output: output() });
    });
  });
}

// Run a repo-declared command line (e.g. "npm test") through the platform shell.
// On timeout resolves with timedOut: true, survivors: [{ pid, error }] for processes that could not be killed or
// confirmed gone, and cleanupErrors for helper failures. A command that finishes but leaves processes behind is
// left alone and reported as leftovers: [pid] (Windows only; shortcut: POSIX does not report them). snapshotCommand and taskkillCommand ([cmd, args]) replace the process listing / the helper kill (tests).
export async function runShell(commandLine, { cwd, timeoutMs, killPid = (pid) => process.kill(pid, 'SIGKILL'), snapshotCommand, denyTerminate, taskkillCommand, drainMs = 300 } = {}) {
  const win = process.platform === 'win32';
  if (win && timeoutMs) {
    const res = await runInJob(commandLine, { cwd, timeoutMs, deny: denyTerminate, taskkillCommand, drainMs });
    if (res) return res;
  }
  const [sh, flag] = win ? ['cmd.exe', '/d /s /c'] : ['sh', '-c'];
  return new Promise((resolve, reject) => {
    const child = spawn(sh, win ? [...flag.split(' '), `"${commandLine}"`] : [flag, commandLine],
      { cwd, windowsHide: true, windowsVerbatimArguments: win, detached: !win, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    for (const s of [child.stdout, child.stderr]) s.setEncoding('utf8').on('data', (d) => (out += d));
    let timedOut = false;
    const watcher = timeoutMs && !win ? watch(child.pid) : null;
    const timer = timeoutMs && setTimeout(async () => {
      timedOut = true; // the kill makes 'close' fire first; the timeout result below wins
      watcher?.stop();
      const { survivors, cleanupErrors } = await killTree(child.pid, watcher?.seen, killPid, snapshotCommand);
      child.stdout.destroy(); child.stderr.destroy(); // orphans may still hold the pipes
      const note = `\n[ff: timed out after ${timeoutMs} ms]` + survivors.map((s) => `\n[ff: could not kill pid ${s.pid}: ${s.error}]`).join('') + (cleanupErrors.length ? `\n[ff: cleanup incomplete: ${cleanupErrors.join('; ')}]` : '');
      resolve({ code: null, output: out + note, timedOut: true, survivors, cleanupErrors });
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); watcher?.stop(); reject(e); });
    child.on('close', (code) => { if (timedOut) return; clearTimeout(timer); watcher?.stop(); resolve({ code, output: out }); });
  });
}
