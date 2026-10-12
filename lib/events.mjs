// Append-only event log: one JSON object per line in <git common dir>/feature-flow/events.jsonl.
// Every run, ticket, stage call, gate, commit and review lands here; `ff stats` reads it back.
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const eventsFile = (dir) => join(dir, 'events.jsonl');

export function eventLog(dir, base = {}) {
  mkdirSync(dir, { recursive: true });
  return (type, data = {}) => appendFileSync(eventsFile(dir), JSON.stringify({ ts: new Date().toISOString(), type, ...base, ...data }) + '\n');
}

export function readEvents(dir) {
  const f = eventsFile(dir);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Count findings by severity from a review result.
export const severityCounts = (findings = []) =>
  findings.reduce((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] ?? 0) + 1 }), { blocker: 0, major: 0, minor: 0 });

const TEST_PATH = /(^|\/)(tests?|spec|__tests__)\/|\.(test|spec)\.[^/]+$/i;
// `git diff --numstat` lines -> totals, split into test and non-test files.
export function diffStats(numstat) {
  const s = { files: 0, insertions: 0, deletions: 0, testFiles: 0, testInsertions: 0 };
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [add, del, path] = line.split('\t');
    const a = Number(add) || 0;
    s.files++; s.insertions += a; s.deletions += Number(del) || 0;
    if (TEST_PATH.test(path)) { s.testFiles++; s.testInsertions += a; }
  }
  return s;
}
