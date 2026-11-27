import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loreConfigDir } from './env.js';

export interface StoredRepoCredential {
  token: string;
  updated_at: string;
}

export interface StoredHubCredential {
  token?: string;
  updated_at: string;
  repos?: Record<string, StoredRepoCredential>;
}

export interface CredentialsFile {
  version: 1;
  hubs: Record<string, StoredHubCredential>;
}

export function credentialsPath(): string {
  const override = process.env.LORE_CREDENTIALS_FILE?.trim();
  return override ? path.resolve(override) : path.join(loreConfigDir(), 'credentials.json');
}

export function normalizeHubUrl(raw: string): string {
  const parsed = new URL(raw);
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(loopback && process.env.LORE_HUB_ALLOW_INSECURE === '1')) {
    throw new Error('hub url must use https (set LORE_HUB_ALLOW_INSECURE=1 only for a local smoke test)');
  }
  if (parsed.username || parsed.password) {
    throw new Error('hub url must not embed credentials');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function maskToken(token: string): string {
  if (token.length <= 10) return '****';
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

export function readCredentials(file = credentialsPath()): CredentialsFile {
  if (!existsSync(file)) return { version: 1, hubs: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CredentialsFile>;
    if (!parsed || typeof parsed !== 'object' || !parsed.hubs || typeof parsed.hubs !== 'object') {
      return { version: 1, hubs: {} };
    }
    return { version: 1, hubs: parsed.hubs };
  } catch {
    return { version: 1, hubs: {} };
  }
}

export function writeCredentials(data: CredentialsFile, file = credentialsPath()): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort on platforms that ignore POSIX file modes.
  }
}

export function saveHubCredential(
  hubUrl: string,
  token: string,
  opts: { repoId?: string | null; file?: string } = {},
): { hub: string; file: string; repoId: string | null } {
  const normalized = normalizeHubUrl(hubUrl);
  const cleanToken = token.trim();
  if (!cleanToken) throw new Error('hub token cannot be empty');

  const file = opts.file ?? credentialsPath();
  const data = readCredentials(file);
  const now = new Date().toISOString();
  const existing = data.hubs[normalized] ?? { updated_at: now };

  if (opts.repoId) {
    existing.repos = {
      ...(existing.repos ?? {}),
      [opts.repoId]: { token: cleanToken, updated_at: now },
    };
    existing.updated_at = now;
  } else {
    existing.token = cleanToken;
    existing.updated_at = now;
  }

  data.hubs[normalized] = existing;
  writeCredentials(data, file);
  return { hub: normalized, file, repoId: opts.repoId ?? null };
}

export function removeHubCredential(
  hubUrl: string,
  opts: { repoId?: string | null; file?: string } = {},
): { hub: string; removed: boolean; file: string } {
  const parsed = new URL(hubUrl);
  const normalized = parsed.toString().replace(/\/$/, '');
  const file = opts.file ?? credentialsPath();
  const data = readCredentials(file);
  const entry = data.hubs[normalized];
  if (!entry) return { hub: normalized, removed: false, file };

  let removed = false;
  if (opts.repoId) {
    if (entry.repos && Object.hasOwn(entry.repos, opts.repoId)) {
      delete entry.repos[opts.repoId];
      removed = true;
      if (Object.keys(entry.repos).length === 0) delete entry.repos;
    }
    if (!entry.token && !entry.repos) delete data.hubs[normalized];
  } else {
    delete data.hubs[normalized];
    removed = true;
  }

  if (removed) writeCredentials(data, file);
  return { hub: normalized, removed, file };
}

export function lookupHubCredential(
  hubUrl: string,
  repoId?: string | null,
  file = credentialsPath(),
): string | null {
  let normalized: string;
  try {
    normalized = new URL(hubUrl).toString().replace(/\/$/, '');
  } catch {
    return null;
  }
  const data = readCredentials(file);
  const entry = data.hubs[normalized];
  if (!entry) return null;
  if (repoId && entry.repos?.[repoId]?.token) return entry.repos[repoId].token;
  return entry.token ?? null;
}
