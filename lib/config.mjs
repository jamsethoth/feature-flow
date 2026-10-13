import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const USER_DIR = join(homedir(), '.agents', 'feature-flow');
export const plansDir = (repoName) => join(USER_DIR, 'plans', repoName);
export const STAGES = ['plan', 'implement', 'review', 'escalate'];

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')) : {});

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Later layers win; plain objects merge key by key at every level, arrays and scalars replace.
export function mergeConfig(...layers) {
  const out = {};
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = isPlain(v) ? mergeConfig(isPlain(out[k]) ? out[k] : {}, v) : v;
    }
  }
  return out;
}

export const layerDirs = (repoRoot) => [
  join(PLUGIN_ROOT, 'defaults'),
  USER_DIR,
  ...(repoRoot ? [join(repoRoot, '.agents', 'feature-flow')] : []),
];

export function loadConfig(repoRoot) {
  const [plugin, ...rest] = layerDirs(repoRoot);
  const cfg = mergeConfig(readJson(join(plugin, 'feature-flow.json')), ...rest.map((d) => readJson(join(d, 'feature-flow.json'))));
  cfg.worktreeRoot = cfg.worktreeRoot.replace(/^~(?=$|[\\/])/, homedir());
  for (const s of STAGES) if (!cfg[s]?.cli || !cfg[s]?.persona) throw new Error(`config: stage "${s}" needs cli and persona`);
  return cfg;
}

// Context budget for a stage: only stages with a budget get one; contextBudget.byModel[model] overrides it.
export function budgetFor(cfg, stageName, model) {
  const base = cfg.contextBudget?.[stageName];
  if (base == null) return null;
  return cfg.contextBudget?.byModel?.[model] ?? base;
}

// A persona override replaces the whole file; the most specific layer wins.
export function loadPersona(name, repoRoot) {
  const dirs = [PLUGIN_ROOT, ...layerDirs(repoRoot).slice(1)];
  const path = dirs.reverse().map((d) => join(d, 'personas', `${name}.md`)).find(existsSync);
  if (!path) throw new Error(`persona "${name}" not found in any layer`);
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  return { name, path, text, hash: createHash('sha256').update(text).digest('hex').slice(0, 8) };
}

// A skill's body (frontmatter stripped) from the shared skill folders, or null when not installed.
export function loadSkillText(name) {
  const path = [join(homedir(), '.agents', 'skills', name, 'SKILL.md'), join(homedir(), '.claude', 'skills', name, 'SKILL.md')].find(existsSync);
  return path ? readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/^---[\s\S]*?\n---\r?\n/, '').trim() : null;
}

// Commands are declared in the repo's AGENTS.md as "- test: `cmd`" lines under "## Commands".
export function parseCommands(agentsMd, warn = console.warn) {
  const section = agentsMd.split(/^## /m).find((s) => /^Commands\b/.test(s)) ?? '';
  const cmds = {};
  // `ff init` writes TODO placeholders; they must not become allowlisted commands.
  for (const m of section.matchAll(/^[-*]\s*([\w-]+)\s*:\s*`([^`]+)`/gm)) {
    if (m[2].trim() === 'TODO') continue;
    const name = m[1].toLowerCase();
    if (name in cmds) warn(`AGENTS.md ## Commands defines "${name}" more than once; the last one wins`);
    cmds[name] = m[2];
  }
  return cmds;
}

export function loadCommands(repoRoot) {
  const p = join(repoRoot, 'AGENTS.md');
  return existsSync(p) ? parseCommands(readFileSync(p, 'utf8')) : {};
}
