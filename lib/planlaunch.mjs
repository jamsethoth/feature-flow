import { mkdirSync } from 'node:fs';
import { budgetFor, plansDir } from './config.mjs';
import { planOpening } from './stages.mjs';
import { interactiveArgs } from './adapters.mjs';
import { skillsBlock } from './toolkit.mjs';

// Creates the plans folder and builds the planner's launch command; split out of `ff plan` so a test can
// read the opening prompt the planner receives.
export function planLaunch({ root, name, cfg, persona, feature, planId, userDir }) {
  const plansFolder = plansDir(name, userDir);
  mkdirSync(plansFolder, { recursive: true });
  const opening = planOpening({ root, planApproval: cfg.planApproval, feature, plansFolder, skills: skillsBlock(cfg.stageTools?.plan?.skills) });
  const budget = budgetFor(cfg, 'plan', cfg.plan.model) ?? Infinity;
  const [cmd, cliArgs] = interactiveArgs(cfg.plan, persona, opening, cfg.plan.cli === 'claude' ? planId : undefined, Number.isFinite(budget) ? budget : undefined);
  return { cmd, cliArgs };
}
