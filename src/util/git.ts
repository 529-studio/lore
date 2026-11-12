import { execFileSync } from 'node:child_process';

/** Current HEAD of the working tree, or null outside a git repository. */
export function gitHead(root: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** True when `ancestor` is reachable from `descendant` (defaults to HEAD). */
export function isGitAncestor(root: string, ancestor: string, descendant = 'HEAD'): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: root,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}
