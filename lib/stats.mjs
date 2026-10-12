// Aggregate events.jsonl into efficacy / efficiency metrics, and refresh PR outcomes from GitHub.
import { run } from './exec.mjs';

const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) ?? 0), 0);
const mean = (xs, f) => (xs.length ? sum(xs, f) / xs.length : null);
const pct = (num, den) => (den ? `${Math.round((100 * num) / den)}%` : '-');
const key = (e) => `${e.run}#${e.ticket}`;

// One record per ticket attempt (run + ticket): what happened, what it cost, how it ended up.
export function ticketAttempts(events) {
  const byKey = new Map();
  const get = (e) => byKey.get(key(e)) ?? byKey.set(key(e), { run: e.run, epic: e.epic, label: e.label, ticket: e.ticket, calls: [], reviews: [], gates: [], redFailed: 0, blocked: 0 }).get(key(e));
  for (const e of events) {
    if (e.ticket == null) continue;
    const t = get(e);
    if (e.type === 'stage_call') t.calls.push(e);
    else if (e.type === 'review') t.reviews.push(e);
    else if (e.type === 'gate') t.gates.push(e);
    else if (e.type === 'red_failed') t.redFailed++;
    else if (e.type === 'blocked') t.blocked++;
    else if (e.type === 'ticket_end') Object.assign(t, { state: e.state, rounds: e.rounds, durationMs: e.durationMs, pr: e.pr, diff: e.diff, endedAt: e.ts, error: e.error });
  }
  const outcomes = new Map(events.filter((e) => e.type === 'pr_outcome').map((e) => [e.pr, e])); // latest wins
  return [...byKey.values()].filter((t) => t.state).map((t) => ({ ...t, outcome: t.pr ? outcomes.get(t.pr) : undefined }));
}

export function summarize(events, { epic, label } = {}) {
  // PR outcomes are recorded later without a label; they join attempts by PR number.
  const ev = events.filter((e) => e.type === 'pr_outcome' || ((epic == null || e.epic === epic) && (label == null || e.label === label)));
  const ts = ticketAttempts(ev);
  const reviewed = ts.filter((t) => t.reviews.length);
  const calls = ts.flatMap((t) => t.calls);
  const reviews = ts.flatMap((t) => t.reviews);
  const phaseCount = (p) => calls.filter((c) => c.phase === p).length;
  const merged = ts.filter((t) => t.outcome?.state === 'MERGED');

  // Planning: published plans in scope, joined to their interactive session by planId.
  const sessions = new Map(events.filter((e) => e.type === 'plan_session').map((e) => [e.planId, e]));
  const plans = ev.filter((e) => e.type === 'plan_published' && (epic == null || e.epic === epic)).map((p) => ({ ...p, session: sessions.get(p.planId) }));
  const withSession = plans.filter((p) => p.session?.input != null);
  const planning = plans.length ? {
    plans: plans.length,
    measuredSessions: withSession.length,
    meanMinutes: withSession.length ? ((mean(withSession, (p) => p.session.durationMs) ?? 0) / 60000).toFixed(1) : '-',
    meanUserTurns: mean(withSession, (p) => p.session.userTurns)?.toFixed(1) ?? '-',
    meanTokens: withSession.length ? { input: Math.round(mean(withSession, (p) => p.session.input)), uncached: Math.round(mean(withSession, (p) => p.session.input - p.session.cached)), output: Math.round(mean(withSession, (p) => p.session.output)) } : null,
    meanTickets: mean(plans, (p) => p.tickets)?.toFixed(1),
    meanDependencyEdges: mean(plans, (p) => p.dependencyEdges)?.toFixed(1),
    meanLongestChain: mean(plans, (p) => p.longestChain)?.toFixed(1),
    meanDodItems: mean(plans, (p) => p.meanDodItems)?.toFixed(1),
  } : null;

  const byStage = new Map();
  for (const c of calls) {
    const k = `${c.stage} ${c.cli}/${c.model}/${c.effort}`;
    byStage.set(k, [...(byStage.get(k) ?? []), c]);
  }
  return {
    tickets: ts.length,
    planning,
    efficacy: {
      readyForQa: pct(ts.filter((t) => t.state === 'ready-for-qa').length, ts.length),
      needsHuman: pct(ts.filter((t) => t.state === 'needs-human').length, ts.length),
      firstRoundPass: pct(reviewed.filter((t) => t.reviews[0].verdict === 'PASS').length, reviewed.length),
      meanRounds: mean(ts, (t) => t.rounds)?.toFixed(2) ?? '-',
      blockedTickets: ts.filter((t) => t.blocked).length,
      escalations: calls.filter((c) => c.stage === 'escalate').length,
      findings: { blocker: sum(reviews, (r) => r.blocker), major: sum(reviews, (r) => r.major), minor: sum(reviews, (r) => r.minor) },
      dodMissedInReview: reviews.filter((r) => r.dodMet === false).length,
      prOutcomes: {
        checked: ts.filter((t) => t.outcome).length,
        merged: merged.length,
        mergedWithoutHumanCommits: merged.filter((t) => t.outcome.humanCommits === 0).length,
        closedUnmerged: ts.filter((t) => t.outcome?.state === 'CLOSED').length,
        meanHoursReadyToMerge: mean(merged, (t) => t.outcome.hoursToMerge)?.toFixed(1) ?? '-',
      },
    },
    efficiency: {
      meanTicketMinutes: ((mean(ts, (t) => t.durationMs) ?? 0) / 60000).toFixed(1),
      meanTokensPerTicket: {
        input: Math.round(mean(ts, (t) => sum(t.calls, (c) => c.input)) ?? 0),
        uncached: Math.round(mean(ts, (t) => sum(t.calls, (c) => c.input - c.cached)) ?? 0),
        output: Math.round(mean(ts, (t) => sum(t.calls, (c) => c.output)) ?? 0),
      },
      claudeApiEquivalentUsd: sum(calls, (c) => c.costUsd).toFixed(2),
      retries: { stillGreen: phaseCount('still-green'), testFix: phaseCount('test-fix'), redFailed: sum(ts, (t) => t.redFailed) },
      meanDiff: ts.some((t) => t.diff) ? {
        files: mean(ts, (t) => t.diff?.files)?.toFixed(1),
        insertions: Math.round(mean(ts, (t) => t.diff?.insertions) ?? 0),
        testShareOfInsertions: pct(sum(ts, (t) => t.diff?.testInsertions), sum(ts, (t) => t.diff?.insertions)),
      } : null,
      byStage: Object.fromEntries([...byStage].map(([k, cs]) => [k, {
        calls: cs.length,
        meanSeconds: Math.round((mean(cs, (c) => c.durationMs) ?? 0) / 1000),
        meanInput: Math.round(mean(cs, (c) => c.input) ?? 0),
        meanUncached: Math.round(mean(cs, (c) => c.input - c.cached) ?? 0),
        meanOutput: Math.round(mean(cs, (c) => c.output) ?? 0),
      }])),
    },
  };
}

// Ask GitHub what became of each PR ff handed over; append pr_outcome events for stats.
export async function refreshOutcomes(events, cwd, ev) {
  const final = new Set(events.filter((e) => e.type === 'pr_outcome' && e.state !== 'OPEN').map((e) => e.pr));
  const handed = ticketAttempts(events).filter((t) => t.pr && !final.has(t.pr));
  const seen = new Set();
  for (const t of handed) {
    if (seen.has(t.pr)) continue;
    seen.add(t.pr);
    const { stdout } = await run('gh', ['pr', 'view', String(t.pr), '--json', 'state,mergedAt,closedAt,commits'], { cwd, allowFail: true });
    if (!stdout) continue;
    const pr = JSON.parse(stdout);
    // ff's own commits carry a Feature-Flow-Stage trailer; anything else on the branch came from a human.
    const humanCommits = pr.commits.filter((c) => !/Feature-Flow-Stage:/.test(`${c.messageHeadline}\n${c.messageBody}`)).length;
    const hoursToMerge = pr.mergedAt && t.endedAt ? (Date.parse(pr.mergedAt) - Date.parse(t.endedAt)) / 3_600_000 : null;
    ev('pr_outcome', { pr: t.pr, ticket: t.ticket, epic: t.epic, state: pr.state, mergedAt: pr.mergedAt, closedAt: pr.closedAt, humanCommits, hoursToMerge });
  }
  return seen.size;
}

export function renderSummary(title, s) {
  const e = s.efficacy, f = s.efficiency;
  const p = s.planning;
  const lines = [
    `== ${title}: ${s.tickets} ticket attempt(s)`,
    ...(p ? [`planning   ${p.plans} plan(s), ${p.measuredSessions} measured | ${p.meanMinutes} min | ${p.meanUserTurns} user turns | tokens ${p.meanTokens ? `in ${p.meanTokens.input} (uncached ${p.meanTokens.uncached}) out ${p.meanTokens.output}` : '-'}`,
      `           ${p.meanTickets} tickets | ${p.meanDependencyEdges} dependency links | longest chain ${p.meanLongestChain} | ${p.meanDodItems} DoD items/ticket`] : []),
    `efficacy   ready-for-qa ${e.readyForQa} | needs-human ${e.needsHuman} | first-round PASS ${e.firstRoundPass} | mean rounds ${e.meanRounds} | blocked ${e.blockedTickets} | escalations ${e.escalations}`,
    `           review findings blocker ${e.findings.blocker} / major ${e.findings.major} / minor ${e.findings.minor} | DoD missed ${e.dodMissedInReview}`,
    `           PRs checked ${e.prOutcomes.checked} | merged ${e.prOutcomes.merged} (no human commits ${e.prOutcomes.mergedWithoutHumanCommits}) | closed unmerged ${e.prOutcomes.closedUnmerged} | mean h ready->merge ${e.prOutcomes.meanHoursReadyToMerge}`,
    `efficiency ${f.meanTicketMinutes} min/ticket | tokens/ticket in ${f.meanTokensPerTicket.input} (uncached ${f.meanTokensPerTicket.uncached}) out ${f.meanTokensPerTicket.output} | Claude API-equivalent $${f.claudeApiEquivalentUsd}`,
    `           retries still-green ${f.retries.stillGreen} | test-fix ${f.retries.testFix} | red failed ${f.retries.redFailed}${f.meanDiff ? ` | diff ${f.meanDiff.files} files +${f.meanDiff.insertions} (tests ${f.meanDiff.testShareOfInsertions})` : ''}`,
    ...Object.entries(f.byStage).map(([k, v]) => `           ${k.padEnd(40)} ${v.calls} calls, ${v.meanSeconds}s, in ${v.meanInput} (uncached ${v.meanUncached}) out ${v.meanOutput}`),
  ];
  return lines.join('\n');
}
