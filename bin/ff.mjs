#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadPersona, loadCommands, loadSkillText, STAGES } from '../lib/config.mjs';
import { run } from '../lib/exec.mjs';
import { interactiveArgs } from '../lib/adapters.mjs';
import { repoInfo } from '../lib/git.mjs';
import { runEpic, codexDesktopLock, CODEX_LOCK_WARNING } from '../lib/run.mjs';
import { publishPlan } from '../lib/publish.mjs';
import * as gh from '../lib/github.mjs';

const USAGE = `feature-flow (ff)
  ff doctor               check this machine
  ff init                 set up the current repo (labels, overrides dir, AGENTS.md commands)
  ff plan [feature...]    start the planner interactively (plan.cli/model/effort/persona)
  ff publish <plan.json>  create the epic + ticket issues from a planner's plan file
  ff approve <epic#>      add the plan-approved label
  ff run <epic#>          implement, review and hand off all ready tickets
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
  if (clis.has('codex')) checks.push(['codex sandbox free', ...(await codexDesktopLock() ? ['WARN', CODEX_LOCK_WARNING] : ['ok', 'no Codex desktop lock'])]);
  if (cfg?.style?.internal?.startsWith('caveman')) await check('caveman skill', async () => { if (!loadSkillText('caveman')) throw new Error('style.internal is caveman but no caveman skill in ~/.agents/skills or ~/.claude/skills'); return 'found'; });
  if (cfg) for (const s of STAGES) await check(`persona ${cfg[s].persona}`, async () => loadPersona(cfg[s].persona, await repoRoot().catch(() => null)).path);
  for (const [name, status, detail] of checks) console.log(`${status.padEnd(4)} ${name.padEnd(22)} ${detail}`);
  return checks.some(([, s]) => s === 'FAIL') ? 1 : 0;
}

async function init() {
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
  return 0;
}

async function plan(words) {
  const root = await repoRoot();
  const cfg = loadConfig(root);
  const persona = loadPersona(cfg.plan.persona, root);
  const opening = `Start the feature-flow planning procedure for the repo at ${root}. planApproval is ${cfg.planApproval}.\nFeature request: ${words.join(' ') || '(ask me for it)'}`;
  const [cmd, args] = interactiveArgs(cfg.plan, persona, opening);
  return (await run(cmd, args, { cwd: process.cwd(), inherit: true, allowFail: true })).code;
}

async function publish(file) {
  const root = await repoRoot();
  const cfg = loadConfig(root);
  const res = await publishPlan(JSON.parse(readFileSync(file, 'utf8')), { cwd: root, approve: !cfg.planApproval });
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

const [cmd, ...rest] = process.argv.slice(2);
const commands = {
  doctor, init, plan: () => plan(rest), publish: () => publish(rest[0]), run: () => runCmd(rest[0]),
  approve: async () => { await gh.editLabels(rest[0], { add: ['plan-approved'] }, await repoRoot()); return 0; },
  config: async () => { console.log(JSON.stringify(loadConfig(await repoRoot().catch(() => null)), null, 2)); return 0; },
  persona: async () => { process.stdout.write(loadPersona(rest[0], await repoRoot().catch(() => null)).text); return 0; },
};
if (!commands[cmd] || (['publish', 'run', 'approve', 'persona'].includes(cmd) && !rest[0])) {
  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}
commands[cmd]().then((code) => process.exit(code), (err) => { console.error(err.message); process.exit(1); });
