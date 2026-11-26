import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gitPrimaryRoot, gitTopLevel, isLinkedGitWorktree } from './util/git.js';

/**
 * Lore has two roots:
 *
 * - `workspaceRoot` is the checkout the caller is working in. File hashing,
 *   `git HEAD`, `lore.policy.yml` and `lore.ontology.yml` resolve here.
 * - `stateDir` holds `lore.db`, `config.json`, `session` and `litestream.yml`.
 *   A linked git worktree shares the primary checkout's state by default.
 *
 * Environment contract:
 * - `LORE_WORKSPACE_ROOT` overrides the workspace root.
 * - `LORE_STATE_DIR` overrides the state directory (the `.lore` directory itself).
 * - `LORE_SESSION` overrides the session id.
 */

export type WorktreeMode = 'shared' | 'isolated';

export interface LoreScope {
  workspaceRoot: string;
  stateDir: string;
  linkedWorktree: boolean;
  worktreeMode: WorktreeMode;
}

/** Walk up from `start` looking for a directory that contains `.lore`. */
function dirWithLore(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.lore'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The checkout Lore should read: the git top level, a legacy `.lore` ancestor,
 * or the current directory when neither exists.
 */
export function findWorkspaceRoot(start = process.cwd()): string {
  const override = process.env.LORE_WORKSPACE_ROOT?.trim();
  if (override) return path.resolve(override);
  const gitRoot = gitTopLevel(start);
  if (gitRoot) return gitRoot;
  return dirWithLore(start) ?? path.resolve(start);
}

function readModeFrom(file: string): WorktreeMode | null {
  if (!existsSync(file)) return null;
  try {
    const config = JSON.parse(readFileSync(file, 'utf8')) as { worktree_mode?: unknown };
    return config.worktree_mode === 'isolated' ? 'isolated' : config.worktree_mode === 'shared' ? 'shared' : null;
  } catch {
    return null;
  }
}

/**
 * `isolated` keeps a worktree's own `.lore`; `shared` (default) points at the
 * primary checkout. The local worktree config wins so a checkout can opt out
 * before the shared store is read.
 */
export function worktreeModeFor(workspaceRoot: string): WorktreeMode {
  if (!isLinkedGitWorktree(workspaceRoot)) return 'shared';
  const local = readModeFrom(path.join(workspaceRoot, '.lore', 'config.json'));
  if (local) return local;
  const primary = gitPrimaryRoot(workspaceRoot);
  if (primary) {
    const shared = readModeFrom(path.join(primary, '.lore', 'config.json'));
    if (shared) return shared;
  }
  return 'shared';
}

/** The `.lore` directory that stores `lore.db` and `config.json` for this checkout. */
export function stateDirFor(workspaceRoot: string): string {
  const override = process.env.LORE_STATE_DIR?.trim();
  if (override) return path.resolve(workspaceRoot, override);

  const local = path.join(workspaceRoot, '.lore');
  if (!isLinkedGitWorktree(workspaceRoot)) return local;
  if (worktreeModeFor(workspaceRoot) === 'isolated') return local;

  const primary = gitPrimaryRoot(workspaceRoot);
  return primary ? path.join(primary, '.lore') : local;
}

export function resolveScope(start = process.cwd()): LoreScope {
  const workspaceRoot = findWorkspaceRoot(start);
  return {
    workspaceRoot,
    stateDir: stateDirFor(workspaceRoot),
    linkedWorktree: isLinkedGitWorktree(workspaceRoot),
    worktreeMode: worktreeModeFor(workspaceRoot),
  };
}

/**
 * Legacy helper: returns the workspace root when its state store exists.
 * Callers pass this root to `openDb`; the database itself lives in `stateDirFor`.
 */
export function findStateRoot(start = process.cwd()): string | null {
  const workspaceRoot = findWorkspaceRoot(start);
  return existsSync(stateDirFor(workspaceRoot)) ? workspaceRoot : null;
}
