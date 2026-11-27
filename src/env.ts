import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

export interface EnvLoadResult {
  file: string;
  exists: boolean;
  loaded: string[];
  skipped: string[];
  disabled: boolean;
}

const LORE_VAR = /^LORE_[A-Z0-9_]*$/;
let cachedStatus: EnvLoadResult | null = null;

/** Return the per-user Lore configuration directory (~/.config/lore or $XDG_CONFIG_HOME/lore). */
export function loreConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), '.config');
  return path.join(base, 'lore');
}

/** Return the path to the per-user Lore env file. */
export function loreEnvPath(): string {
  const override = process.env.LORE_ENV_FILE?.trim();
  return override ? path.resolve(override) : path.join(loreConfigDir(), 'env');
}

function unescapeDoubleQuoted(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\' || i + 1 >= raw.length) {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    i += 1;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === '"' || next === '\\' || next === '$') out += next;
    else out += `\\${next}`;
  }
  return out;
}

function parseValue(rawValue: string): string {
  const trimmed = rawValue.trimStart();
  if (!trimmed) return '';

  const quote = trimmed[0];
  if (quote === '"') {
    let i = 1;
    let escaped = false;
    while (i < trimmed.length) {
      const ch = trimmed[i];
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') return unescapeDoubleQuoted(trimmed.slice(1, i));
      i += 1;
    }
    return unescapeDoubleQuoted(trimmed.slice(1));
  }

  if (quote === "'") {
    const end = trimmed.indexOf("'", 1);
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }

  const inlineComment = trimmed.search(/\s+#/);
  const clean = inlineComment === -1 ? trimmed : trimmed.slice(0, inlineComment);
  return clean.trim();
}

/** Parse standard KEY=VALUE / export KEY="VALUE" lines while ignoring comments and blanks. */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
    if (!key) continue;
    result[key] = parseValue(rest ?? '');
  }
  return result;
}

/**
 * Load LORE_* variables from ~/.config/lore/env (or $XDG_CONFIG_HOME/lore/env)
 * without overwriting variables already present in process.env.
 */
export function loadLoreEnv(opts: { file?: string; force?: boolean } = {}): EnvLoadResult {
  const file = opts.file ? path.resolve(opts.file) : loreEnvPath();
  if (!opts.force && cachedStatus && cachedStatus.file === file) {
    return cachedStatus;
  }

  const exists = existsSync(file);
  if (process.env.LORE_NO_ENV_FILE === '1' || !exists) {
    cachedStatus = {
      file,
      exists,
      loaded: [],
      skipped: [],
      disabled: process.env.LORE_NO_ENV_FILE === '1',
    };
    return cachedStatus;
  }

  const parsed = parseEnvFile(readFileSync(file, 'utf8'));
  const loaded: string[] = [];
  const skipped: string[] = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (!LORE_VAR.test(key)) continue;
    if (Object.hasOwn(process.env, key)) {
      skipped.push(key);
      continue;
    }
    process.env[key] = value;
    loaded.push(key);
  }

  cachedStatus = { file, exists: true, loaded, skipped, disabled: false };
  return cachedStatus;
}

/** Return the startup env-load status, performing initial load if needed. */
export function getLoreEnvStatus(): EnvLoadResult {
  return cachedStatus ?? loadLoreEnv();
}
