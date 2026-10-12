const list = (xs, prefix = '- ') => (xs?.length ? xs.map((x) => `${prefix}${x}`).join('\n') : '_none_');
const fence = (s) => '```\n' + String(s ?? '').trim().slice(-3000) + '\n```';

export function ticketBody(t, epic) {
  return `Part of #${epic}.

## Goal
${t.goal}

## In scope
${list(t.inScope)}

## Out of scope
${list(t.outOfScope)}

## Definition of done
${list(t.dod, '- [ ] ')}

## Tests to write first
${list(t.tests)}

## QA hints
${list(t.qaHints)}
`;
}

export function epicBody(plan) {
  return `${plan.summary}\n\nTickets are sub-issues of this epic. Run with \`ff run <this issue number>\`.\n`;
}

export function prBody({ ticket, impl, provenance }) {
  const qa = impl.qa;
  return `Closes #${ticket.number}

## Summary
${impl.summary}

## Definition of done
${impl.dod.map((d) => `- [${d.met ? 'x' : ' '}] ${d.item}${d.evidence ? ` — ${d.evidence}` : ''}`).join('\n')}

## TDD evidence
**Red** (\`${impl.red.command}\`)
${fence(impl.red.output)}
**Green** (\`${impl.green.command}\`)
${fence(impl.green.output)}

## QA instructions
**Setup:** ${qa.setup}

${qa.steps.map((s, i) => `${i + 1}. ${s.action}\n   - Expected: ${s.expected}`).join('\n')}

**Edge cases to try**
${list(qa.edgeCases)}

**Covered by automated tests**
${list(qa.automated)}

**Needs human eyes**
${list(qa.manual)}

## Provenance
| Stage | CLI | Model | Effort | Persona |
|---|---|---|---|---|
${provenance.map((p) => `| ${p.stage} | ${p.cli} | ${p.model} | ${p.effort} | ${p.persona}@${p.hash} |`).join('\n')}
`;
}

export function reviewComment(review, p) {
  return `### feature-flow review: **${review.verdict}**
_${p.cli} ${p.model} (${p.effort}), persona ${p.persona}@${p.hash}_

${review.summary}

- Definition of done met: ${review.dodMet ? 'yes' : 'no'}
- TDD evidence OK: ${review.tddEvidenceOk ? 'yes' : 'no'}

${review.findings.length ? review.findings.map((f) => `- **${f.severity}** \`${f.file}\`: ${f.issue}\n  - Fix: ${f.fix}`).join('\n') : '_No findings._'}

VERDICT: ${review.verdict}`;
}
