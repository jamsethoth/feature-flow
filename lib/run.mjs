import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadPersona, loadCommands, loadSkillText, budgetFor } from './config.mjs';
import { invoke } from './adapters.mjs';
import { skillsBlock } from './toolkit.mjs';
import { run, runShell } from './exec.mjs';
import * as gh from './github.mjs';
import * as git from './git.mjs';
import { RED_SCHEMA, IMPLEMENT_SCHEMA, REVIEW_SCHEMA, redPrompt, greenPrompt, fixPrompt, reviewPrompt, testFixPrompt, stillGreenPrompt, styleBlock } from './stages.mjs';
import { prBody, reviewComment } from './render.mjs';
import { eventLog, severityCounts, diffStats } from './events.mjs';

// Run up to `limit` tasks at once.
export async function pool(items, limit, fn) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

// Which stage runs a given round: 0 = first attempt, 1..maxReviewRounds = fixes, then one optional escalation.
export function stageForRound(round, cfg) {
  if (round <= cfg.maxReviewRounds) return 'implement';
  if (cfg.escalationEnabled && round === cfg.maxReviewRounds + 1) return 'escalate';
  return null;
}

// The Codex desktop app's node_repl.exe processes lock a file the Codex CLI sandbox re-ACLs on setup,
// which makes every sandboxed command fail with "setup refresh had errors".
export async function codexDesktopLock() {
  if (process.platform !== 'win32') return false;
  const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq node_repl.exe', '/FO', 'CSV', '/NH'], { allowFail: true });
  return /node_repl\.exe/i.test(stdout);
}
// Only the elevated sandbox's setup step re-ACLs node_repl.exe; mxc/unelevated were clean with it running.
export const codexSandboxRaces = (cfg) => !['mxc', 'unelevated'].includes(cfg.toolkit?.codex?.windowsSandbox);
export const CODEX_LOCK_WARNING = 'node_repl.exe is running (Codex desktop app or a leftover Codex process): Codex CLI sandboxed commands will fail with "setup refresh had errors". Close the Codex app / end leftover Codex processes before running Codex stages.';

export async function cleanupMerged(repo, cfg, log, { findPr = gh.findPr } = {}) {
  for (const wt of await git.listWorktrees(repo.mainRoot)) {
    if (!wt.branch.startsWith('ticket/')) continue;
    const pr = await findPr(wt.branch, repo.mainRoot);
    if (pr?.state === 'MERGED') {
      if (await git.isDirty(wt.path, true) || await git.hasUnpushed(wt.path)) {
        log(`kept merged ${wt.branch}: worktree has uncommitted changes or unpushed commits`);
        continue;
      }
      await git.removeWorktree(repo.mainRoot, wt.path, wt.branch);
      log(`cleaned up merged ${wt.branch}`);
    }
  }
}

// Stage settings recorded with every run so stats can be grouped by configuration.
const configSummary = (cfg) => ({
  stages: Object.fromEntries(['implement', 'review', 'escalate'].map((s) => [s, `${cfg[s].cli}/${cfg[s].model}/${cfg[s].effort}/${cfg[s].persona}`])),
  escalationEnabled: cfg.escalationEnabled, maxReviewRounds: cfg.maxReviewRounds, style: cfg.style?.internal,
  claudeToolkit: cfg.toolkit?.claude, codexInject: cfg.toolkit?.codex?.inject,
});

// A failed label update must not vanish: it leaves the ticket looking idle or stuck on GitHub.
export async function setLabels(ghApi, n, change, cwd, { log, ev }) {
  try {
    await ghApi.editLabels(n, change, cwd);
    return true;
  } catch (err) {
    const error = err.message.split('\n')[0];
    log(`#${n} ERROR label update ${JSON.stringify(change)} failed: ${error}`);
    ev('label_failed', { ticket: n, change, error });
    return false;
  }
}

export const runExitCode = (results) => results.some((r) => r.labelFailed) ? 1 : results.some((r) => r.state === 'needs-human') ? 2 : 0;

export function epicProblem(tickets, ready) {
  if (!tickets.length) return 'epic has no sub-issues; nothing to run (publish a plan first)';
  if (!ready.length) return 'nothing ready: every sub-issue is closed, blocked or already in progress / ready-for-qa / needs-human';
  return null;
}

export function validateRetryStuck(numbers, tickets) {
  for (const n of numbers) {
    const t = tickets.find((x) => x.number === n);
    if (!t) throw new Error(`--retry-stuck: #${n} is not a sub-issue of this epic`);
    if (!gh.labelNames(t).includes('in-progress')) throw new Error(`--retry-stuck: #${n} is not labelled in-progress`);
  }
}

// Discards a stopped run's partial attempt so the ticket starts again from a fresh red phase.
export async function resetTicket(n, { repo, gh: ghApi = gh, git: gitApi = git, log }) {
  const wt = (await gitApi.listWorktrees(repo.mainRoot)).find((w) => w.branch.startsWith(`ticket/${n}-`));
  if (wt) {
    const pr = await ghApi.findPr(wt.branch, repo.mainRoot);
    if (pr?.state === 'OPEN') await ghApi.closePr(pr.number, repo.mainRoot);
    await gitApi.removeWorktree(repo.mainRoot, wt.path, wt.branch);
    await gitApi.deleteRemoteBranch(repo.mainRoot, wt.branch);
  }
  await ghApi.editLabels(n, { remove: ['in-progress'] }, repo.mainRoot);
  log(`#${n} reset for retry${wt ? ` (removed ${wt.branch})` : ''}`);
}

export const stuckTickets = (tickets, hours, now = Date.now()) =>
  tickets.filter((t) => gh.labelNames(t).includes('in-progress') && t.inProgressSince && now - Date.parse(t.inProgressSince) > hours * 3_600_000);

export const stuckMessage = (epic, stuck) => stuck.length
  ? `possibly stuck (in-progress too long): ${stuck.map((t) => `#${t.number}`).join(', ')}; if their run was stopped, re-run with: ff run ${epic} --retry-stuck ${stuck.map((t) => t.number).join(',')}`
  : null;

export async function safeDiffStats(gitApi, cwd, base, log) {
  try {
    return diffStats(await gitApi.numstat(cwd, base));
  } catch (err) {
    log(`WARNING diff stats unavailable: ${err.message.split('\n')[0]}`);
    return null;
  }
}

export async function runEpic(epicNumber, { cwd = process.cwd(), print = console.log, label = null, retryStuck = [] } = {}) {
  const repo = await git.repoInfo(cwd);
  const cfg = loadConfig(repo.mainRoot);
  const commands = loadCommands(repo.mainRoot);
  if (!commands.test) throw new Error('AGENTS.md has no "## Commands" entry for test (run `ff init`)');
  const logDir = join(repo.gitCommonDir, 'feature-flow');
  mkdirSync(logDir, { recursive: true });
  const runStart = Date.now();
  const ev = eventLog(logDir, { run: new Date(runStart).toISOString(), epic: epicNumber, label });
  const log = (msg) => {
    const line = `${new Date().toISOString()} ${msg}`;
    appendFileSync(join(logDir, `${epicNumber}.log`), line + '\n');
    print(line);
  };

  if (['implement', 'review', 'escalate'].some((s) => cfg[s].cli === 'codex') && codexSandboxRaces(cfg) && await codexDesktopLock()) log(`WARNING ${CODEX_LOCK_WARNING}`);
  await cleanupMerged(repo, cfg, log);
  const epic = await gh.viewIssue(epicNumber, repo.mainRoot);
  if (cfg.planApproval && !gh.labelNames(epic).includes('plan-approved')) {
    log(`epic #${epicNumber} lacks the plan-approved label; nothing run`);
    throw new Error(`epic #${epicNumber} lacks the plan-approved label; nothing run (ff approve ${epicNumber})`);
  }
  const subs = epic.subIssues?.nodes ?? epic.subIssues ?? [];
  let tickets = await Promise.all(subs.map((s) => gh.viewIssue(s.number, repo.mainRoot)));
  await Promise.all(tickets.filter((t) => gh.labelNames(t).includes('in-progress')).map(async (t) => {
    t.inProgressSince = await gh.inProgressSince(t.number, repo.mainRoot).catch(() => null);
  }));
  const stuckMsg = stuckMessage(epicNumber, stuckTickets(tickets, cfg.stuckAfterHours ?? 6));
  if (stuckMsg) log(stuckMsg);
  if (retryStuck.length) {
    validateRetryStuck(retryStuck, tickets);
    for (const n of retryStuck) await resetTicket(n, { repo, log });
    tickets = await Promise.all(subs.map((s) => gh.viewIssue(s.number, repo.mainRoot)));
  }
  const ready = tickets.filter(gh.isReady);
  const problem = epicProblem(tickets, ready);
  if (problem) { log(problem); throw new Error(problem); }
  const labelFailed = new Set();
  log(`epic #${epicNumber}: ${tickets.length} tickets, ${ready.length} ready`);
  ev('run_start', { config: configSummary(cfg), tickets: tickets.length, ready: ready.length });

  const results = await pool(ready, cfg.maxParallel, (t) => {
    const started = Date.now();
    return runTicket(t, { repo, cfg, commands, log, ev, labelFailed }).catch(async (err) => {
      log(`#${t.number} ERROR ${err.message}`);
      if (!await setLabels(gh, t.number, { add: ['needs-human'], remove: ['in-progress'] }, repo.mainRoot, { log, ev })) labelFailed.add(t.number);
      ev('ticket_end', { ticket: t.number, state: 'needs-human', error: err.message.split('\n')[0], durationMs: Date.now() - started });
      return { ticket: t.number, state: 'needs-human', error: err.message.split('\n')[0] };
    });
  });
  const skipped = tickets.filter((t) => !ready.includes(t)).map((t) => ({ ticket: t.number, state: t.state === 'CLOSED' ? 'closed' : (gh.labelNames(t).find((l) => gh.BUSY_LABELS.includes(l)) ?? 'blocked') }));
  writeFileSync(join(logDir, `${epicNumber}.usage.json`), JSON.stringify({ style: cfg.style, results }, null, 2));
  ev('run_end', { durationMs: Date.now() - runStart, states: Object.fromEntries(results.map((r) => [r.ticket, r.state])) });
  return [...results.map((r) => labelFailed.has(r.ticket) ? { ...r, labelFailed: true } : r), ...skipped];
}

async function runTicket(issue, { repo, cfg, commands, log, ev: runEv, labelFailed }) {
  const n = issue.number;
  const started = Date.now();
  const ev = (type, data = {}) => runEv(type, { ticket: n, ...data });
  const labels = async (change) => { if (!await setLabels(gh, n, change, repo.mainRoot, { log, ev })) labelFailed.add(n); };
  const { path: cwd, branch } = await git.ensureWorktree({ mainRoot: repo.mainRoot, path: git.worktreePath(cfg.worktreeRoot, repo.name, n), branch: `ticket/${n}-${git.slugify(issue.title)}`, base: cfg.baseBranch });
  const ticket = { ...issue, branch };
  await labels({ add: ['in-progress'] });
  log(`#${n} started in ${cwd}`);
  ev('ticket_start', { title: issue.title });

  const base = `origin/${cfg.baseBranch}`;
  const provenance = [];
  const history = [];
  const style = styleBlock(cfg.style, cfg.style?.internal?.startsWith('caveman') ? loadSkillText('caveman') : null);
  let round = 0;
  // `phase` labels the call for stats (red, still-green, green, fix, test-fix, review);
  // `resume` continues the agent's previous session (red -> green, or a test-fix retry).
  const call = async (stageName, phase, prompt, schema, write, resume) => {
    const stage = cfg[stageName];
    const persona = loadPersona(stage.persona, repo.mainRoot);
    let p = provenance.find((x) => x.stage === stageName);
    if (!p) provenance.push(p = { stage: stageName, cli: stage.cli, model: stage.model, effort: stage.effort, persona: persona.name, hash: persona.hash, calls: 0, input: 0, cached: 0, output: 0 });
    log(`#${n} ${stageName} ${phase}${resume ? ' (resumed)' : ''} (${stage.cli} ${stage.model} ${stage.effort})`);
    const t0 = Date.now();
    const { out, usage, session } = await invoke({ stage, persona, prompt: prompt + skillsBlock(cfg.stageSkills?.[stageName]) + style, schema, cwd, write, commands,
      allowNetwork: cfg.allowNetwork, toolkit: cfg.toolkit, resume, prices: cfg.apiPrices });
    p.calls++; p.input += usage.input; p.cached += usage.cached; p.output += usage.output;
    log(`#${n} ${stageName} tokens in=${usage.input} cached=${usage.cached} out=${usage.output} peak context=${usage.peakContext ?? '?'}`);
    // Reasoning-heavy stages have a context budget; past it, model reasoning degrades.
    const budget = budgetFor(cfg, stageName, stage.model);
    const overBudget = budget != null && usage.peakContext != null && usage.peakContext > budget;
    if (overBudget) {
      log(`#${n} WARNING ${stageName} ${phase} peak context ${usage.peakContext} exceeded its ${budget}-token budget`);
      ev('context_budget_exceeded', { stage: stageName, phase, round, peakContext: usage.peakContext, budget });
    }
    ev('stage_call', { stage: stageName, phase, round, cli: stage.cli, model: stage.model, effort: stage.effort, persona: persona.name, personaHash: persona.hash,
      resumed: Boolean(resume), durationMs: Date.now() - t0, ...usage, contextBudget: budget, overBudget, status: out.status ?? out.verdict });
    return { out, p, session };
  };
  const tests = async (phase) => {
    const t0 = Date.now();
    const g = await runShell(commands.test, { cwd, timeoutMs: 30 * 60_000 });
    ev('gate', { phase, round, pass: g.code === 0, durationMs: Date.now() - t0 });
    return g;
  };
  const evidence = (gate) => ({ command: commands.test, output: gate.output.slice(-3000) });
  // ff, not the agent, commits: agents need no .git write access, and red-then-green is verified here.
  const commit = async (kind, stageName, summary) => {
    const s = cfg[stageName];
    const sha = await git.commitAll(cwd, `${kind}: ${issue.title} (#${n})\n\n${summary}\n\nFeature-Flow-Stage: ${stageName} ${s.cli}/${s.model}/${s.effort}`);
    if (sha) ev('commit', { kind, round, sha });
    return sha;
  };
  const blocked = async (out) => {
    // More rounds of the same model won't unblock a contradictory ticket or a broken environment.
    log(`#${n} blocked: ${out.notes.slice(0, 300)}`);
    ev('blocked', { round, notes: out.notes.slice(0, 500) });
    await gh.commentIssue(n, `### feature-flow: implementer blocked\n\n${out.notes}${out.diagnosis ? `\n\n${out.diagnosis}` : ''}`, repo.mainRoot);
  };
  const end = async (state, pr) => {
    const diff = await safeDiffStats(git, cwd, base, log);
    ev('ticket_end', { state, rounds: round + 1, pr: pr ?? null, durationMs: Date.now() - started, diff });
  };
  let red = null; // verified failing-test evidence, set once the test: commit exists
  let featCommitted = false;

  for (; ; round++) {
    const stageName = stageForRound(round, cfg);
    if (!stageName) break;

    let impl, session;
    if (!red) {
      let r = await call(stageName, 'red', redPrompt({ ticket, base, commands, history }), RED_SCHEMA, true);
      session = r.session;
      if (r.out.status === 'blocked') { await blocked(r.out); break; }
      let redGate = await tests('red');
      if (redGate.code === 0) {
        r = await call(stageName, 'still-green', stillGreenPrompt(redGate.output), RED_SCHEMA, true, session);
        redGate = await tests('red');
      }
      const sha = redGate.code !== 0 && await commit('test', stageName, r.out.summary);
      if (!sha) {
        const why = redGate.code === 0 ? 'The new tests did not fail before implementation.' : 'No tests were written.';
        history.push({ kind: 'red phase failed', text: why });
        ev('red_failed', { round, reason: why });
        await git.discardChanges(cwd);
        log(`#${n} round ${round} red phase failed`);
        continue;
      }
      red = evidence(redGate);
      log(`#${n} red verified and committed ${sha.slice(0, 7)}`);
      ({ out: impl, session } = await call(stageName, 'green', greenPrompt({ redOutput: redGate.output }), IMPLEMENT_SCHEMA, true, session));
    } else {
      ({ out: impl, session } = await call(stageName, 'fix', fixPrompt({ ticket, base, commands, history }), IMPLEMENT_SCHEMA, true));
    }
    if (impl.status === 'blocked') { await blocked(impl); break; }
    let gate = await tests('green');
    if (gate.code !== 0) {
      // One chance to fix a red suite before it costs a review round.
      ({ out: impl, session } = await call(stageName, 'test-fix', testFixPrompt(gate.output), IMPLEMENT_SCHEMA, true, session));
      gate = await tests('green');
    }
    if (gate.code !== 0) {
      history.push({ kind: 'tests failed', text: testFixPrompt(gate.output) });
      log(`#${n} round ${round} failed the test gate`);
      continue;
    }
    await commit(featCommitted ? 'fix' : 'feat', stageName, impl.summary);
    featCommitted = true;
    impl = { ...impl, red, green: evidence(gate) };

    await git.push(cwd, ticket.branch);
    const pr = await gh.upsertPr({ branch: ticket.branch, base: cfg.baseBranch, title: `${issue.title} (#${n})`, body: prBody({ ticket, impl, provenance }) }, repo.mainRoot);
    if (impl.diagnosis) await gh.comment(pr.number, `### Escalation diagnosis\n\n${impl.diagnosis}`, repo.mainRoot);

    const reviewedSha = await git.headSha(cwd);
    const { out: review, p } = await call('review', 'review', reviewPrompt({ ticket, base, impl }), REVIEW_SCHEMA, false);
    // Reviews are read-only; prove it rather than trust the sandbox.
    if (await git.headSha(cwd) !== reviewedSha || await git.isDirty(cwd)) {
      await git.discardChanges(cwd);
      throw new Error(`review stage modified the worktree (expected read-only); changes discarded`);
    }
    ev('review', { round, stage: stageName, verdict: review.verdict, dodMet: review.dodMet, tddEvidenceOk: review.tddEvidenceOk, pr: pr.number, ...severityCounts(review.findings) });
    await gh.comment(pr.number, reviewComment(review, p), repo.mainRoot);
    // Re-render so the provenance table includes the review stage.
    await gh.upsertPr({ branch: ticket.branch, base: cfg.baseBranch, title: `${issue.title} (#${n})`, body: prBody({ ticket, impl, provenance }) }, repo.mainRoot);
    log(`#${n} round ${round} review ${review.verdict} (PR #${pr.number})`);

    if (review.verdict === 'PASS') {
      await gh.markReady(pr.number, repo.mainRoot);
      await labels({ add: ['ready-for-qa'], remove: ['in-progress'] });
      await end('ready-for-qa', pr.number);
      return { ticket: n, state: 'ready-for-qa', pr: pr.url, rounds: round + 1, stages: provenance };
    }
    history.push({ kind: 'review requested changes', text: reviewComment(review, p) });
  }

  await labels({ add: ['needs-human'], remove: ['in-progress'] });
  const pr = await gh.findPr(ticket.branch, repo.mainRoot);
  log(`#${n} needs a human`);
  await end('needs-human', pr?.number);
  return { ticket: n, state: 'needs-human', pr: pr?.url, stages: provenance };
}

