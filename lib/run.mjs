import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadPersona, loadCommands, loadSkillText } from './config.mjs';
import { invoke } from './adapters.mjs';
import { skillsBlock } from './toolkit.mjs';
import { run, runShell } from './exec.mjs';
import * as gh from './github.mjs';
import * as git from './git.mjs';
import { IMPLEMENT_SCHEMA, REVIEW_SCHEMA, implementPrompt, reviewPrompt, testFixPrompt, styleBlock } from './stages.mjs';
import { prBody, reviewComment } from './render.mjs';

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
export const CODEX_LOCK_WARNING = 'Codex desktop app is running (node_repl.exe): Codex CLI sandboxed commands may fail with "setup refresh had errors". Close the Codex app before running Codex stages.';

export async function cleanupMerged(repo, cfg, log) {
  for (const wt of await git.listWorktrees(repo.mainRoot)) {
    if (!wt.branch.startsWith('ticket/')) continue;
    const pr = await gh.findPr(wt.branch, repo.mainRoot);
    if (pr?.state === 'MERGED') {
      await git.removeWorktree(repo.mainRoot, wt.path, wt.branch);
      log(`cleaned up merged ${wt.branch}`);
    }
  }
}

export async function runEpic(epicNumber, { cwd = process.cwd(), print = console.log } = {}) {
  const repo = await git.repoInfo(cwd);
  const cfg = loadConfig(repo.mainRoot);
  const commands = loadCommands(repo.mainRoot);
  if (!commands.test) throw new Error('AGENTS.md has no "## Commands" entry for test (run `ff init`)');

  const logDir = join(repo.gitCommonDir, 'feature-flow');
  mkdirSync(logDir, { recursive: true });
  const log = (msg) => {
    const line = `${new Date().toISOString()} ${msg}`;
    appendFileSync(join(logDir, `${epicNumber}.log`), line + '\n');
    print(line);
  };

  if (['implement', 'review', 'escalate'].some((s) => cfg[s].cli === 'codex') && await codexDesktopLock()) log(`WARNING ${CODEX_LOCK_WARNING}`);
  await cleanupMerged(repo, cfg, log);
  const epic = await gh.viewIssue(epicNumber, repo.mainRoot);
  if (cfg.planApproval && !gh.labelNames(epic).includes('plan-approved')) {
    log(`epic #${epicNumber} lacks the plan-approved label; nothing run`);
    return [];
  }
  const subs = epic.subIssues?.nodes ?? epic.subIssues ?? [];
  const tickets = await Promise.all(subs.map((s) => gh.viewIssue(s.number, repo.mainRoot)));
  const ready = tickets.filter(gh.isReady);
  log(`epic #${epicNumber}: ${tickets.length} tickets, ${ready.length} ready`);

  const results = await pool(ready, cfg.maxParallel, (t) => runTicket(t, { repo, cfg, commands, log }).catch(async (err) => {
    log(`#${t.number} ERROR ${err.message}`);
    await gh.editLabels(t.number, { add: ['needs-human'], remove: ['in-progress'] }, repo.mainRoot).catch(() => {});
    return { ticket: t.number, state: 'needs-human', error: err.message.split('\n')[0] };
  }));
  const skipped = tickets.filter((t) => !ready.includes(t)).map((t) => ({ ticket: t.number, state: t.state === 'CLOSED' ? 'closed' : (gh.labelNames(t).find((l) => gh.BUSY_LABELS.includes(l)) ?? 'blocked') }));
  writeFileSync(join(logDir, `${epicNumber}.usage.json`), JSON.stringify({ style: cfg.style, results }, null, 2));
  return [...results, ...skipped];
}

async function runTicket(issue, { repo, cfg, commands, log }) {
  const n = issue.number;
  const ticket = { ...issue, branch: `ticket/${n}-${git.slugify(issue.title)}` };
  const cwd = await git.ensureWorktree({ mainRoot: repo.mainRoot, path: git.worktreePath(cfg.worktreeRoot, repo.name, n), branch: ticket.branch, base: cfg.baseBranch });
  await gh.editLabels(n, { add: ['in-progress'] }, repo.mainRoot);
  log(`#${n} started in ${cwd}`);

  const base = `origin/${cfg.baseBranch}`;
  const provenance = [];
  const history = [];
  const style = styleBlock(cfg.style, cfg.style?.internal?.startsWith('caveman') ? loadSkillText('caveman') : null);
  const call = async (stageName, prompt, schema, write) => {
    const stage = cfg[stageName];
    const persona = loadPersona(stage.persona, repo.mainRoot);
    let p = provenance.find((x) => x.stage === stageName);
    if (!p) provenance.push(p = { stage: stageName, cli: stage.cli, model: stage.model, effort: stage.effort, persona: persona.name, hash: persona.hash, calls: 0, input: 0, cached: 0, output: 0 });
    log(`#${n} ${stageName} (${stage.cli} ${stage.model} ${stage.effort})`);
    const { out, usage } = await invoke({ stage, persona, prompt: prompt + skillsBlock(cfg.stageSkills?.[stageName]) + style, schema, cwd, write, commands,
      gitCommonDir: repo.gitCommonDir, allowNetwork: cfg.allowNetwork, toolkit: cfg.toolkit });
    p.calls++; p.input += usage.input; p.cached += usage.cached; p.output += usage.output;
    log(`#${n} ${stageName} tokens in=${usage.input} cached=${usage.cached} out=${usage.output}`);
    return { out, p };
  };
  const tests = () => runShell(commands.test, { cwd, timeoutMs: 30 * 60_000 });

  for (let round = 0; ; round++) {
    const stageName = stageForRound(round, cfg);
    if (!stageName) break;

    let { out: impl } = await call(stageName, implementPrompt({ ticket, base, commands, history }), IMPLEMENT_SCHEMA, true);
    let gate = impl.status === 'blocked' ? { code: 0 } : await tests();
    if (gate.code !== 0) {
      // One chance to fix a red suite before it costs a review round.
      ({ out: impl } = await call(stageName, implementPrompt({ ticket, base, commands, history: [...history, { kind: 'tests failed', text: testFixPrompt(gate.output) }] }), IMPLEMENT_SCHEMA, true));
      gate = await tests();
    }
    if (impl.status === 'blocked') {
      // More rounds of the same model won't unblock a contradictory ticket or a broken environment.
      log(`#${n} blocked: ${impl.notes.slice(0, 300)}`);
      await gh.commentIssue(n, `### feature-flow: implementer blocked\n\n${impl.notes}${impl.diagnosis ? `\n\n${impl.diagnosis}` : ''}`, repo.mainRoot);
      break;
    }
    if (gate.code !== 0) {
      history.push({ kind: 'tests failed', text: testFixPrompt(gate.output) });
      log(`#${n} round ${round} failed the test gate`);
      continue;
    }

    await git.push(cwd, ticket.branch);
    const pr = await gh.upsertPr({ branch: ticket.branch, base: cfg.baseBranch, title: `${issue.title} (#${n})`, body: prBody({ ticket, impl, provenance }) }, repo.mainRoot);
    if (impl.diagnosis) await gh.comment(pr.number, `### Escalation diagnosis\n\n${impl.diagnosis}`, repo.mainRoot);

    const { out: review, p } = await call('review', reviewPrompt({ ticket, base, impl }), REVIEW_SCHEMA, false);
    await gh.comment(pr.number, reviewComment(review, p), repo.mainRoot);
    // Re-render so the provenance table includes the review stage.
    await gh.upsertPr({ branch: ticket.branch, base: cfg.baseBranch, title: `${issue.title} (#${n})`, body: prBody({ ticket, impl, provenance }) }, repo.mainRoot);
    log(`#${n} round ${round} review ${review.verdict} (PR #${pr.number})`);

    if (review.verdict === 'PASS') {
      await gh.markReady(pr.number, repo.mainRoot);
      await gh.editLabels(n, { add: ['ready-for-qa'], remove: ['in-progress'] }, repo.mainRoot);
      return { ticket: n, state: 'ready-for-qa', pr: pr.url, rounds: round + 1, stages: provenance };
    }
    history.push({ kind: 'review requested changes', text: reviewComment(review, p) });
  }

  await gh.editLabels(n, { add: ['needs-human'], remove: ['in-progress'] }, repo.mainRoot);
  const pr = await gh.findPr(ticket.branch, repo.mainRoot);
  log(`#${n} needs a human`);
  return { ticket: n, state: 'needs-human', pr: pr?.url, stages: provenance };
}
