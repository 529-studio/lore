import type { DB } from '../db.js';
import { readConfig, writeConfig, type LoreConfig } from '../config.js';
import { loadPolicy } from '../policy.js';
import { linkTargets } from '../policy/publish.js';
import {
  buildDeltaBundle,
  importBundle,
  importExternalBundle,
  type ExternalImportResult,
  type ImportResult,
} from '../sync.js';
import { httpPull, httpPullExternal, httpPush, HubConflictError, type HttpRemote } from './http.js';

export interface HubPullResult {
  imported: ImportResult;
  main: string | null;
  seq: number;
  auth_seq: number;
}

function remember(config: LoreConfig, root: string, update: Partial<LoreConfig>): void {
  writeConfig(root, { ...readConfig(root), repo_id: config.repo_id, ...update });
}

/**
 * Delta pull from a hub. Both `fetch` and `push` start here so a proposal
 * promotion sees exactly the main the hub has right now.
 */
export async function pullHub(
  db: DB,
  root: string,
  remote: HttpRemote,
  config: LoreConfig,
  author: string,
): Promise<HubPullResult> {
  const pulled = await httpPull(remote, config.repo_id, {
    sinceSeq: config.hub_seq ?? 0,
    sinceAuthSeq: config.hub_auth_seq ?? 0,
    knownMain: config.hub_main ?? null,
  });
  const imported = importBundle(db, root, pulled.bundle, { author });
  remember(config, root, {
    hub_seq: pulled.seq,
    hub_auth_seq: pulled.auth_seq,
    hub_main: pulled.main,
  });
  return { imported, main: pulled.main, seq: pulled.seq, auth_seq: pulled.auth_seq };
}

export interface LinkedSyncResult extends ExternalImportResult {
  cursor: number;
}

/**
 * Refresh the cached read-only snapshots of every repository named in the
 * consumer's `links:` block. The hub filters each payload with the origin's
 * publish policy, and the import never touches commits or local claims.
 */
export async function syncLinkedRepos(
  db: DB,
  root: string,
  remote: HttpRemote,
): Promise<LinkedSyncResult[]> {
  const out: LinkedSyncResult[] = [];
  for (const target of linkTargets(loadPolicy(root))) {
    const pulled = await httpPullExternal(remote, target.repoId);
    out.push({ ...importExternalBundle(db, target.slug, pulled.bundle), cursor: pulled.cursor });
  }
  return out;
}

/**
 * Publish local main. Pulls first, sends only commits the hub cannot already
 * have, and retries once after a CAS loss. The policy file travels only when
 * this client is a maintainer; the hub ignores it otherwise.
 */
export async function pushHub(
  db: DB,
  root: string,
  remote: HttpRemote,
  config: LoreConfig,
  author: string,
  policy: string | null,
): Promise<{ imported: ImportResult; main: string | null }> {
  const first = await pullHub(db, root, remote, config, author);
  let imported = first.imported;
  let hubMain = first.main;

  for (let attempt = 0; ; attempt += 1) {
    const delta = buildDeltaBundle(db, config.repo_id, hubMain);
    try {
      const result = await httpPush(remote, config.repo_id, delta, hubMain, policy);
      remember(config, root, {
        hub_main: result.main,
        hub_seq: result.seq,
        hub_auth_seq: result.auth_seq,
      });
      return { imported, main: result.main };
    } catch (error) {
      if (!(error instanceof HubConflictError) || attempt > 0) throw error;
      // CAS lost: import the peer's commits, then retry once from the new main.
      const retry = await pullHub(db, root, remote, readConfig(root) ?? config, author);
      imported = retry.imported;
      hubMain = retry.main;
    }
  }
}
