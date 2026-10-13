import { spawn, spawnSync } from 'node:child_process';

// shortcut: no shell, so Windows needs real .exe binaries on PATH (claude, codex, gh, git all ship them);
// npm .cmd shims would need cross-spawn.
export function run(cmd, args, { cwd, input, allowFail = false, inherit = false, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: timeoutMs });
    let stdout = '', stderr = '';
    if (!inherit) {
      child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
      child.stdin.on('error', () => {}); // child exited before reading all input; the close event reports it
      child.stdin.end(input ?? '');
    }
    child.on('error', reject);
    child.on('close', (code) => {
      const res = { code, stdout, stderr };
      if (code !== 0 && !allowFail) reject(Object.assign(new Error(`${cmd} exited ${code}\n${stderr || stdout}\n${args.join(' ').slice(0, 300)}`.slice(0, 4000)), res));
      else resolve(res);
    });
  });
}

// Run a repo-declared command line (e.g. "npm test") through the platform shell.
export function runShell(commandLine, { cwd, timeoutMs, killer = killTree } = {}) {
  const [sh, flag] = process.platform === 'win32' ? ['cmd.exe', '/d /s /c'] : ['sh', '-c'];
  return new Promise((resolve, reject) => {
    const child = spawn(sh, process.platform === 'win32' ? [...flag.split(' '), `"${commandLine}"`] : [flag, commandLine],
      { cwd, windowsHide: true, windowsVerbatimArguments: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let out = '', timer, timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (out += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); if (!timedOut) resolve({ code, output: out }); });
    if (timeoutMs) timer = setTimeout(async () => {
      timedOut = true; // the kill makes 'close' fire before we resolve; the timeout result wins
      let t;
      const killError = await Promise.race([killer(child.pid), new Promise((r) => (t = setTimeout(r, KILL_BUDGET_MS, 'tree termination timed out')))]);
      clearTimeout(t);
      // survivors keep the pipes open: release them so ff can still exit
      if (killError) { child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
      resolve({ code: null, output: out, timedOut: true, ...(killError && { killError }) });
    }, timeoutMs);
  });
}

const KILL_BUDGET_MS = 1500;

// Kill pid and its descendants (the shell's children would otherwise outlive it and hold the pipes open).
// Resolves to an error message when the tree could not be terminated, else null.
export function killTree(pid) {
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); return Promise.resolve(null); } catch (e) { return Promise.resolve(e.message); }
  }
  return new Promise((resolve) => {
    let msg = '';
    const k = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout: 1000 });
    k.stdout.on('data', (d) => (msg += d));
    k.stderr.on('data', (d) => (msg += d));
    k.on('error', (e) => resolve(e.message));
    k.on('close', (code) => resolve(code === 0 ? null : `taskkill exited ${code}: ${msg.trim()}`));
  });
}
