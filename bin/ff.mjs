#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadPersona, loadCommands, loadSkillText, budgetFor, STAGES } from '../lib/config.mjs';
import { run } from '../lib/exec.mjs';
import { interactiveArgs } from '../lib/adapters.mjs';
import { repoInfo } from '../lib/git.mjs';
import { runEpic, codexDesktopLock, codexSandboxRaces, CODEX_LOCK_WARNING } from '../lib/run.mjs';
import { claudeToolkit, codexToolkit, codexMcpServers, skillsBlock, claudeTrusted, grantClaudeTrust, TRUST_HINT } from '../lib/toolkit.mjs';
import { eventLog, readEvents } from '../lib/events.mjs';
import { summarize, renderSummary, refreshOutcomes } from '../lib/stats.mjs';
import { runEval } from '../lib/eval.mjs';
import { writePlanMarker, readPlanMarker, clearPlanMarker, claudePlanMetrics, codexPlanMetrics, planShape } from '../lib/planmetrics.mjs';
import { randomUUID } from 'node:crypto';
import { parseOpts } from '../lib/opts.mjs';
import { publishPlan } from '../lib/publish.mjs';
import * as gh from '../lib/github.mjs';

const USAGE = `feature-flow (ff)
  ff doctor               check this machine
  ff init [--trust]       set up the current repo (labels, overrides dir, AGENTS.md commands);
                          --trust also accepts Claude Code workspace trust for it (needed by ff plan --bg)
  ff plan [feature...]    start the planner interactively (plan.cli/model/effort/persona)
  ff plan --bg [--name N] [feature...]
                              start it as a Claude Code background session (open via agent view)
  ff plan --finish [planId] [--session <claude session id>]
                              record a background planning session's metrics
  ff publish <plan.json>  create the epic + ticket issues from a planner's plan file
  ff approve <epic#>      add the plan-approved label
  ff run <epic#>          implement, review and hand off all ready tickets
  ff stats [epic] [--label L] [--by-label] [--refresh] [--json]
                          efficacy/efficiency metrics from the event log; --refresh asks GitHub for PR outcomes
  ff eval --plan <plan.json> --runs N --reset "<cmd>" <variant.json>...
                          A/B the plan N times per config variant in a throwaway sandbox repo
  ff config               print the merged config
  ff persona <name>       print the effective persona text`;

const repoRoot = async () => (await repoInfo(process.cwd())).mainRoot;

async function doctor() {
  const checks = [];
  const check = async (name, fn) => {
    try { checks.push([name, 'ok', await fn()]); } catch (e) { checks.push([name, 'FAIL', e.message.split('\n')[0]]); }
  };
  await check('node >= 20', async () => { if (+process.versions.node.split('.')[0] < 20) throw new Error(process.version); return process.version; });
  await check('gh >= 2.94', async () => {
    const v = (await run('gh', ['--version'])).stdout.match(/(\d+)\.(\d+)\.(\d+)/);
    if (+v[1] < 2 || (+v[1] === 2 && +v[2] < 94)) throw new Error(`gh ${v[0]} lacks --blocked-by/--parent; upgrade`);
    return v[0];
  });
  await check('gh auth', async () => (await run('gh', ['api', 'user', '--jq', '.login'])).stdout.trim());
  let cfg;
  await check('config', async () => { cfg = loadConfig(await repoRoot().catch(() => null)); return 'loaded'; });
  const clis = new Set(cfg ? STAGES.map((s) => cfg[s].cli) : ['claude', 'codex']);
  if (clis.has('claude')) await check('claude', async () => (await run('claude', ['--version'])).stdout.trim());
  if (clis.has('codex')) await check('codex login', async () => { const r = await run('codex', ['login', 'status']); return (r.stdout + r.stderr).trim(); });
  if (clis.has('codex')) checks.push(['codex sandbox free', ...(!cfg || codexSandboxRaces(cfg)
    ? (await codexDesktopLock() ? ['WARN', CODEX_LOCK_WARNING] : ['ok', 'no node_repl lock'])
    : ['ok', `windowsSandbox=${cfg.toolkit.codex.windowsSandbox} (no node_repl race)`])]);
  const here = await repoRoot().catch(() => null);
  if (here && cfg?.plan.cli === 'claude') {
    const t = claudeTrusted(here);
    checks.push(['claude folder trust', t === false ? 'WARN' : 'ok', t === false ? `${TRUST_HINT(here)} (needed for ff plan --bg)` : t ? 'trusted' : 'unknown']);
  }
  if (clis.has('claude') && cfg) await check('claude toolkit', async () => {
    const tk = claudeToolkit(cfg.toolkit?.claude);
    if (tk.missing.length) throw new Error(`not found: ${tk.missing.join(', ')}`);
    return [...(cfg.toolkit?.claude?.hooks ?? []), ...(cfg.toolkit?.claude?.plugins ?? [])].join(', ') || 'none';
  });
  if (clis.has('codex') && cfg?.toolkit?.codex?.disableMcp) checks.push(['codex MCP off', 'ok', codexMcpServers().join(', ') || 'none configured']);
  if (clis.has('codex') && cfg) await check('codex toolkit', async () => {
    const tk = codexToolkit(cfg.toolkit?.codex);
    if (tk.missing.length) throw new Error(`not found: ${tk.missing.join(', ')}`);
    return `hooks ${cfg.toolkit?.codex?.hooks === false ? 'off' : 'on'}; injected: ${(cfg.toolkit?.codex?.inject ?? []).join(', ') || 'none'}`;
  });
  if (cfg?.style?.internal?.startsWith('caveman')) await check('caveman skill', async () => { if (!loadSkillText('caveman')) throw new Error('style.internal is caveman but no caveman skill in ~/.agents/skills or ~/.claude/skills'); return 'found'; });
  if (cfg) for (const s of STAGES) await check(`persona ${cfg[s].persona}`, async () => loadPersona(cfg[s].persona, await repoRoot().catch(() => null)).path);
  for (const [name, status, detail] of checks) console.log(`${status.padEnd(4)} ${name.padEnd(22)} ${detail}`);
  return checks.some(([, s]) => s === 'FAIL') ? 1 : 0;
}

async function init(args = []) {
  const trust = parseOpts(args).trust === true;
  const root = await repoRoot();
  await gh.ensureLabels(root);
  mkdirSync(join(root, '.agents', 'feature-flow', 'personas'), { recursive: true });
  const agents = join(root, 'AGENTS.md');
  if (!Object.keys(loadCommands(root)).length) {
    const guess = existsSync(join(root, 'package.json')) ? 'npm test' : 'TODO';
    appendFileSync(agents, `\n## Commands\n\n- test: \`${guess}\`\n- lint: \`TODO\`\n- run: \`TODO\`\n`);
    console.log(`Added "## Commands" to AGENTS.md — check the commands (test: ${guess}).`);
  }
  console.log(`Labels created; overrides go in ${join(root, '.agents', 'feature-flow')} (feature-flow.json, personas/<name>.md).`);
  if (trust && claudeTrusted(root) !== true) {
    console.log(`Trusting ${root} in Claude Code: its .claude/ settings, hooks and MCP servers will be allowed to run in Claude sessions there.`);
    console.log(grantClaudeTrust(root) ? 'Trusted.' : `Could not confirm trust; ${TRUST_HINT(root)}`);
  } else if (claudeTrusted(root) === false) {
    console.log(`Note: ${TRUST_HINT(root)} Needed for \`ff plan --bg\`; headless stages don't need it. Or run \`ff init --trust\`.`);
  }
  return 0;
}

// Full session id of a background session from its short id.
async function bgSessionId(shortId) {
  const { stdout } = await run('claude', ['agents', '--json', '--all'], { allowFail: true });
  try { return JSON.parse(stdout).find((a) => a.id === shortId)?.sessionId ?? null; } catch { return null; }
}

// Record a finished planning session's metrics (and a budget warning) from its transcript.
// `sessionId` is the Claude transcript id: the planId itself for foreground runs.
function recordPlanSession({ ev, dir, cfg, persona, planId, sessionId = planId, started, cwd }) {
  const budget = budgetFor(cfg, 'plan', cfg.plan.model) ?? Infinity;
  const metrics = cfg.plan.cli === 'claude' ? claudePlanMetrics(sessionId, budget) : codexPlanMetrics(cwd, started, budget);
  ev('plan_session', { planId, cli: cfg.plan.cli, model: cfg.plan.model, effort: cfg.plan.effort, persona: persona.name, personaHash: persona.hash,
    durationMs: Date.now() - started, contextBudget: Number.isFinite(budget) ? budget : null, ...(metrics ?? { metrics: 'transcript not found' }) });
  if (metrics?.overBudgetRequests) {
    ev('context_budget_exceeded', { stage: 'plan', planId, peakContext: metrics.peakContext, budget, requests: metrics.overBudgetRequests });
    console.log(`WARNING planning peaked at ${metrics.peakContext} tokens of context (${metrics.overBudgetRequests} request(s) over the ${budget}-token budget); reasoning quality may have degraded.`);
  }
  clearPlanMarker(dir);
  return metrics;
}

async function plan(args) {
  const o = parseOpts(args);
  const info = await repoInfo(process.cwd());
  const root = info.mainRoot;
  const cfg = loadConfig(root);
  const persona = loadPersona(cfg.plan.persona, root);
  const dir = join(info.gitCommonDir, 'feature-flow');
  mkdirSync(dir, { recursive: true });
  const ev = eventLog(dir);

  if (o.finish) {
    // Background sessions return immediately, so their metrics are recorded once the user is done.
    const marker = readPlanMarker(dir);
    const planId = typeof o.finish === 'string' ? o.finish : marker?.planId;
    if (!planId) throw new Error('no planning session to finish (pass the planId)');
    const own = marker?.planId === planId ? marker : null;
    const sessionId = typeof o.session === 'string' ? o.session : own?.sessionId ?? planId;
    const m = recordPlanSession({ ev, dir, cfg, persona, planId, sessionId, started: own?.started ?? Date.now(), cwd: root });
    console.log(JSON.stringify({ planId, ...(m ?? { metrics: 'transcript not found' }) }));
    return 0;
  }

  const planId = randomUUID();
  const started = Date.now();
  // The marker lets `ff publish`, run from inside the session, tag the epic with this planId.
  writePlanMarker(dir, { planId, started, background: Boolean(o.bg) });
  const opening = `Start the feature-flow planning procedure for the repo at ${root}. planApproval is ${cfg.planApproval}.\nFeature request: ${o._.join(' ') || '(ask me for it)'}${skillsBlock(cfg.stageSkills?.plan)}`;
  const budget = budgetFor(cfg, 'plan', cfg.plan.model) ?? Infinity;
  const [cmd, cliArgs] = interactiveArgs(cfg.plan, persona, opening, cfg.plan.cli === 'claude' ? planId : undefined, Number.isFinite(budget) ? budget : undefined);

  if (o.bg) {
    if (cfg.plan.cli !== 'claude') throw new Error('--bg needs plan.cli = claude (Claude Code background sessions)');
    if (claudeTrusted(root) === false) { clearPlanMarker(dir); throw new Error(TRUST_HINT(root)); }
    // A background Claude session: open it from Claude Code's agent view (left arrow on an empty prompt).
    const sessionName = typeof o.name === 'string' ? o.name : `ff plan: ${info.name}`;
    const r = await run(cmd, ['--bg', '--name', sessionName, ...cliArgs], { cwd: root, allowFail: true, env: { FF_PLAN_ID: planId } });
    if (r.code !== 0) { clearPlanMarker(dir); throw new Error(`claude --bg failed:\n${r.stderr || r.stdout}`); }
    // Background sessions get their own id (--session-id is not honoured with --bg), so record the real one.
    const shortId = /claude (?:stop|attach|logs) ([0-9a-f]{6,})/.exec(r.stdout ?? '')?.[1] ?? null;
    const sessionId = shortId ? await bgSessionId(shortId) : null;
    writePlanMarker(dir, { planId, started, background: true, sessionId });
    ev('plan_started', { planId, sessionId, cli: cfg.plan.cli, model: cfg.plan.model, effort: cfg.plan.effort, background: true });
    console.log(JSON.stringify({ planId, sessionId, shortId }));
    console.log(`Planner running in the background as "${sessionName}". Open it from Claude Code's agent view; when done: ff plan --finish ${planId}`);
    return 0;
  }

  const code = (await run(cmd, cliArgs, { cwd: process.cwd(), inherit: true, allowFail: true, env: { FF_PLAN_ID: planId } })).code;
  recordPlanSession({ ev, dir, cfg, persona, planId, started, cwd: process.cwd() });
  return code;
}

async function publish(file) {
  const info = await repoInfo(process.cwd());
  const root = info.mainRoot;
  const cfg = loadConfig(root);
  const planJson = JSON.parse(readFileSync(file, 'utf8'));
  const res = await publishPlan(planJson, { cwd: root, approve: !cfg.planApproval });
  const dir = join(info.gitCommonDir, 'feature-flow');
  // FF_PLAN_ID is set by `ff plan` for its own session, so concurrent planners don't share the marker.
  eventLog(dir)('plan_published', { planId: process.env.FF_PLAN_ID ?? readPlanMarker(dir)?.planId ?? null, epic: res.epic, ...planShape(planJson) });
  console.log(JSON.stringify(res));
  console.log(cfg.planApproval ? `Epic #${res.epic} awaits approval: ff approve ${res.epic}` : `Epic #${res.epic} is approved: ff run ${res.epic}`);
  return 0;
}

async function runCmd(epic) {
  const results = await runEpic(Number(epic));
  console.log('\nticket  state          pr');
  for (const r of results) console.log(`#${String(r.ticket).padEnd(6)} ${r.state.padEnd(14)} ${r.pr ?? r.error ?? ''}`);
  return results.some((r) => r.state === 'needs-human') ? 2 : 0;
}

async function stats(args) {
  const o = parseOpts(args);
  const info = await repoInfo(process.cwd());
  const dir = join(info.gitCommonDir, 'feature-flow');
  let events = readEvents(dir);
  if (o.refresh) {
    const n = await refreshOutcomes(events, info.mainRoot, eventLog(dir));
    console.log(`refreshed ${n} PR outcome(s)`);
    events = readEvents(dir);
  }
  const epic = o._[0] ? Number(o._[0]) : undefined;
  const groups = o['by-label'] ? [...new Set(events.map((e) => e.label).filter(Boolean))] : [o.label];
  for (const label of groups) {
    const s = summarize(events, { epic, label });
    console.log(o.json ? JSON.stringify({ label: label ?? null, epic: epic ?? null, ...s }, null, 2) : renderSummary(label ?? (epic ? `epic #${epic}` : 'all runs'), s));
  }
  return 0;
}

async function evalCmd(args) {
  const o = parseOpts(args);
  if (!o.plan || !o._.length) throw new Error('usage: ff eval --plan <plan.json> --runs N --reset "<cmd>" <variant.json>...');
  await runEval({ planFile: o.plan, runs: Number(o.runs ?? 1), variantFiles: o._, resetCommand: o.reset ?? 'node eval/reset.mjs' });
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = {
  doctor, init: () => init(rest), plan: () => plan(rest), publish: () => publish(rest[0]), run: () => runCmd(rest[0]),
  stats: () => stats(rest), eval: () => evalCmd(rest),
  approve: async () => { await gh.editLabels(rest[0], { add: ['plan-approved'] }, await repoRoot()); return 0; },
  config: async () => { console.log(JSON.stringify(loadConfig(await repoRoot().catch(() => null)), null, 2)); return 0; },
  persona: async () => { process.stdout.write(loadPersona(rest[0], await repoRoot().catch(() => null)).text); return 0; },
};
if (!commands[cmd] || (['publish', 'run', 'approve', 'persona'].includes(cmd) && !rest[0])) {
  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}
commands[cmd]().then((code) => process.exit(code), (err) => { console.error(err.message); process.exit(1); });
