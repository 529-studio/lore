import { execFileSync } from 'node:child_process';
import path from 'node:path';

const headCache = new Map<string, { head: string | null; time: number }>();
const ancestorCache = new Map<string, boolean>();
const topCache = new Map<string, string | null>();
const dirCache = new Map<string, { gitDir: string | null; commonDir: string | null }>();

function revParse(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['rev-parse', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Absolute top-level directory of the working tree, or null outside git. */
export function gitTopLevel(root: string): string | null {
  const key = path.resolve(root);
  if (topCache.has(key)) return topCache.get(key) ?? null;
  const top = revParse(key, ['--show-toplevel']);
  const resolved = top ? path.resolve(top) : null;
  topCache.set(key, resolved);
  return resolved;
}

/** Absolute git directory (per-worktree when linked) and common directory. */
function gitDirs(root: string): { gitDir: string | null; commonDir: string | null } {
  const key = path.resolve(root);
  const cached = dirCache.get(key);
  if (cached) return cached;
  const rawGit = revParse(key, ['--absolute-git-dir']);
  const rawCommon = revParse(key, ['--git-common-dir']);
  const gitDir = rawGit ? path.resolve(key, rawGit) : null;
  const commonDir = rawCommon ? path.resolve(key, rawCommon) : null;
  const value = { gitDir, commonDir };
  dirCache.set(key, value);
  return value;
}

/** Worktree-specific git directory (`.git/worktrees/<name>` for linked worktrees). */
export function gitDir(root: string): string | null {
  return gitDirs(root).gitDir;
}

/** Shared git directory (the primary checkout's `.git`). */
export function gitCommonDir(root: string): string | null {
  return gitDirs(root).commonDir;
}

/** Primary checkout root of a linked worktree, or null for the primary checkout itself. */
export function gitPrimaryRoot(root: string): string | null {
  const common = gitCommonDir(root);
  if (!common || path.basename(common) !== '.git') return null;
  return path.dirname(common);
}

/** True when `root` is a linked worktree rather than the primary checkout. */
export function isLinkedGitWorktree(root: string): boolean {
  const dirs = gitDirs(root);
  return Boolean(dirs.gitDir && dirs.commonDir && dirs.gitDir !== dirs.commonDir);
}

/** Current HEAD of the working tree, or null outside a git repository. Cached for short TTL (3s). */
export function gitHead(root: string, maxAgeMs = 3000): string | null {
  const now = Date.now();
  const cached = headCache.get(root);
  if (cached && (now - cached.time) < maxAgeMs) {
    return cached.head;
  }
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
    headCache.set(root, { head, time: now });
    return head;
  } catch {
    headCache.set(root, { head: null, time: now });
    return null;
  }
}

/** Invalidate git head cache (e.g. after a commit or branch switch). */
export function invalidateGitHead(root?: string): void {
  if (root) headCache.delete(root);
  else headCache.clear();
}

/** Invalidate git ancestor cache. */
export function invalidateGitAncestors(): void {
  ancestorCache.clear();
}

/** True when `ancestor` is reachable from `descendant` (defaults to HEAD). */
export function isGitAncestor(root: string, ancestor: string, descendant = 'HEAD'): boolean {
  const actualDescendant = descendant === 'HEAD' ? (gitHead(root) ?? 'HEAD') : descendant;
  const key = `${root}:${ancestor}:${actualDescendant}`;
  const cached = ancestorCache.get(key);
  if (cached !== undefined) return cached;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, actualDescendant], {
      cwd: root,
      stdio: 'ignore',
    });
    ancestorCache.set(key, true);
    return true;
  } catch {
    ancestorCache.set(key, false);
    return false;
  }
}
