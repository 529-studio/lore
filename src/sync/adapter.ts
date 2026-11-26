import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DB } from '../db.js';
import { head } from '../model.js';
import { ensureConfig, readConfig, type RemoteConfig } from '../config.js';
import { policyPath } from '../policy.js';
import {
  buildBundle,
  fetchFromDir,
  importBundle,
  isAncestor,
  pushToDir,
  readBundle,
  type Bundle,
  type ImportResult,
} from '../sync.js';
import { pullHub, pushHub } from '../remotes/hub.js';
import { pgFetch, pgPush, pgReadBundle } from '../remotes/postgres.js';
import { httpPull, type HttpRemote } from '../remotes/http.js';
import { createSyncAdapter as createLitestreamAdapter } from './litestream.js';

export interface SyncPullResult {
  entities: number;
  claims: number;
  commits: number;
  merge: 'none' | 'up-to-date' | 'fast-forward' | 'three-way';
  /** Commits the remote main had that this store did not, measured before the import. */
  behind?: number | null;
}

export interface SyncPushResult {
  walCheckpointed: boolean;
  tip: string | null;
  actionId: number;
}

export interface SyncOptions {
  /** Explicit single-writer Litestream backup target. Never a team remote. */
  replicaUrl?: string;
  execPath?: string;
  configPath?: string;
  /** Configured team remote; when present the adapter dispatches on its type. */
  remote?: RemoteConfig;
}

export type SyncAdapterKind = 'http' | 'postgres' | 'dir' | 'litestream';

export interface SyncAdapter {
  readonly kind: SyncAdapterKind;
  pull(opts?: { author?: string }): Promise<SyncPullResult>;
  push(opts?: { author?: string }): Promise<SyncPushResult>;
}

export interface RemoteStatus {
  configured: boolean;
  reachable: boolean | null;
  /** Commits on remote main that this store cannot reach yet. */
  behind: number | null;
  /** Claim and entity rows carried by the pending delta. */
  behind_rows: number | null;
  main: string | null;
  checked_at: string | null;
  error: string | null;
}

const STATUS_TTL_MS = 15_000;
const statusCache = new Map<string, { status: RemoteStatus; at: number; key: string }>();

/** Cache identity: repointing the remote must not serve the previous answer. */
export function remoteKey(remote: RemoteConfig): string {
  if (remote.type === 'dir') return `dir:${remote.path}`;
  if (remote.type === 'postgres') return `postgres:${remote.url ?? remote.url_env ?? ''}`;
  return `http:${remote.url}:${remote.type === 'http' ? (remote.token_env ?? '') : ''}`;
}

export function setRemoteStatus(root: string, status: RemoteStatus, key: string): void {
  statusCache.set(root, { status, at: Date.now(), key });
}

function syncedStatus(main: string | null): RemoteStatus {
  return {
    configured: true,
    reachable: true,
    behind: 0,
    behind_rows: 0,
    main,
    checked_at: new Date().toISOString(),
    error: null,
  };
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // fetch wraps ECONNREFUSED and friends in `cause`; the wrapper alone says nothing.
  const cause = 'cause' in error ? error.cause : undefined;
  if (cause instanceof Error && cause.message) return `${error.message}: ${cause.message}`;
  return error.message;
}

function unreachableStatus(error: unknown): RemoteStatus {
  return {
    configured: true,
    reachable: false,
    behind: null,
    behind_rows: null,
    main: null,
    checked_at: new Date().toISOString(),
    error: errorText(error),
  };
}

function logSync(
  db: DB,
  author: string,
  action: 'SYNC_INCOMING' | 'SYNC_OUTGOING',
  tip: string | null,
  detail?: ImportResult,
): number {
  const result = db
    .prepare('INSERT INTO agent_action_log (agent_id, action, table_name, row_id, ts, new_state) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      author,
      action,
      'memory_commit',
      tip,
      new Date().toISOString(),
      detail ? JSON.stringify(detail) : null,
    );
  return Number(result.lastInsertRowid);
}

function postgresUrl(remote: Extract<RemoteConfig, { type: 'postgres' }>): string {
  const url = remote.url ?? (remote.url_env ? process.env[remote.url_env] : undefined);
  if (!url) throw new Error(`remote url is not set (env ${remote.url_env ?? 'LORE_REMOTE_URL'})`);
  return url;
}

function asHttpRemote(remote: RemoteConfig): HttpRemote | null {
  if (remote.type === 'http') return remote;
  if (remote.type === 'hub') return { type: 'http', url: remote.url };
  return null;
}

/**
 * Commits on remote main missing locally, and the claims those commits touch.
 * Bundles also carry side-branch commits (proposals, peer sessions); counting
 * the whole bundle would report a remote as behind while main tips match.
 */
export function behindCounts(db: DB, bundle: Bundle): { commits: number; rows: number } {
  const localMain = head(db, 'main');
  const mainRef = bundle.refs.find((ref) => ref.name === 'main')?.commit_id ?? null;
  const byId = new Map(bundle.commits.map((row) => [String(row.id), row]));
  const reachable = new Set<string>();
  const queue = mainRef ? [mainRef] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const row = byId.get(id);
    if (row?.parent_id) queue.push(String(row.parent_id));
    if (row?.merge_parent_id) queue.push(String(row.merge_parent_id));
  }
  const missing = [...reachable].filter((id) => !localMain || !isAncestor(db, id, localMain));
  const missingIds = new Set(missing);
  const claims = new Set<string>();
  for (const entry of bundle.entries) {
    if (missingIds.has(String(entry.commit_id))) claims.add(String(entry.claim_id));
  }
  return { commits: missing.length, rows: claims.size };
}

interface CountedPull extends SyncPullResult {
  main: string | null;
}

class DirSyncAdapter implements SyncAdapter {
  readonly kind = 'dir' as const;

  constructor(
    private db: DB,
    private root: string,
    private dir: string,
  ) {}

  private author(opts?: { author?: string }): string {
    return opts?.author ?? 'sync:pull';
  }

  async pull(opts?: { author?: string }): Promise<SyncPullResult> {
    const config = ensureConfig(this.root);
    const file = path.join(this.dir, `${config.repo_id}.lorebundle`);
    const { commits } = behindCounts(this.db, readBundle(file));
    const imported = fetchFromDir(this.db, this.root, this.dir, config.repo_id, this.author(opts));
    const tip = head(this.db, 'main');
    logSync(this.db, this.author(opts), 'SYNC_INCOMING', tip, imported);
    setRemoteStatus(this.root, syncedStatus(tip), remoteKey(config.remote!));
    return { ...imported, behind: commits };
  }

  async push(opts?: { author?: string }): Promise<SyncPushResult> {
    const config = ensureConfig(this.root);
    const imported = pushToDir(this.db, this.root, this.dir, config.repo_id, this.author(opts));
    const tip = head(this.db, 'main');
    const actionId = logSync(this.db, this.author(opts), 'SYNC_OUTGOING', tip, imported);
    setRemoteStatus(this.root, syncedStatus(tip), remoteKey(config.remote!));
    return { walCheckpointed: false, tip, actionId };
  }
}

class PgSyncAdapter implements SyncAdapter {
  readonly kind = 'postgres' as const;

  constructor(
    private db: DB,
    private root: string,
    private url: string,
  ) {}

  async pull(opts?: { author?: string }): Promise<SyncPullResult> {
    const config = ensureConfig(this.root);
    const author = opts?.author ?? 'sync:pull';
    const bundle = await pgReadBundle(this.url, config.repo_id);
    const behind = behindCounts(this.db, bundle);
    const imported = await pgFetch(this.url, config.repo_id, (incoming) =>
      importBundle(this.db, this.root, incoming, { author }),
    );
    const tip = head(this.db, 'main');
    logSync(this.db, author, 'SYNC_INCOMING', tip, imported);
    setRemoteStatus(this.root, syncedStatus(tip), remoteKey(config.remote!));
    return { ...imported, behind: behind.commits };
  }

  async push(opts?: { author?: string }): Promise<SyncPushResult> {
    const config = ensureConfig(this.root);
    const author = opts?.author ?? 'sync:push';
    const imported = await pgPush(
      this.url,
      config.repo_id,
      (bundle) => importBundle(this.db, this.root, bundle, { author }),
      () => buildBundle(this.db, config.repo_id),
    );
    const tip = head(this.db, 'main');
    const actionId = logSync(this.db, author, 'SYNC_OUTGOING', tip, imported);
    setRemoteStatus(this.root, syncedStatus(tip), remoteKey(config.remote!));
    return { walCheckpointed: false, tip, actionId };
  }
}

class HttpSyncAdapter implements SyncAdapter {
  readonly kind = 'http' as const;

  constructor(
    private db: DB,
    private root: string,
    private remote: HttpRemote,
  ) {}

  async pull(opts?: { author?: string }): Promise<SyncPullResult> {
    const config = ensureConfig(this.root);
    const author = opts?.author ?? 'sync:pull';
    const pulled = await pullHub(this.db, this.root, this.remote, config, author);
    const tip = head(this.db, 'main');
    logSync(this.db, author, 'SYNC_INCOMING', tip, pulled.imported);
    setRemoteStatus(this.root, syncedStatus(pulled.main), remoteKey(config.remote!));
    return { ...pulled.imported, behind: 0 };
  }

  async push(opts?: { author?: string }): Promise<SyncPushResult> {
    const config = ensureConfig(this.root);
    const author = opts?.author ?? 'sync:push';
    const file = policyPath(this.root);
    const policy = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const pushed = await pushHub(this.db, this.root, this.remote, config, author, policy);
    const tip = head(this.db, 'main');
    const actionId = logSync(this.db, author, 'SYNC_OUTGOING', tip, pushed.imported);
    setRemoteStatus(this.root, syncedStatus(pushed.main), remoteKey(config.remote!));
    return { walCheckpointed: false, tip, actionId };
  }
}

/**
 * Dispatch on the configured team remote. A bare `replicaUrl` means the
 * explicit single-writer Litestream backup path, never multi-writer team sync.
 */
export async function createSyncAdapter(db: DB, root: string, opts: SyncOptions = {}): Promise<SyncAdapter> {
  if (opts.remote) {
    if (opts.remote.type === 'dir') return new DirSyncAdapter(db, root, opts.remote.path);
    if (opts.remote.type === 'postgres') return new PgSyncAdapter(db, root, postgresUrl(opts.remote));
    const remote = asHttpRemote(opts.remote);
    if (remote) return new HttpSyncAdapter(db, root, remote);
    throw new Error(`unsupported remote type: ${String((opts.remote as RemoteConfig).type)}`);
  }
  if (opts.replicaUrl) {
    return createLitestreamAdapter(db, root, {
      replicaUrl: opts.replicaUrl,
      execPath: opts.execPath,
      configPath: opts.configPath,
    });
  }

  throw new Error(
    'no team remote configured (run lore remote --hub <url>, --postgres, or <dir>) and no replica URL given',
  );
}

/**
 * Read-only probe of the configured remote for `memory_status`. Never throws:
 * an unreachable remote is reported, so an offline session keeps working.
 */
export async function probeRemote(
  db: DB,
  root: string,
  opts: { maxAgeMs?: number; timeoutMs?: number } = {},
): Promise<RemoteStatus> {
  const config = readConfig(root);
  if (!config?.remote) {
    return {
      configured: false,
      reachable: null,
      behind: null,
      behind_rows: null,
      main: null,
      checked_at: null,
      error: null,
    };
  }

  const remote = config.remote;
  const key = remoteKey(remote);
  const cached = statusCache.get(root);
  const maxAge = opts.maxAgeMs ?? STATUS_TTL_MS;
  if (cached && cached.key === key && Date.now() - cached.at <= maxAge) return cached.status;

  const timeoutMs = opts.timeoutMs ?? 5000;
  try {
    let bundle: Bundle;
    if (remote.type === 'dir') {
      bundle = readBundle(path.join(remote.path, `${config.repo_id}.lorebundle`));
    } else if (remote.type === 'postgres') {
      bundle = await pgReadBundle(postgresUrl(remote), config.repo_id);
    } else {
      const httpRemote = asHttpRemote(remote);
      if (!httpRemote) throw new Error(`unsupported remote type: ${String(remote.type)}`);
      const pulled = await httpPull(httpRemote, config.repo_id, {
        sinceSeq: config.hub_seq ?? 0,
        sinceAuthSeq: config.hub_auth_seq ?? 0,
        knownMain: config.hub_main ?? null,
        timeoutMs,
      });
      bundle = pulled.bundle;
    }
    const behind = behindCounts(db, bundle);
    const mainRef = bundle.refs.find((ref) => ref.name === 'main')?.commit_id ?? null;
    const status: RemoteStatus = {
      configured: true,
      reachable: true,
      behind: behind.commits,
      behind_rows: behind.rows,
      main: mainRef,
      checked_at: new Date().toISOString(),
      error: null,
    };
    setRemoteStatus(root, status, key);
    return status;
  } catch (error) {
    const status = unreachableStatus(error);
    setRemoteStatus(root, status, key);
    return status;
  }
}
