import { spawn } from 'node:child_process';

// shortcut: no shell, so Windows needs real .exe binaries on PATH (claude, codex, gh, git all ship them);
// npm .cmd shims would need cross-spawn.
export function run(cmd, args, { cwd, input, allowFail = false, inherit = false, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: timeoutMs });
    let stdout = '', stderr = '';
    if (!inherit) {
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.stdin.end(input ?? '');
    }
    child.on('error', reject);
    child.on('close', (code) => {
      const res = { code, stdout, stderr };
      if (code !== 0 && !allowFail) reject(Object.assign(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${stderr || stdout}`.slice(0, 4000)), res));
      else resolve(res);
    });
  });
}

// Run a repo-declared command line (e.g. "npm test") through the platform shell.
export function runShell(commandLine, { cwd, timeoutMs } = {}) {
  const [sh, flag] = process.platform === 'win32' ? ['cmd.exe', '/d /s /c'] : ['sh', '-c'];
  return new Promise((resolve, reject) => {
    const child = spawn(sh, process.platform === 'win32' ? [...flag.split(' '), `"${commandLine}"`] : [flag, commandLine],
      { cwd, windowsHide: true, windowsVerbatimArguments: process.platform === 'win32', timeout: timeoutMs });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output: out }));
  });
}
