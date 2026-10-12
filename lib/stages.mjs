// Prompts and output schemas for the headless stages.
// Schemas are "strict" (every property required, no extras) because Codex's --output-schema demands it.

const str = { type: 'string' };
const strs = { type: 'array', items: str };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const IMPLEMENT_SCHEMA = obj({
  status: { type: 'string', enum: ['done', 'blocked'] },
  summary: str,
  dod: { type: 'array', items: obj({ item: str, met: { type: 'boolean' }, evidence: str }) },
  red: obj({ command: str, output: str }),
  green: obj({ command: str, output: str }),
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

export function implementPrompt({ ticket, base, commands, history }) {
  return `You are implementing GitHub issue #${ticket.number}: ${ticket.title}

You are in a git worktree on branch ${ticket.branch}, created from ${base}. Work only here.

## Ticket
${ticket.body}

## Repo commands
${commandsBlock(commands)}

## Rules
- Test first: commit a failing test (message starts with "test:") BEFORE the commit that makes it pass.
- Commit locally only. Never push, never use gh; the orchestrator handles GitHub.
- Run git and repo commands plainly (\`git commit -m "msg"\`), without command substitution or heredocs: they are permission-checked.
- Stay inside the ticket's scope; meet every definition-of-done item.
- Finish with the test command passing.
${history.length ? `\n## Previous attempts on this branch (newest last)\n${history.map((h, i) => `### Attempt ${i + 1}: ${h.kind}\n${h.text}`).join('\n\n')}\n` : ''}
Return the structured result. "red" and "green" are the test command and the relevant output before and after the fix.
"diagnosis" is empty unless your persona asks for one.`;
}

export function reviewPrompt({ ticket, base, impl }) {
  return `Review the change on this branch for GitHub issue #${ticket.number}: ${ticket.title}

Diff to review: \`git diff ${base}...HEAD\` (also see \`git log ${base}..HEAD\`). Read-only: do not modify files.

## Ticket (includes the definition of done)
${ticket.body}

## Implementer's report
${JSON.stringify(impl, null, 2)}

Check correctness, code quality and simplicity, definition-of-done coverage, and TDD evidence
(a "test:" commit containing a failing test must precede the implementation commit).
Return verdict PASS only if there are no blocker or major findings.`;
}

export function testFixPrompt(output) {
  return `The orchestrator ran the test command after your work and it FAILED:\n\n\`\`\`\n${output.slice(-6000)}\n\`\`\`\nFix it.`;
}
