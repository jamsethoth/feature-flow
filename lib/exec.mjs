import { spawn } from 'node:child_process';

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
  const [cmd, args] = override ?? (process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Where-Object CreationDate | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }']]
    : ['ps', ['-e', '-o', 'pid=,ppid=,etimes=']]);
  const now = Date.now();
  const r = await quick(cmd, args, ms);
  const procs = r.stdout.split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((x) => x.length === 3 && x.every(Number.isFinite))
    .map(([pid, ppid, v]) => [pid, ppid, process.platform === 'win32' ? v : now - v * 1000]);
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
  if (process.platform === 'win32') {
    const r = await quick('taskkill', ['/T', '/F', '/PID', String(rootPid)], 700);
    if (r.code !== 0) cleanupErrors.push(`taskkill exit ${r.code}: ${(r.stderr || r.stdout).trim()}`);
  } else try { process.kill(-rootPid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') cleanupErrors.push(`kill group ${rootPid}: ${e.message}`); }
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

// Run a repo-declared command line (e.g. "npm test") through the platform shell.
// On timeout resolves with timedOut: true, survivors: [{ pid, error }] for processes that could not be killed or
// confirmed gone, and cleanupErrors for helper failures. snapshotCommand ([cmd, args]) replaces the listing used after the kill (tests).
export function runShell(commandLine, { cwd, timeoutMs, killPid = (pid) => process.kill(pid, 'SIGKILL'), snapshotCommand } = {}) {
  const win = process.platform === 'win32';
  const [sh, flag] = win ? ['cmd.exe', '/d /s /c'] : ['sh', '-c'];
  return new Promise((resolve, reject) => {
    const child = spawn(sh, win ? [...flag.split(' '), `"${commandLine}"`] : [flag, commandLine],
      { cwd, windowsHide: true, windowsVerbatimArguments: win, detached: !win, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    for (const s of [child.stdout, child.stderr]) s.setEncoding('utf8').on('data', (d) => (out += d));
    let timedOut = false;
    const watcher = timeoutMs ? watch(child.pid) : null;
    const timer = timeoutMs && setTimeout(async () => {
      timedOut = true; // the kill makes 'close' fire first; the timeout result below wins
      watcher.stop();
      const { survivors, cleanupErrors } = await killTree(child.pid, watcher.seen, killPid, snapshotCommand);
      child.stdout.destroy(); child.stderr.destroy(); // orphans may still hold the pipes
      const note = `\n[ff: timed out after ${timeoutMs} ms]` + survivors.map((s) => `\n[ff: could not kill pid ${s.pid}: ${s.error}]`).join('') + (cleanupErrors.length ? `\n[ff: cleanup incomplete: ${cleanupErrors.join('; ')}]` : '');
      resolve({ code: null, output: out + note, timedOut: true, survivors, cleanupErrors });
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); watcher?.stop(); reject(e); });
    child.on('close', (code) => { if (timedOut) return; clearTimeout(timer); watcher?.stop(); resolve({ code, output: out }); });
  });
}
