import * as gh from './github.mjs';
import { ticketBody, epicBody } from './render.mjs';

// Order tickets so each comes after everything it depends on; throws on unknown keys or cycles.
export function topoSort(tickets) {
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const out = [], state = new Map();
  const visit = (t, path) => {
    if (state.get(t.key) === 'done') return;
    if (state.get(t.key) === 'visiting') throw new Error(`dependency cycle: ${[...path, t.key].join(' -> ')}`);
    state.set(t.key, 'visiting');
    for (const d of t.dependsOn ?? []) {
      if (!byKey.has(d)) throw new Error(`ticket ${t.key} depends on unknown ticket ${d}`);
      visit(byKey.get(d), [...path, t.key]);
    }
    state.set(t.key, 'done');
    out.push(t);
  };
  tickets.forEach((t) => visit(t, []));
  return out;
}

export async function publishPlan(plan, { cwd, approve }) {
  const ordered = topoSort(plan.tickets);
  await gh.ensureLabels(cwd);
  const epic = await gh.createIssue({ title: plan.title, body: epicBody(plan), labels: ['ff:epic', ...(approve ? ['plan-approved'] : [])] }, cwd);
  const numbers = new Map();
  for (const t of ordered) {
    const n = await gh.createIssue({
      title: t.title, body: ticketBody(t, epic), labels: ['ff:ticket'], parent: epic,
      blockedBy: (t.dependsOn ?? []).map((k) => numbers.get(k)),
    }, cwd);
    numbers.set(t.key, n);
  }
  return { epic, tickets: Object.fromEntries(numbers) };
}
