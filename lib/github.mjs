import { run } from './exec.mjs';

export const LABELS = {
  'ff:epic': ['5319e7', 'feature-flow epic'],
  'ff:ticket': ['1d76db', 'feature-flow ticket'],
  'plan-approved': ['0e8a16', 'Ticket plan approved; ff run may start'],
  'in-progress': ['fbca04', 'An agent is working on this ticket'],
  'ready-for-qa': ['0e8a16', 'Review passed; ready for human QA'],
  'needs-human': ['d93f0b', 'Automated rounds exhausted; human needed'],
};
export const BUSY_LABELS = ['in-progress', 'ready-for-qa', 'needs-human'];

const gh = async (args, cwd, input) => (await run('gh', args, { cwd, input })).stdout;
const ghJson = async (args, cwd) => JSON.parse(await gh(args, cwd));

export const ensureLabels = (cwd) =>
  Promise.all(Object.entries(LABELS).map(([name, [color, desc]]) => gh(['label', 'create', name, '--color', color, '--description', desc, '--force'], cwd)));

export const viewIssue = (n, cwd) =>
  ghJson(['issue', 'view', String(n), '--json', 'number,title,body,state,labels,blockedBy,subIssues'], cwd);

export const labelNames = (issue) => issue.labels.map((l) => l.name);

// A ticket is ready when it is open, idle, and every blocker is closed.
export function isReady(issue) {
  const blockers = issue.blockedBy?.nodes ?? issue.blockedBy ?? [];
  return issue.state === 'OPEN'
    && !labelNames(issue).some((l) => BUSY_LABELS.includes(l))
    && blockers.every((b) => b.state === 'CLOSED');
}

export const editLabels = (n, { add = [], remove = [] }, cwd) =>
  gh(['issue', 'edit', String(n), ...add.flatMap((l) => ['--add-label', l]), ...remove.flatMap((l) => ['--remove-label', l])], cwd);

export async function createIssue({ title, body, labels = [], parent, blockedBy = [] }, cwd, runGh = gh) {
  const out = (await runGh(['issue', 'create', '--title', title, '--body-file', '-', ...labels.flatMap((l) => ['--label', l]),
    ...(parent ? ['--parent', String(parent)] : []), ...(blockedBy.length ? ['--blocked-by', blockedBy.join(',')] : [])], cwd, body)).trim();
  const m = out.match(/\/issues\/(\d+)$/);
  if (!m) throw new Error(`gh issue create did not return an issue URL: ${out.slice(0, 200)}`);
  return Number(m[1]);
}

export const findPr = async (branch, cwd) => (await ghJson(['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,isDraft,url'], cwd))[0];

export async function upsertPr({ branch, base, title, body }, cwd) {
  const pr = await findPr(branch, cwd);
  if (pr && pr.state === 'OPEN') {
    await gh(['pr', 'edit', String(pr.number), '--body-file', '-'], cwd, body);
    return pr;
  }
  await gh(['pr', 'create', '--draft', '--head', branch, '--base', base, '--title', title, '--body-file', '-'], cwd, body);
  return findPr(branch, cwd);
}

export const comment = (prNumber, body, cwd) => gh(['pr', 'comment', String(prNumber), '--body-file', '-'], cwd, body);
export const commentIssue = (n, body, cwd) => gh(['issue', 'comment', String(n), '--body-file', '-'], cwd, body);
export const markReady = (prNumber, cwd) => gh(['pr', 'ready', String(prNumber)], cwd);
