import { readFileSync } from 'node:fs';
import * as ghDefault from './github.mjs';
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

// Read a JSON file tolerating a UTF-8 BOM; parse errors name the file.
export function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
}
export const readPlanFile = readJsonFile;

export async function publishPlan(plan, { cwd, approve, gh = ghDefault }) {
  if (!Array.isArray(plan.tickets) || !plan.tickets.length) throw new Error('plan has no tickets (missing or empty "tickets" array)');
  const keys = new Set();
  for (const t of plan.tickets) {
    if (keys.has(t.key)) throw new Error(`duplicate ticket key ${t.key}`);
    keys.add(t.key);
  }
  const ordered = topoSort(plan.tickets);
  const numbers = new Map();
  let epic;
  try {
    await gh.ensureLabels(cwd);
    epic = await gh.createIssue({ title: plan.title, body: epicBody(plan), labels: ['ff:epic', ...(approve ? ['plan-approved'] : [])] }, cwd);
    for (const t of ordered) {
      const n = await gh.createIssue({
        title: t.title, body: ticketBody(t, epic), labels: ['ff:ticket'], parent: epic,
        blockedBy: (t.dependsOn ?? []).map((k) => numbers.get(k)),
      }, cwd);
      numbers.set(t.key, n);
    }
  } catch (e) {
    const made = [epic != null && `epic #${epic}`, ...[...numbers].map(([k, n]) => `${k} #${n}`)].filter(Boolean);
    throw new Error(`${e.message}\npublishing stopped part-way; already created: ${made.join(', ') || 'nothing'}`, { cause: e });
  }
  return { epic, tickets: Object.fromEntries(numbers) };
}
