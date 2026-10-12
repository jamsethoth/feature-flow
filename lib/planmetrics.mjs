// Planning-stage metrics. `ff plan` wraps the interactive session, so it reads the session's own
// transcript afterwards; `ff publish` (usually run from inside that session) records the plan's shape.
// Both carry the same planId, which joins them to the epic.
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CLAUDE_HOME = join(homedir(), '.claude');
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const markerFile = (dir) => join(dir, 'current-plan.json');

export const writePlanMarker = (dir, marker) => writeFileSync(markerFile(dir), JSON.stringify(marker));
export const clearPlanMarker = (dir) => rmSync(markerFile(dir), { force: true });
// A marker older than a day is a leftover from an abandoned session, not the plan being published.
export function readPlanMarker(dir) {
  const f = markerFile(dir);
  if (!existsSync(f) || Date.now() - statSync(f).mtimeMs > 86_400_000) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

const lines = (text) => text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// Claude transcript: ~/.claude/projects/<encoded cwd>/<session-id>.jsonl. Assistant messages repeat once per
// content block, so usage is counted once per message id.
export function claudePlanMetrics(sessionId, budget, home = CLAUDE_HOME) {
  const projects = join(home, 'projects');
  const dir = existsSync(projects) && readdirSync(projects).find((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)));
  if (!dir) return null;
  return claudeTranscriptMetrics(readFileSync(join(projects, dir, `${sessionId}.jsonl`), 'utf8'), budget);
}

// peakContext: the largest single request (tokens the model read at once), which is what degrades
// reasoning - not the cumulative total. overBudgetRequests counts requests above `budget`.
export function claudeTranscriptMetrics(text, budget = Infinity) {
  const seen = new Set();
  const m = { input: 0, cached: 0, output: 0, userTurns: 0, questionsAsked: 0, peakContext: 0, overBudgetRequests: 0 };
  for (const e of lines(text)) {
    const msg = e.message;
    if (e.type === 'assistant' && msg?.usage && !seen.has(msg.id)) {
      seen.add(msg.id);
      const u = msg.usage;
      const context = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      m.peakContext = Math.max(m.peakContext, context);
      if (context > budget) m.overBudgetRequests++;
      m.input += context;
      m.cached += u.cache_read_input_tokens ?? 0;
      m.output += u.output_tokens ?? 0;
      m.questionsAsked += (msg.content ?? []).filter((c) => c.type === 'tool_use' && c.name === 'AskUserQuestion').length;
    }
    // A real user turn: typed text, not a tool result, meta message, or injected <task-notification>/<command-…> block.
    const text = typeof msg?.content === 'string' ? msg.content : msg?.content?.find?.((c) => c.type === 'text')?.text;
    if (e.type === 'user' && !e.isMeta && text != null && !/^\s*</.test(text)) m.userTurns++;
  }
  return m;
}

// Codex has no session-id flag: take the newest rollout started after `since` in this cwd.
export function codexPlanMetrics(cwd, since, budget, home = CODEX_HOME) {
  const root = join(home, 'sessions');
  const files = [];
  for (const back of [0, 1]) {
    const d = new Date(since - back * 86_400_000);
    const dir = join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    if (existsSync(dir)) files.push(...readdirSync(dir).filter((f) => f.startsWith('rollout-')).map((f) => join(dir, f)));
  }
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
  const match = files.filter((f) => statSync(f).mtimeMs >= since).map((f) => ({ f, text: readFileSync(f, 'utf8') }))
    .filter(({ text }) => { const meta = lines(text.slice(0, 20000)).find((e) => e.type === 'session_meta'); return meta && norm(meta.payload?.cwd ?? '') === norm(cwd); })
    .sort((a, b) => statSync(b.f).mtimeMs - statSync(a.f).mtimeMs)[0];
  return match ? codexTranscriptMetrics(match.text, budget) : null;
}

export function codexTranscriptMetrics(text, budget = Infinity) {
  const m = { input: 0, cached: 0, output: 0, userTurns: 0, questionsAsked: 0, quotaUsedPct: null, peakContext: 0, overBudgetRequests: 0 };
  let firstPct = null, lastPct = null;
  for (const e of lines(text)) {
    const p = e.payload ?? {};
    if (p.type === 'user_message') m.userTurns++;
    if (p.type === 'token_count') {
      const context = p.info?.last_token_usage?.input_tokens; // the latest request's input
      if (context != null) { m.peakContext = Math.max(m.peakContext, context); if (context > budget) m.overBudgetRequests++; }
      const t = p.info?.total_token_usage; // cumulative for the session
      // reasoning_output_tokens are already part of output_tokens
      if (t) { m.input = t.input_tokens ?? 0; m.cached = t.cached_input_tokens ?? 0; m.output = t.output_tokens ?? 0; }
      const pct = p.rate_limits?.primary?.used_percent;
      if (pct != null) { firstPct ??= pct; lastPct = pct; }
    }
  }
  if (firstPct != null) m.quotaUsedPct = +(lastPct - firstPct).toFixed(1);
  return m;
}

// Shape of a published plan: size, dependency structure and how specific its tickets are.
export function planShape(plan) {
  const t = plan.tickets ?? [];
  const byKey = new Map(t.map((x) => [x.key, x]));
  const depth = new Map();
  const chain = (x) => depth.get(x.key) ?? (depth.set(x.key, 1 + Math.max(0, ...(x.dependsOn ?? []).map((k) => chain(byKey.get(k))))), depth.get(x.key));
  const avg = (f) => (t.length ? +(t.reduce((a, x) => a + (x[f]?.length ?? 0), 0) / t.length).toFixed(1) : 0);
  return {
    tickets: t.length,
    dependencyEdges: t.reduce((a, x) => a + (x.dependsOn?.length ?? 0), 0),
    longestChain: t.length ? Math.max(...t.map(chain)) : 0,
    independentTickets: t.filter((x) => !x.dependsOn?.length).length,
    meanDodItems: avg('dod'),
    meanTestsFirst: avg('tests'),
  };
}
