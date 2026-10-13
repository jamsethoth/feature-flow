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
export function runShell(commandLine, { cwd, timeoutMs } = {}) {
  const [sh, flag] = process.platform === 'win32' ? ['cmd.exe', '/d /s /c'] : ['sh', '-c'];
  return new Promise((resolve, reject) => {
    const child = spawn(sh, process.platform === 'win32' ? [...flag.split(' '), `"${commandLine}"`] : [flag, commandLine],
      { cwd, windowsHide: true, windowsVerbatimArguments: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let out = '', timer;
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (out += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output: out }); });
    if (timeoutMs) timer = setTimeout(() => {
      // kill the whole tree: the shell's children would otherwise outlive it and hold the pipes open
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      else try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      resolve({ code: null, output: out, timedOut: true });
    }, timeoutMs);
  });
}
