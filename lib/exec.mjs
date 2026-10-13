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

// Output of a helper process, or '' if it fails or outlives ms. Never rejects.
function quick(cmd, args, ms) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const done = () => { clearTimeout(t); resolve(out); };
    const t = setTimeout(() => { p.kill(); done(); }, ms);
    p.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    p.on('error', done);
    p.on('close', done);
  });
}

// [pid, ppid, startMs] for every process.
async function snapshot(ms) {
  const [cmd, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Where-Object CreationDate | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }']]
    : ['ps', ['-e', '-o', 'pid=,ppid=,etimes=']];
  const now = Date.now();
  return (await quick(cmd, args, ms)).split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((r) => r.length === 3 && r.every(Number.isFinite))
    .map(([pid, ppid, v]) => [pid, ppid, process.platform === 'win32' ? v : now - v * 1000]);
}

// Kill what a timed-out shell left behind within the budget. Returns survivors the kill was refused for.
// shortcut: with no job object, a descendant whose parent already exited is found only as a parentless
// process created after the command started; upgrade to a job object for exact containment.
async function killTree(rootPid, startedAt, killPid) {
  const deadline = Date.now() + CLEANUP_BUDGET_MS;
  if (process.platform === 'win32') await quick('taskkill', ['/T', '/F', '/PID', String(rootPid)], 700);
  else try { process.kill(-rootPid, 'SIGKILL'); } catch {}
  const procs = await snapshot(Math.max(deadline - Date.now(), 100));
  const pids = new Set(procs.map((p) => p[0]));
  const roots = new Set([rootPid, ...procs.filter(([pid, ppid, t]) => !pids.has(ppid) && ppid !== process.pid && t >= startedAt - 1000 && pid !== process.pid).map((p) => p[0])]);
  const doomed = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of procs) if (pid !== process.pid && !doomed.has(pid) && (roots.has(pid) || doomed.has(ppid))) { doomed.add(pid); grew = true; }
  }
  const survivors = [];
  for (const pid of doomed) {
    try { killPid(pid); } catch (e) { if (e.code !== 'ESRCH') survivors.push({ pid, error: e.message }); }
  }
  return survivors;
}

// Run a repo-declared command line (e.g. "npm test") through the platform shell.
// On timeout resolves with timedOut: true and survivors: [{ pid, error }] for processes that could not be killed.
export function runShell(commandLine, { cwd, timeoutMs, killPid = (pid) => process.kill(pid, 'SIGKILL') } = {}) {
  const win = process.platform === 'win32';
  const [sh, flag] = win ? ['cmd.exe', '/d /s /c'] : ['sh', '-c'];
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(sh, win ? [...flag.split(' '), `"${commandLine}"`] : [flag, commandLine],
      { cwd, windowsHide: true, windowsVerbatimArguments: win, detached: !win, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    for (const s of [child.stdout, child.stderr]) s.setEncoding('utf8').on('data', (d) => (out += d));
    let timedOut = false;
    const timer = timeoutMs && setTimeout(async () => {
      timedOut = true; // the kill makes 'close' fire first; the timeout result below wins
      const survivors = await killTree(child.pid, startedAt, killPid);
      child.stdout.destroy(); child.stderr.destroy(); // orphans may still hold the pipes
      const note = `\n[ff: timed out after ${timeoutMs} ms]` + survivors.map((s) => `\n[ff: could not kill pid ${s.pid}: ${s.error}]`).join('');
      resolve({ code: null, output: out + note, timedOut: true, survivors });
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { if (timedOut) return; clearTimeout(timer); resolve({ code, output: out }); });
  });
}
