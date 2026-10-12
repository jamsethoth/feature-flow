#!/usr/bin/env node
// Claude Code Stop hook added by `ff plan`: after each reply, warn (never block) when the latest request's
// context exceeds the budget. Warns at the first crossing and again every `step` tokens beyond it.
// Usage: context-hook.mjs <budget> [step]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lastRequestContext } from '../lib/planmetrics.mjs';

const budget = Number(process.argv[2] ?? 100000);
const step = Number(process.argv[3] ?? 50000);

let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  try {
    const { transcript_path: transcript, session_id: session } = JSON.parse(input);
    const context = transcript && existsSync(transcript) ? lastRequestContext(readFileSync(transcript, 'utf8')) : 0;
    if (context <= budget) return;
    // Remember the last warning level so each threshold warns once.
    const state = join(tmpdir(), `ff-context-${session}.json`);
    const level = Math.floor((context - budget) / step);
    const warned = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')).level : -1;
    if (level <= warned) return;
    writeFileSync(state, JSON.stringify({ level }));
    process.stdout.write(JSON.stringify({
      systemMessage: `feature-flow: planning context is now ${Math.round(context / 1000)}k tokens (budget ${Math.round(budget / 1000)}k). Reasoning quality may degrade from here; consider wrapping up, or saving the plan so far and continuing in a fresh session.`,
    }));
  } catch {
    // A warning hook must never break the session.
  }
});
