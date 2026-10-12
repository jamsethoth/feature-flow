import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from './exec.mjs';
import { claudeToolkit, codexToolkit, withPrefixedTwins } from './toolkit.mjs';

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)'];
// Agents edit files only; the orchestrator stages and commits.
const WRITE_TOOLS = ['Edit', 'Write'];

// Claude Code headless. Native Windows has no Claude sandbox, so permissions are an explicit allowlist.
// `resume` continues an earlier session (red -> green) so the agent keeps its context.
async function claude({ stage, persona, prompt, schema, cwd, write, commands, allowNetwork, toolkit, resume }) {
  // User settings are skipped (they may widen permissions or rewrite commands); the toolkit adds back
  // chosen hooks/plugins, and command-rewriting hooks get prefixed twins of every Bash rule.
  const tk = claudeToolkit(toolkit?.claude);
  const allowed = withPrefixedTwins([...READ_TOOLS, ...(write ? WRITE_TOOLS : []),
    ...Object.values(commands).flatMap((c) => [`Bash(${c})`, `Bash(${c}:*)`])], tk.prefixes);
  const denied = [...withPrefixedTwins(['Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(gh:*)'], tk.prefixes),
    ...(allowNetwork ? [] : ['WebFetch', 'WebSearch'])];
  const args = ['-p', ...(resume ? ['--resume', resume] : []), '--setting-sources', 'project,local', ...tk.args, '--model', stage.model, '--effort', stage.effort,
    '--append-system-prompt-file', persona.path,
    '--permission-mode', write ? 'acceptEdits' : 'default',
    '--allowedTools', ...allowed, '--disallowedTools', ...denied,
    '--output-format', 'json', '--json-schema', JSON.stringify(schema)];
  const { stdout } = await run('claude', args, { cwd, input: prompt });
  const res = JSON.parse(stdout);
  if (res.is_error || !res.structured_output) throw new Error(`claude ${stage.persona} failed: ${res.subtype} ${String(res.result).slice(0, 2000)}`);
  const u = res.usage ?? {};
  const cached = u.cache_read_input_tokens ?? 0;
  const usage = { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cached, cached, output: u.output_tokens ?? 0 };
  return { out: res.structured_output, usage, session: res.session_id };
}

// Codex headless. Its sandbox keeps .git read-only and has no network unless allowNetwork.
async function codex(opts) {
  try {
    return await codexOnce(opts);
  } catch (err) {
    // MXC is unavailable on some devices/policies; the docs' next choice that avoids the elevated setup race.
    if (opts.toolkit?.codex?.windowsSandbox !== 'mxc' || !/mxc/i.test(err.message)) throw err;
    return codexOnce({ ...opts, toolkit: { ...opts.toolkit, codex: { ...opts.toolkit.codex, windowsSandbox: 'unelevated' } } });
  }
}

async function codexOnce({ stage, persona, prompt, schema, cwd, write, allowNetwork, toolkit, resume }) {
  const dir = mkdtempSync(join(tmpdir(), 'ff-codex-'));
  try {
    writeFileSync(join(dir, 'schema.json'), JSON.stringify(schema));
    const tk = codexToolkit(toolkit?.codex);
    // `exec resume` takes no --sandbox/-C, so the sandbox is set through config for both forms.
    const opts = [...tk.args, '-m', stage.model, '-c', `model_reasoning_effort="${stage.effort}"`,
      '-c', `sandbox_mode="${write ? 'workspace-write' : 'read-only'}"`,
      ...(write && allowNetwork ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
      '--json', '--output-schema', join(dir, 'schema.json'), '-o', join(dir, 'out.json')];
    const args = resume ? ['exec', 'resume', ...opts, resume, '-'] : ['exec', ...opts, '-C', cwd, '-'];
    // codex has no system-prompt flag, so the persona leads the first prompt; a resumed session already has it.
    const input = resume ? prompt : `${tk.preamble}${persona.text}\n\n---\n\n${prompt}`;
    const { stdout } = await run('codex', args, { cwd, input });
    const session = stdout.match(/"type":"thread\.started","thread_id":"([^"]+)"/)?.[1] ?? resume;
    return { out: JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')), usage: codexUsage(stdout), session };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Sum the usage of every `turn.completed` event in `codex exec --json` output.
export function codexUsage(jsonl) {
  const usage = { input: 0, cached: 0, output: 0 };
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"turn.completed"')) continue;
    const u = JSON.parse(line).usage ?? {};
    usage.input += u.input_tokens ?? 0;
    usage.cached += u.cached_input_tokens ?? 0;
    usage.output += (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
  }
  return usage;
}

export const adapters = { claude, codex };

export function invoke(opts) {
  const fn = adapters[opts.stage.cli];
  if (!fn) throw new Error(`no adapter for cli "${opts.stage.cli}" (have: ${Object.keys(adapters).join(', ')})`);
  return fn(opts);
}

// Interactive launch for planning.
export function interactiveArgs(stage, persona, opening) {
  if (stage.cli === 'claude') return ['claude', ['--model', stage.model, '--effort', stage.effort, '--append-system-prompt-file', persona.path, opening]];
  if (stage.cli === 'codex') return ['codex', ['-m', stage.model, '-c', `model_reasoning_effort="${stage.effort}"`, `${persona.text}\n\n---\n\n${opening}`]];
  throw new Error(`no interactive launcher for cli "${stage.cli}"`);
}
