import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
import { run } from './exec.mjs';
import { claudeToolkit, codexToolkit, withPrefixedTwins } from './toolkit.mjs';
import { claudePlanMetrics, codexTranscriptMetrics } from './planmetrics.mjs';

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)'];
// Agents edit files only; the orchestrator stages and commits.
const WRITE_TOOLS = ['Edit', 'Write'];

// Claude Code headless. Native Windows has no Claude sandbox, so permissions are an explicit allowlist.
// `resume` continues an earlier session (red -> green) so the agent keeps its context.
async function claude({ stage, persona, prompt, schema, cwd, write, commands, allowNetwork, toolkit, toolArgs = [], resume }) {
  // User settings are skipped (they may widen permissions or rewrite commands); the toolkit adds back
  // chosen hooks/plugins, and command-rewriting hooks get prefixed twins of every Bash rule.
  const tk = claudeToolkit(toolkit?.claude);
  const allowed = withPrefixedTwins([...READ_TOOLS, ...(write ? WRITE_TOOLS : []),
    ...Object.values(commands).flatMap((c) => [`Bash(${c})`, `Bash(${c}:*)`])], tk.prefixes);
  const denied = [...withPrefixedTwins(['Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(gh:*)'], tk.prefixes),
    ...(allowNetwork ? [] : ['WebFetch', 'WebSearch'])];
  const args = ['-p', ...(resume ? ['--resume', resume] : []), '--setting-sources', 'project,local', ...tk.args, ...toolArgs, '--model', stage.model, '--effort', stage.effort,
    '--append-system-prompt-file', persona.path,
    '--permission-mode', write ? 'acceptEdits' : 'default',
    '--allowedTools', ...allowed, '--disallowedTools', ...denied,
    '--output-format', 'json', '--json-schema', JSON.stringify(schema)];
  const { stdout } = await run('claude', args, { cwd, input: prompt });
  const res = JSON.parse(stdout);
  if (res.is_error || !res.structured_output) throw new Error(`claude ${stage.persona} failed: ${res.subtype} ${String(res.result).slice(0, 2000)}`);
  const u = res.usage ?? {};
  const cached = u.cache_read_input_tokens ?? 0;
  // costUsd is Claude's API-equivalent price for the call (subscription use is not billed per call).
  const usage = { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cached, cached, output: u.output_tokens ?? 0, costUsd: res.total_cost_usd ?? null };
  usage.peakContext = claudePlanMetrics(res.session_id)?.peakContext ?? null;
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

// Last cumulative usage seen per Codex thread in this process (red -> green -> test-fix resumes).
const threadTotals = new Map();

async function codexOnce({ stage, persona, prompt, schema, cwd, write, allowNetwork, toolkit, toolArgs = [], resume, prices }) {
  const dir = mkdtempSync(join(tmpdir(), 'ff-codex-'));
  try {
    writeFileSync(join(dir, 'schema.json'), JSON.stringify(schema));
    const tk = codexToolkit(toolkit?.codex);
    // --sandbox and -C belong to `exec`, so they go before `resume` (the form Codex's own tests use).
    // Resume recomputes the sandbox from the current call and never restores the original (openai/codex#40149).
    const shared = ['--sandbox', write ? 'workspace-write' : 'read-only', '-C', cwd];
    const opts = [...tk.args, ...toolArgs, '-m', stage.model, '-c', `model_reasoning_effort="${stage.effort}"`,
      ...(write && allowNetwork ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
      '--json', '--output-schema', join(dir, 'schema.json'), '-o', join(dir, 'out.json')];
    const args = resume ? ['exec', ...shared, 'resume', ...opts, resume, '-'] : ['exec', ...shared, ...opts, '-'];
    // codex has no system-prompt flag, so the persona leads the first prompt; a resumed session already has it.
    const input = resume ? prompt : `${tk.preamble}${persona.text}\n\n---\n\n${prompt}`;
    const { stdout } = await run('codex', args, { cwd, input });
    const session = stdout.match(/"type":"thread\.started","thread_id":"([^"]+)"/)?.[1] ?? resume;
    // Fail closed: a resume without sandbox_mode silently becomes workspace-write, so check what Codex recorded.
    const want = write ? 'workspace-write' : 'read-only';
    const rollout = rolloutText(session);
    const got = rollout ? lastSandbox(rollout) : 'unknown (rollout not found)';
    if (got !== want) throw new Error(`codex session ${session} ran with sandbox "${got}", expected "${want}"; output discarded`);
    // exec --json reports the thread's cumulative usage, so a resumed call is the difference from the last one.
    const total = codexUsage(stdout);
    const prev = threadTotals.get(session) ?? { input: 0, cached: 0, cacheWrite: 0, output: 0 };
    threadTotals.set(session, total);
    const usage = Object.fromEntries(['input', 'cached', 'cacheWrite', 'output'].map((k) => [k, total[k] - prev[k]]));
    usage.costUsd = apiCost(usage, prices?.[stage.model]);
    usage.quotaPct = rollout ? lastQuotaPct(rollout) : null;
    usage.peakContext = rollout ? codexTranscriptMetrics(rollout).peakContext : null;
    return { out: JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')), usage, session };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A session's rollout file (sessions/YYYY/MM/DD/rollout-*-<id>.jsonl), or null.
export function rolloutText(id, home = CODEX_HOME) {
  const root = join(home, 'sessions');
  const days = [0, 1].map((back) => { const d = new Date(Date.now() - back * 86_400_000); return [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((x) => String(x).padStart(2, '0')); });
  for (const [y, m, d] of days) {
    const dir = join(root, y, m, d);
    const file = existsSync(dir) && readdirSync(dir).find((f) => f.endsWith(`${id}.jsonl`));
    if (file) return readFileSync(join(dir, file), 'utf8');
  }
  return null;
}

// The sandbox mode of a session's latest turn.
export function recordedSandbox(id, home = CODEX_HOME) {
  const text = rolloutText(id, home);
  return text ? lastSandbox(text) : 'unknown (rollout not found)';
}

export const lastSandbox = (jsonl) => [...jsonl.matchAll(/"sandbox_policy":\{"type":"([^"]+)"/g)].at(-1)?.[1] ?? 'unknown';

// Plan quota used (% of the primary window, whole percent) as of the session's latest turn.
export function lastQuotaPct(jsonl) {
  const m = [...jsonl.matchAll(/"rate_limits":\{[^]*?"primary":\{"used_percent":([\d.]+)/g)].at(-1);
  return m ? Number(m[1]) : null;
}

// Cumulative thread usage from the last `turn.completed` in `codex exec --json` output.
// Reasoning tokens are part of output_tokens, so they are not added again.
export function codexUsage(jsonl) {
  const line = jsonl.split('\n').filter((l) => l.includes('"turn.completed"')).at(-1);
  const u = line ? JSON.parse(line).usage ?? {} : {};
  return { input: u.input_tokens ?? 0, cached: u.cached_input_tokens ?? 0, cacheWrite: u.cache_write_input_tokens ?? 0, output: u.output_tokens ?? 0 };
}

// API-equivalent USD from token counts and per-1M-token prices (input includes cached and cache-write tokens).
// shortcut: always uses the standard (<= long-context threshold) rates; per-request sizes aren't known here.
export function apiCost(u, p) {
  if (!p) return null;
  const fresh = u.input - u.cached - (u.cacheWrite ?? 0);
  return +((fresh * p.input + u.cached * p.cachedInput + (u.cacheWrite ?? 0) * (p.cacheWrite ?? p.input) + u.output * p.output) / 1e6).toFixed(4);
}

export const adapters = { claude, codex };

export function invoke(opts) {
  const fn = adapters[opts.stage.cli];
  if (!fn) throw new Error(`no adapter for cli "${opts.stage.cli}" (have: ${Object.keys(adapters).join(', ')})`);
  return fn(opts);
}

// Interactive launch for planning.
// Stop hook that warns (never blocks) once a request's context passes the budget.
export function contextWarningSettings(budget) {
  const q = (p) => `"${p.replace(/\\/g, '/')}"`;
  const hook = `${q(process.execPath)} ${q(fileURLToPath(new URL('../bin/context-hook.mjs', import.meta.url)))} ${budget}`;
  return JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: hook, timeout: 10 }] }] } });
}

// `sessionId` (Claude only) fixes the transcript name so ff can measure the session afterwards;
// `budget` adds the live context warning.
export function interactiveArgs(stage, persona, opening, sessionId, budget) {
  if (stage.cli === 'claude') return ['claude', [...(sessionId ? ['--session-id', sessionId] : []), ...(budget ? ['--settings', contextWarningSettings(budget)] : []),
    '--model', stage.model, '--effort', stage.effort, '--append-system-prompt-file', persona.path, opening]];
  if (stage.cli === 'codex') return ['codex', ['-m', stage.model, '-c', `model_reasoning_effort="${stage.effort}"`, `${persona.text}\n\n---\n\n${opening}`]];
  throw new Error(`no interactive launcher for cli "${stage.cli}"`);
}
