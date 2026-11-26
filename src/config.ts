import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { stateDirFor } from './scope.js';
import { applyManifest, readManifest } from './manifest.js';

export type RemoteConfig =
  | { type: 'dir'; path: string }
  | { type: 'postgres'; url?: string; url_env?: string }
  | { type: 'hub'; url: string }
  | { type: 'http'; url: string; token_env?: string };

/** Human label for a remote; never prints credentials. */
export function remoteLabel(remote: RemoteConfig): string {
  if (remote.type === 'dir') return remote.path;
  if (remote.type === 'hub') return remote.url;
  if (remote.type === 'http') return `http  ${remote.url}${remote.token_env ? ` (token from $${remote.token_env})` : ''}`;
  return remote.url_env ? `postgres ($${remote.url_env})` : 'postgres';
}

export interface LitestreamConfig {
  replica_url: string;
  config_path?: string;
  retention?: string;
  sync_interval?: string;
}

export interface WalConfig {
  autocheckpoint_pages?: number;
  target_wal_size_kb?: number;
  auto_tune?: boolean;
}

export interface LoreConfig {
  /** Stable identity of the project, independent of any git remote. */
  repo_id: string;
  remote?: RemoteConfig;
  litestream?: LitestreamConfig;
  wal?: WalConfig;
  /** Last remote main commit seen by fetch/push, used for the ahead/behind line. */
  remote_main?: string | null;
  /** Last hub sequence and main seen by fetch/push, used for delta sync. */
  hub_seq?: number;
  hub_auth_seq?: number;
  hub_main?: string | null;
  trust_mode?: 'strict' | 'permissive';
  auto_approve?: boolean | number[];
  /** Linked worktrees share the primary store by default; `isolated` keeps their own `.lore`. */
  worktree_mode?: 'shared' | 'isolated';
  team_mode?: boolean;
  /**
   * Pull the team delta when an MCP session initializes. Default: on when a
   * remote is configured. A flaky network downgrades to a warning, never a
   * failed handshake.
   */
  auto_sync?: boolean;
  extractors?: string[];
  plugins?: string[];
  [key: string]: unknown;
}

const FILE = 'config.json';

/**
 * True when the committed manifest or a local store declares team mode. The
 * manifest wins and can never be disabled by a local config, so a clone cannot
 * downgrade a team repository to permissive single-user mode.
 */
export function declaresTeamMode(root: string): boolean {
  const manifest = readManifest(root);
  if (manifest?.team_mode === true) return true;
  return readConfig(root)?.team_mode === true;
}

export function configPath(root: string): string {
  return path.join(stateDirFor(root), FILE);
}

export function readConfig(root: string): LoreConfig | null {
  const file = configPath(root);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LoreConfig;
  } catch {
    return null;
  }
}

export function writeConfig(root: string, config: LoreConfig): void {
  mkdirSync(stateDirFor(root), { recursive: true });
  writeFileSync(configPath(root), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Create the repository identity on first use. A committed `.lore.yml` wins over
 * a random UUID; a local store that already belongs to another repo id is a
 * hard error rather than a silent split.
 */
export function ensureConfig(root: string): LoreConfig {
  const existing = readConfig(root);
  const manifest = readManifest(root);
  if (existing?.repo_id) {
    if (manifest && manifest.repo_id !== existing.repo_id) {
      throw new Error(
        `.lore/config.json repo_id ${existing.repo_id} does not match .lore.yml ${manifest.repo_id}; ` +
          'use a fresh clone or run `lore join` in an empty store',
      );
    }
    return existing;
  }
  const base: LoreConfig = { ...(existing ?? {}), repo_id: manifest?.repo_id ?? randomUUID() };
  const config = manifest ? applyManifest(base, manifest) : base;
  writeConfig(root, config);
  return config;
}
