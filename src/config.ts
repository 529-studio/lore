import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export type RemoteConfig =
  | { type: 'dir'; path: string }
  | { type: 'postgres'; url?: string; url_env?: string };

export interface LoreConfig {
  /** Stable identity of the project, independent of any git remote. */
  repo_id: string;
  remote?: RemoteConfig;
  /** Last remote main commit seen by fetch/push, used for the ahead/behind line. */
  remote_main?: string | null;
}

const DIR = '.lore';
const FILE = 'config.json';

export function configPath(root: string): string {
  return path.join(root, DIR, FILE);
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
  mkdirSync(path.join(root, DIR), { recursive: true });
  writeFileSync(configPath(root), `${JSON.stringify(config, null, 2)}\n`);
}

/** Create the repository identity on first use; never derive it from a git remote. */
export function ensureConfig(root: string): LoreConfig {
  const existing = readConfig(root);
  if (existing?.repo_id) return existing;
  const config: LoreConfig = { ...(existing ?? {}), repo_id: randomUUID() };
  writeConfig(root, config);
  return config;
}
