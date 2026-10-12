// A/B evaluation: run a fixed plan N times per configuration variant, interleaved, then compare stats.
// Meant for a throwaway sandbox repo: each run resets it with the given reset command.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { runShell } from './exec.mjs';
import { repoInfo } from './git.mjs';
import { mergeConfig } from './config.mjs';
import { publishPlan } from './publish.mjs';
import { runEpic } from './run.mjs';
import { readEvents } from './events.mjs';
import { summarize, renderSummary } from './stats.mjs';

export async function runEval({ planFile, runs, variantFiles, resetCommand, cwd = process.cwd(), print = console.log }) {
  const repo = await repoInfo(cwd);
  const overrideDir = join(repo.mainRoot, '.agents', 'feature-flow');
  const overrideFile = join(overrideDir, 'feature-flow.json');
  const original = existsSync(overrideFile) ? readFileSync(overrideFile, 'utf8') : null;
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const variants = variantFiles.map((f) => ({ label: basename(f).replace(/\.json$/, ''), cfg: JSON.parse(readFileSync(f, 'utf8')) }));
  // Labels are unique per eval so repeated evals don't mix; the date prefix keeps them sortable.
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  mkdirSync(overrideDir, { recursive: true });
  try {
    for (let i = 0; i < runs; i++) {
      for (const v of variants) {
        const label = `${stamp}:${v.label}`;
        writeFileSync(overrideFile, JSON.stringify(mergeConfig(original ? JSON.parse(original) : {}, v.cfg), null, 2));
        const reset = await runShell(resetCommand, { cwd: repo.mainRoot });
        if (reset.code !== 0) throw new Error(`reset command failed:\n${reset.output.slice(-2000)}`);
        const { epic } = await publishPlan(plan, { cwd: repo.mainRoot, approve: true });
        print(`eval run ${i + 1}/${runs} ${v.label}: epic #${epic}`);
        await runEpic(epic, { cwd: repo.mainRoot, label, print: () => {} });
      }
    }
  } finally {
    if (original === null) rmSync(overrideFile, { force: true });
    else writeFileSync(overrideFile, original);
    await runShell(resetCommand, { cwd: repo.mainRoot });
  }
  const events = readEvents(join(repo.gitCommonDir, 'feature-flow'));
  for (const v of variants) print(renderSummary(v.label, summarize(events, { label: `${stamp}:${v.label}` })));
}
