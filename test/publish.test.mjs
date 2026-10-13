import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as publish from '../lib/publish.mjs';
import * as github from '../lib/github.mjs';

// Safety net: if a test ever reaches the real gh, the spawn fails instead of creating GitHub issues.
process.env.PATH = mkdtempSync(join(tmpdir(), 'ff-nogh-'));

const tk =(key, extra = {}) => ({ key, title: `T ${key}`, ...extra });

// Fake github module: records created issues; createIssue fails on call number `failOn` (1-based).
function fakeGh(failOn = Infinity) {
  const created = [];
  return {
    created,
    ensureLabels: async () => {},
    createIssue: async (issue) => {
      if (created.length + 1 === failOn) throw new Error('gh exploded');
      created.push(issue);
      return 100 + created.length;
    },
  };
}

test('publishPlan rejects duplicate ticket keys before creating anything', async () => {
  const gh = fakeGh();
  await assert.rejects(publish.publishPlan({ title: 'E', tickets: [tk('a'), tk('a')] }, { cwd: '.', approve: true, gh }), /duplicate.*a/i);
  assert.equal(gh.created.length, 0);
});

test('publishPlan rejects a missing or empty tickets array before creating anything', async () => {
  for (const plan of [{ title: 'E' }, { title: 'E', tickets: [] }]) {
    const gh = fakeGh();
    await assert.rejects(publish.publishPlan(plan, { cwd: '.', approve: true, gh }), /tickets/i);
    assert.equal(gh.created.length, 0);
  }
});

test('a failure on the third issue reports the epic and the created ticket numbers', async () => {
  const gh = fakeGh(4); // epic + two tickets created, third ticket fails
  await assert.rejects(
    publish.publishPlan({ title: 'E', tickets: [tk('a'), tk('b'), tk('c')] }, { cwd: '.', approve: true, gh }),
    (err) => /gh exploded/.test(err.message) && /101/.test(err.message) && /102/.test(err.message) && /103/.test(err.message),
  );
});

test('readPlanFile accepts a UTF-8 BOM and names the file on a parse error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-plan-'));
  const ok = join(dir, 'plan.json'), bad = join(dir, 'broken-plan.json');
  writeFileSync(ok, '﻿{"title":"E","tickets":[]}');
  writeFileSync(bad, '{"title": ');
  assert.equal(publish.readPlanFile(ok).title, 'E');
  assert.throws(() => publish.readPlanFile(bad), /broken-plan\.json/);
});

test('createIssue throws when gh does not return an issue URL', async () => {
  const runGh = async () => 'Creating issue in owner/repo\n';
  await assert.rejects(github.createIssue({ title: 't', body: 'b' }, '.', runGh), /issue URL/i);
});

test('createIssue rejects non-URL output that merely ends in /issues/N', async () => {
  for (const out of ['not a URL /issues/42', '/issues/42']) {
    await assert.rejects(github.createIssue({ title: 't', body: 'b' }, '.', async () => out), /issue URL/i);
  }
});

test('createIssue returns the issue number from the URL', async () => {
  const runGh = async () => 'https://github.com/o/r/issues/42\n';
  assert.equal(await github.createIssue({ title: 't', body: 'b' }, '.', runGh), 42);
});
