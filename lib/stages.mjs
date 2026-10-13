// Prompts and output schemas for the headless stages.
// Schemas are "strict" (every property required, no extras) because Codex's --output-schema demands it.

const str = { type: 'string' };
const strs = { type: 'array', items: str };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const status = { type: 'string', enum: ['done', 'blocked'] };

// Red phase: failing tests only. The orchestrator verifies they fail and commits them.
export const RED_SCHEMA = obj({ status, summary: str, tests: strs, notes: str });

// Green phase and fix rounds: the orchestrator runs the tests and records red/green evidence itself.
export const IMPLEMENT_SCHEMA = obj({
  status,
  summary: str,
  dod: { type: 'array', items: obj({ item: str, met: { type: 'boolean' }, evidence: str }) },
  qa: obj({ setup: str, steps: { type: 'array', items: obj({ action: str, expected: str }) }, edgeCases: strs, automated: strs, manual: strs }),
  diagnosis: str,
  notes: str,
});

export const REVIEW_SCHEMA = obj({
  verdict: { type: 'string', enum: ['PASS', 'CHANGES'] },
  summary: str,
  dodMet: { type: 'boolean' },
  tddEvidenceOk: { type: 'boolean' },
  findings: { type: 'array', items: obj({ severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: str, issue: str, fix: str }) },
});

export const planOpening = ({ root, planApproval, request, plansFolder }) =>
  `Start the feature-flow planning procedure for the repo at ${root}. planApproval is ${planApproval}.\nPlans folder: ${plansFolder}\nFeature request: ${request}`;

// Agent-to-agent text may be compressed; anything a human reads stays natural.
export function styleBlock(style, cavemanRules) {
  const level = /^caveman-(lite|full|ultra)$/.exec(style?.internal ?? '')?.[1];
  const human = 'Every other field is read by a human: concise, plain, natural sentences; no filler; never caveman.';
  if (!level || !cavemanRules) return `\n## Writing style\n${human}\n`;
  return `
## Writing style
- Your working prose (reasoning shown between tool calls) and the \`notes\` field are read only by other agents:
  write them caveman-style at the **${level}** intensity of the rules below.
- ${human} Code, commands, paths and error strings stay exact everywhere.

### Caveman rules
${cavemanRules}
`;
}

const commandsBlock = (commands) =>
  Object.keys(commands).length ? Object.entries(commands).map(([k, v]) => `- ${k}: \`${v}\``).join('\n') : '- (none declared in AGENTS.md)';

const context = ({ ticket, base, commands }) => `GitHub issue #${ticket.number}: ${ticket.title}

You are in a git worktree on branch ${ticket.branch}, created from ${base}. Work only here.

## Ticket
${ticket.body}

## Repo commands
${commandsBlock(commands)}

## Rules
- Do not run git add, git commit, git push or gh: the orchestrator runs the tests, commits and handles GitHub.
- Run repo commands plainly, without command substitution or heredocs: they are permission-checked.
- Stay inside the ticket's scope.`;

const historyBlock = (history) => history.length
  ? `\n## Previous attempts on this branch (newest last)\n${history.map((h, i) => `### Attempt ${i + 1}: ${h.kind}\n${h.text}`).join('\n\n')}\n`
  : '';

const IMPLEMENT_REPORT = `Return the structured result: every definition-of-done item with evidence, QA instructions, and notes.
"diagnosis" is empty unless your persona asks for one.`;

export function redPrompt(opts) {
  return `RED PHASE for ${context(opts)}
${historyBlock(opts.history)}
Write the failing tests that prove this ticket's definition of done (start from "Tests to write first").
Do NOT write any implementation code yet. Run the test command and confirm the new tests fail for the right reason.
Return the structured result: the tests you wrote and why they fail.`;
}

export function greenPrompt({ redOutput }) {
  return `GREEN PHASE. The orchestrator committed your failing tests; the test command failed as expected:

\`\`\`
${redOutput.slice(-4000)}
\`\`\`

Now write the smallest implementation that makes them pass and meets every definition-of-done item.
Do not weaken or delete the tests you just wrote; if one is genuinely wrong, fix it and say why in notes.
Finish with the test command passing.
${IMPLEMENT_REPORT}`;
}

export function fixPrompt(opts) {
  return `FIX ROUND for ${context(opts)}
${historyBlock(opts.history)}
The branch already holds the previous work. Address every blocker and major finding above.
If a fix changes behaviour, add or adjust a failing test first. Finish with the test command passing.
${IMPLEMENT_REPORT}`;
}

export function reviewPrompt({ ticket, base, impl }) {
  return `Review the change on this branch for GitHub issue #${ticket.number}: ${ticket.title}

Diff to review: \`git diff ${base}...HEAD\` (also see \`git log ${base}..HEAD\`). Read-only: do not modify files.

## Ticket (includes the definition of done)
${ticket.body}

## Implementer's report
${JSON.stringify(impl, null, 2)}

Check correctness, code quality and simplicity, and definition-of-done coverage. The orchestrator itself verified
that the "test:" commit's tests failed before implementation and pass now (outputs are in the report); check that
those tests actually exercise the ticket's behaviour and were not weakened afterwards.
Return verdict PASS only if there are no blocker or major findings.`;
}

export function testFixPrompt(output) {
  return `The orchestrator ran the test command after your work and it FAILED:\n\n\`\`\`\n${output.slice(-6000)}\n\`\`\`\nFix it.`;
}

export function stillGreenPrompt(output) {
  return `The orchestrator ran the test command after your red phase and it PASSED, so your new tests do not fail yet:\n\n\`\`\`\n${output.slice(-3000)}\n\`\`\`\nWrite tests that fail until the ticket is implemented. Do not implement anything.`;
}
