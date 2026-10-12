import { existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { run } from './exec.mjs';

const git = async (args, cwd) => (await run('git', args, { cwd })).stdout.trim();

// The main checkout is the parent of the shared .git dir, even when called from a worktree.
export async function repoInfo(cwd) {
  const gitCommonDir = resolve(cwd, await git(['rev-parse', '--git-common-dir'], cwd));
  const mainRoot = dirname(gitCommonDir);
  return { mainRoot, gitCommonDir, name: basename(mainRoot) };
}

export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export async function ensureWorktree({ mainRoot, path, branch, base }) {
  if (existsSync(path)) return path;
  await git(['fetch', 'origin', base], mainRoot);
  const hasBranch = (await run('git', ['rev-parse', '--verify', '--quiet', branch], { cwd: mainRoot, allowFail: true })).code === 0;
  await git(['worktree', 'add', path, ...(hasBranch ? [branch] : ['-b', branch, `origin/${base}`])], mainRoot);
  return path;
}

export const push = (cwd, branch) => git(['push', '-u', 'origin', branch], cwd);
export const headSha = (cwd) => git(['rev-parse', 'HEAD'], cwd);

export async function removeWorktree(mainRoot, path, branch) {
  await run('git', ['worktree', 'remove', '--force', path], { cwd: mainRoot, allowFail: true });
  await run('git', ['branch', '-D', branch], { cwd: mainRoot, allowFail: true });
}

// "worktree <path>\nHEAD ..\nbranch refs/heads/<b>" blocks -> [{path, branch}]
export async function listWorktrees(mainRoot) {
  const out = await git(['worktree', 'list', '--porcelain'], mainRoot);
  return out.split(/\r?\n\r?\n/).map((block) => ({
    path: block.match(/^worktree (.+)$/m)?.[1],
    branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1],
  })).filter((w) => w.path && w.branch);
}

export const worktreePath = (root, repo, n) => join(root, repo, `ticket-${n}`);
