import { execFileSync } from 'node:child_process';

const headCache = new Map<string, { head: string | null; time: number }>();
const ancestorCache = new Map<string, boolean>();

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
