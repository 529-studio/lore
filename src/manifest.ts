import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { LoreConfig, RemoteConfig } from './config.js';

/**
 * Committed, public-safe project manifest. Secrets never live here: a Postgres
 * remote names an environment variable, and `lore join` reads that variable at
 * fetch/push time.
 */
export interface LoreManifest {
  repo_id: string;
  team_mode?: boolean;
  remote?: RemoteConfig;
  extractors?: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function manifestPath(root: string): string {
  return path.join(root, '.lore.yml');
}

function invalid(message: string): never {
  throw new Error(`invalid .lore.yml: ${message}`);
}

function assertNoSecrets(value: unknown, where: string): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, `${where}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/password|secret|token|api[_-]?key/i.test(key)) {
      invalid(`${where ? `${where}.` : ''}${key} must not be committed; use an environment variable`);
    }
    assertNoSecrets(entry, `${where}.${key}`);
  }
}

function parseRemote(raw: unknown, root: string): RemoteConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('remote must be an object');
  const remote = raw as Record<string, unknown>;

  if (remote.type === 'postgres') {
    if (remote.url !== undefined) {
      invalid('postgres remote must use url_env, never a raw URL or credentials');
    }
    const env = remote.url_env;
    if (typeof env !== 'string' || !ENV_NAME.test(env)) {
      invalid('postgres remote needs url_env naming an environment variable');
    }
    return { type: 'postgres', url_env: env };
  }

  if (remote.type === 'dir') {
    const dir = remote.path;
    if (typeof dir !== 'string' || !dir.trim() || path.isAbsolute(dir)) {
      invalid('dir remote needs a relative path (absolute paths leak machine layout)');
    }
    return { type: 'dir', path: path.resolve(root, dir) };
  }

  if (remote.type === 'hub') {
    const url = remote.url;
    if (typeof url !== 'string') invalid('hub remote needs url');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      invalid('hub url is not a valid URL');
    }
    if (parsed.protocol !== 'https:') invalid('hub url must use https');
    if (parsed.username || parsed.password) invalid('hub url must not embed credentials');
    return { type: 'hub', url: parsed.toString() };
  }

  invalid(`unknown remote type ${String(remote.type)}`);
}

/**
 * Parse and validate `.lore.yml`. Returns null when absent; throws on invalid
 * or unsafe content so a clone never silently forks the team store.
 */
export function readManifest(root: string): LoreManifest | null {
  const file = manifestPath(root);
  if (!existsSync(file)) return null;

  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (error) {
    invalid(`cannot parse YAML (${(error as Error).message})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('expected a mapping');
  const doc = raw as Record<string, unknown>;
  assertNoSecrets(doc, '');

  const repoId = typeof doc.repo_id === 'string' ? doc.repo_id.trim() : '';
  if (!UUID.test(repoId)) invalid('repo_id must be the repository UUID');

  const manifest: LoreManifest = { repo_id: repoId };
  if (doc.team_mode !== undefined) {
    if (typeof doc.team_mode !== 'boolean') invalid('team_mode must be true or false');
    manifest.team_mode = doc.team_mode;
  }
  if (doc.remote !== undefined) manifest.remote = parseRemote(doc.remote, root);
  if (doc.extractors !== undefined) {
    if (!Array.isArray(doc.extractors) || !doc.extractors.every((e) => typeof e === 'string')) {
      invalid('extractors must be a list of names');
    }
    manifest.extractors = doc.extractors as string[];
  }
  return manifest;
}

/** Copy shared settings from the manifest into a local config. */
export function applyManifest(config: LoreConfig, manifest: LoreManifest): LoreConfig {
  const next: LoreConfig = { ...config, repo_id: manifest.repo_id };
  if (manifest.remote) next.remote = manifest.remote;
  if (manifest.team_mode !== undefined) next.team_mode = manifest.team_mode;
  if (manifest.extractors) next.extractors = manifest.extractors;
  return next;
}
