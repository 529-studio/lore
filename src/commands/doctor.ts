import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import pc from 'picocolors';
import { parse as parseYaml } from 'yaml';
import { dbPathFor } from '../db.js';
import { activeAt, head } from '../model.js';
import { loadOntology } from '../ontology.js';
import { requireAction } from '../policy.js';
import { ONTOLOGY_TEMPLATE, SCHEMA } from '../schema.js';
import { findStateRoot, findWorkspaceRoot, stateDirFor } from '../scope.js';
import { promoteRef } from './promote.js';

export type DoctorStatus = 'ok' | 'warn' | 'err';

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  message: string;
  remediation?: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  json?: boolean;
  fix?: boolean;
  root?: string;
}

/** Tables the running code creates; a store missing one is not usable. */
const REQUIRED_TABLES = Array.from(
  SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/g),
  (match) => match[1],
);

/** Columns added by migrations; older stores lack them until a lore command opens them. */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  claim: [
    'trust',
    'ttl_days',
    'last_verified_at',
    'confirmations',
    'contradictions',
    'invalidated_by_json',
    'written_by',
    'agent_id',
    'session_id',
    'run_id',
    'tags_json',
  ],
  evidence: ['commit_id'],
  file_hash: ['workspace_id', 'ctime_ns'],
  memory_commit: ['merge_parent_id'],
  merge_decision: ['actor'],
  attestation: ['proof_json'],
};

interface McpConfig {
  agent: string;
  file: string;
  format: 'json' | 'toml';
}

const MCP_CONFIGS: McpConfig[] = [
  { agent: 'claude', file: '.mcp.json', format: 'json' },
  { agent: 'agy', file: '.agents/mcp_config.json', format: 'json' },
  { agent: 'codex', file: '.codex/config.toml', format: 'toml' },
  { agent: 'cursor', file: '.cursor/mcp.json', format: 'json' },
  { agent: 'gemini', file: '.gemini/settings.json', format: 'json' },
  { agent: 'opencode', file: 'opencode.json', format: 'json' },
];

const STATUS_LABEL: Record<DoctorStatus, string> = {
  ok: 'OK',
  warn: 'WARN',
  err: 'ERR',
};

function check(status: DoctorStatus, id: string, message: string, remediation?: string): DoctorCheck {
  return remediation ? { id, status, message, remediation } : { id, status, message };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when argv[0] resolution can find an executable named `name` on PATH. */
function binaryOnPath(name: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return true;
      } catch {
        // An unreadable PATH entry is not a hit; keep looking.
      }
    }
  }
  return false;
}

// --- narrow TOML validator -------------------------------------------------
// Doctor must report malformed configs without adding a TOML dependency. The
// parser accepts the shapes these configs use (tables, dotted keys, strings,
// numbers, booleans, arrays, inline tables, multiline strings) and returns a
// line-numbered error for everything else instead of throwing.

class TomlParseError extends Error {}

interface TomlDocument {
  /** Table headers and key paths seen so far, joined with dots. */
  paths: Set<string>;
}

function isTomlDateOrTime(token: string): boolean {
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))?)?$/.exec(
    token,
  );
  if (local) {
    const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = local;
    if (+month < 1 || +month > 12 || +day < 1) return false;
    if (+day > new Date(Date.UTC(+year, +month, 0)).getUTCDate()) return false;
    if (hour !== undefined && (+hour > 23 || +minute > 59 || +second > 60)) return false;
    if (offsetHour !== undefined && (+offsetHour > 23 || +offsetMinute > 59)) return false;
    return true;
  }
  const time = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(token);
  return Boolean(time) && +time![1] <= 23 && +time![2] <= 59 && +time![3] <= 60;
}

function validateToml(content: string): { ok: true; document: TomlDocument } | { ok: false; error: string } {
  let index = 0;
  let line = 1;
  const length = content.length;
  const paths = new Set<string>();
  const definedKeys = new Set<string>();
  const definedTables = new Set<string>();
  let tablePrefix = '';

  const fail = (message: string): never => {
    throw new TomlParseError(`${message} (line ${line})`);
  };
  const at = (offset = 0): string => content[index + offset] ?? '';
  const isSpace = (char: string): boolean => char === ' ' || char === '\t' || char === '\r';
  const advance = (): string => {
    const char = content[index++];
    if (char === '\n') line += 1;
    return char;
  };

  function skipSpaces(): void {
    while (index < length && isSpace(at())) index += 1;
  }

  function skipComment(): void {
    if (at() !== '#') return;
    while (index < length && at() !== '\n') index += 1;
  }

  function skipBlank(): void {
    for (;;) {
      skipSpaces();
      if (at() === '#') {
        skipComment();
      } else if (at() === '\n') {
        advance();
      } else {
        return;
      }
    }
  }

  function readBasicString(): string {
    if (at() !== '"') fail('expected string');
    index += 1;
    let value = '';
    while (index < length) {
      const char = advance();
      if (char === '"') return value;
      if (char === '\n') fail('unterminated string');
      if (char === '\\') {
        const escape = advance();
        if (escape === 'u' || escape === 'U') {
          const digits = escape === 'u' ? 4 : 8;
          for (let i = 0; i < digits; i += 1) {
            if (!/[0-9A-Fa-f]/.test(advance())) fail('invalid unicode escape');
          }
        } else if (!'"\\bfnrt/'.includes(escape)) {
          fail(`invalid escape \\${escape}`);
        }
        value += escape;
      } else {
        value += char;
      }
    }
    return fail('unterminated string');
  }

  function readLiteralString(): string {
    if (at() !== "'") fail('expected string');
    index += 1;
    let value = '';
    while (index < length) {
      const char = advance();
      if (char === "'") return value;
      if (char === '\n') fail('unterminated literal string');
      value += char;
    }
    return fail('unterminated literal string');
  }

  function readMultiline(quote: string): string {
    index += 3;
    const closing = quote.repeat(3);
    while (index < length) {
      if (content.startsWith(closing, index)) {
        index += 3;
        return '';
      }
      advance();
    }
    return fail('unterminated multiline string');
  }

  function readKeyPath(): string {
    const parts: string[] = [];
    for (;;) {
      skipSpaces();
      if (at() === '"') {
        // A quoted segment is one literal key: ["mcp_servers.lore"] is a single
        // key, while [mcp_servers."lore"] is the nested table. Escape dots so
        // boundaries survive the join without breaking nested quoted keys.
        parts.push(readBasicString().replace(/\\/g, '\\\\').replace(/\./g, '\\.'));
      } else if (at() === "'") {
        parts.push(readLiteralString().replace(/\\/g, '\\\\').replace(/\./g, '\\.'));
      } else {
        const match = /^[A-Za-z0-9_-]+/.exec(content.slice(index));
        if (!match) fail('expected a bare or quoted key');
        parts.push(match![0]);
        index += match![0].length;
      }
      skipSpaces();
      if (at() === '.') {
        index += 1;
        continue;
      }
      return parts.join('.');
    }
  }

  function readScalar(): void {
    const start = index;
    while (index < length && !/[,\]\}#\n]/.test(at())) advance();
    const token = content.slice(start, index).trim();
    if (!token) fail('missing value');
    if (token === 'true' || token === 'false') return;
    if (/^[+-]?(inf|nan)$/.test(token)) return;
    const decimal = '[+-]?(?:0|[1-9](?:_?[0-9])*)';
    if (new RegExp(`^${decimal}$`).test(token)) return;
    if (new RegExp(`^${decimal}\\.(?:[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?$`).test(token)) return;
    if (new RegExp(`^${decimal}[eE][+-]?[0-9](?:_?[0-9])*$`).test(token)) return;
    if (/^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/.test(token)) return;
    if (/^0o[0-7](?:_?[0-7])*$/.test(token)) return;
    if (/^0b[01](?:_?[01])*$/.test(token)) return;
    if (isTomlDateOrTime(token)) return;
    fail(`unsupported value "${token}"`);
  }

  function readArray(): void {
    index += 1;
    for (;;) {
      skipBlank();
      if (at() === ']') {
        index += 1;
        return;
      }
      if (index >= length) fail('unterminated array');
      readValue();
      skipBlank();
      if (at() === ',') {
        index += 1;
        continue;
      }
      if (at() === ']') {
        index += 1;
        return;
      }
      fail('expected "," or "]" in array');
    }
  }

  function readInlineTable(): void {
    index += 1;
    skipSpaces();
    if (at() === '}') {
      index += 1;
      return;
    }
    const seen = new Set<string>();
    for (;;) {
      const key = readKeyPath();
      if (seen.has(key)) fail(`duplicate key "${key}" in inline table`);
      seen.add(key);
      skipSpaces();
      if (at() !== '=') fail('expected "=" in inline table');
      index += 1;
      readValue();
      skipSpaces();
      if (at() === ',') {
        index += 1;
        skipSpaces();
        continue;
      }
      if (at() === '}') {
        index += 1;
        return;
      }
      fail('expected "," or "}" in inline table');
    }
  }

  function readValue(): void {
    skipSpaces();
    const char = at();
    if (char === '"') {
      if (content.startsWith('"""', index)) readMultiline('"');
      else readBasicString();
      return;
    }
    if (char === "'") {
      if (content.startsWith("'''", index)) readMultiline("'");
      else readLiteralString();
      return;
    }
    if (char === '[') return readArray();
    if (char === '{') return readInlineTable();
    readScalar();
  }

  function endOfLine(): void {
    skipSpaces();
    skipComment();
    if (index >= length) return;
    if (at() !== '\n') fail('unexpected content after value');
    advance();
  }

  try {
    for (;;) {
      skipBlank();
      if (index >= length) break;
      if (at() === '[') {
        index += 1;
        const isArrayTable = at() === '[';
        if (isArrayTable) index += 1;
        const name = readKeyPath();
        skipSpaces();
        if (at() !== ']') fail('unterminated table header');
        index += 1;
        if (isArrayTable) {
          if (at() !== ']') fail('unterminated array table header');
          index += 1;
        } else if (definedTables.has(name)) {
          fail(`duplicate table [${name}]`);
        }
        if (!isArrayTable) definedTables.add(name);
        tablePrefix = name;
        paths.add(name);
        endOfLine();
        continue;
      }
      const key = readKeyPath();
      skipSpaces();
      if (at() !== '=') fail(`expected "=" after key "${key}"`);
      index += 1;
      readValue();
      const fullKey = tablePrefix ? `${tablePrefix}.${key}` : key;
      if (definedKeys.has(fullKey)) fail(`duplicate key "${fullKey}"`);
      definedKeys.add(fullKey);
      paths.add(fullKey);
      endOfLine();
    }
    return { ok: true, document: { paths } };
  } catch (error) {
    if (error instanceof TomlParseError) return { ok: false, error: error.message };
    return { ok: false, error: errorText(error) };
  }
}

function tomlHasLoreServer(paths: Set<string>): boolean {
  const target = 'mcp_servers.lore';
  for (const entry of paths) {
    if (entry === target || entry.startsWith(`${target}.`)) return true;
  }
  return false;
}

function jsonHasLoreServer(config: unknown, agent: string): boolean {
  if (!config || typeof config !== 'object') return false;
  const record = config as Record<string, unknown>;
  if (agent === 'opencode') {
    const mcp = record.mcp;
    if (!mcp || typeof mcp !== 'object') return false;
    const servers = (mcp as Record<string, unknown>).servers;
    return Boolean(servers && typeof servers === 'object' && 'lore' in (servers as Record<string, unknown>));
  }
  const servers = record.mcpServers;
  return Boolean(servers && typeof servers === 'object' && 'lore' in (servers as Record<string, unknown>));
}

function skipJsoncTrivia(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    break;
  }
  return index;
}

/** OpenCode configs are JSONC: line/block comments and trailing commas are legal. */
function stripJsonc(text: string): { ok: true; text: string } | { ok: false; error: string } {
  let out = '';
  let index = 0;
  let inString = false;
  let escaped = false;
  while (index < text.length) {
    const char = text[index];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      let closed = false;
      while (index < text.length) {
        if (text[index] === '*' && text[index + 1] === '/') {
          index += 2;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) return { ok: false, error: 'unterminated block comment' };
      out += ' ';
      continue;
    }
    if (char === ',') {
      const next = skipJsoncTrivia(text, index + 1);
      if (next < text.length && (text[next] === '}' || text[next] === ']')) {
        index += 1;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return { ok: true, text: out };
}

function checkMcpConfig(root: string, config: McpConfig): DoctorCheck {
  const id = `mcp:${config.agent}`;
  const file = path.join(root, config.file);
  if (!existsSync(file)) {
    return check('warn', id, `${config.file} not configured`, `lore setup ${config.agent}`);
  }
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return check('err', id, `${config.file} is unreadable: ${errorText(error)}`, `chmod +r ${config.file}`);
  }
  if (config.format === 'toml') {
    const result = validateToml(text);
    if (!result.ok) {
      return check('err', id, `${config.file} is not valid TOML: ${result.error}`, `fix ${config.file} or rerun lore setup ${config.agent}`);
    }
    if (!tomlHasLoreServer(result.document.paths)) {
      return check('warn', id, `${config.file} has no [mcp_servers.lore] entry`, `lore setup ${config.agent}`);
    }
    return check('ok', id, `${config.file} is valid and registers mcp_servers.lore`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (config.agent === 'opencode') {
      const stripped = stripJsonc(text);
      if (!stripped.ok) {
        return check('err', id, `${config.file} is not valid JSONC: ${stripped.error}`, `fix ${config.file} or rerun lore setup ${config.agent}`);
      }
      try {
        parsed = JSON.parse(stripped.text);
      } catch {
        parsed = undefined;
      }
    }
    if (parsed === undefined) {
      return check('err', id, `${config.file} is not valid JSON: ${errorText(error)}`, `fix ${config.file} or rerun lore setup ${config.agent}`);
    }
  }
  if (!jsonHasLoreServer(parsed, config.agent)) {
    return check('warn', id, `${config.file} has no lore server entry`, `lore setup ${config.agent}`);
  }
  return check('ok', id, `${config.file} is valid and registers the lore server`);
}

// --- store and branch health ----------------------------------------------

interface StoreDiagnosis {
  checks: DoctorCheck[];
  db: Database.Database | null;
}

function diagnoseStore(root: string, storePath: string): StoreDiagnosis {
  const checks: DoctorCheck[] = [];
  if (!existsSync(storePath)) {
    checks.push(check('err', 'store.path', `store missing: ${storePath}`, 'lore init'));
    return { checks, db: null };
  }

  let db: Database.Database;
  try {
    db = new Database(storePath);
    const display = path.relative(root, storePath) || storePath;
    checks.push(check('ok', 'store.path', `${display} is readable (${statSync(storePath).size} bytes)`));
  } catch (error) {
    checks.push(check('err', 'store.path', `cannot open ${storePath}: ${errorText(error)}`, 'check file permissions and disk space'));
    return { checks, db: null };
  }

  try {
    const mode = String(db.pragma('journal_mode', { simple: true })).toLowerCase();
    if (mode === 'wal') {
      checks.push(check('ok', 'store.wal', 'journal_mode is WAL'));
    } else {
      checks.push(
        check('warn', 'store.wal', `journal_mode is ${mode}, not WAL`, 'run any lore command to reopen the store in WAL mode'),
      );
    }
  } catch (error) {
    checks.push(check('err', 'store.wal', `cannot read journal_mode: ${errorText(error)}`));
  }

  try {
    const result = db.pragma('quick_check', { simple: true });
    if (String(result).toLowerCase() === 'ok') {
      checks.push(check('ok', 'store.integrity', 'quick_check returned ok'));
    } else {
      checks.push(check('err', 'store.integrity', `quick_check reported: ${String(result)}`, 'back up .lore/lore.db and re-run lore init'));
    }
  } catch (error) {
    checks.push(check('err', 'store.integrity', `quick_check failed: ${errorText(error)}`, 'back up .lore/lore.db and re-run lore init'));
  }

  try {
    const present = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    const missingTables = REQUIRED_TABLES.filter((table) => !present.has(table));
    const missingColumns: string[] = [];
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      if (!present.has(table)) continue;
      const known = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
      );
      for (const column of columns) {
        if (!known.has(column)) missingColumns.push(`${table}.${column}`);
      }
    }
    if (missingTables.length || missingColumns.length) {
      const parts: string[] = [];
      if (missingTables.length) parts.push(`missing tables: ${missingTables.join(', ')}`);
      if (missingColumns.length) parts.push(`missing columns: ${missingColumns.join(', ')}`);
      checks.push(
        check('err', 'store.schema', `schema is older than this lore build (${parts.join('; ')})`, 'run lore status to migrate the store'),
      );
    } else {
      checks.push(
        check(
          'ok',
          'store.schema',
          `schema current (${REQUIRED_TABLES.length} tables, required columns present)`,
        ),
      );
    }
  } catch (error) {
    checks.push(check('err', 'store.schema', `schema inspection failed: ${errorText(error)}`, 'back up .lore/lore.db and re-run lore init'));
  }

  return { checks, db };
}

interface ParityCandidate {
  ref: string;
  claims: number;
}

function chooseBaseline(candidates: ParityCandidate[]): ParityCandidate | null {
  if (candidates.length === 1) return candidates[0];
  return candidates.find((candidate) => candidate.ref.startsWith('agent/onboard')) ?? null;
}

function diagnoseParity(root: string, db: Database.Database, fix: boolean): DoctorCheck {
  const mainClaims = activeAt(db, head(db, 'main')).size;
  if (mainClaims > 0) {
    return check('ok', 'parity', `main holds ${mainClaims} claims`);
  }

  const refs = db
    .prepare("SELECT name FROM ref WHERE name LIKE 'agent/%' ORDER BY name")
    .all() as Array<{ name: string }>;
  const candidates: ParityCandidate[] = [];
  for (const row of refs) {
    const claims = activeAt(db, head(db, row.name)).size;
    if (claims > 0) candidates.push({ ref: row.name, claims });
  }
  if (!candidates.length) {
    return check('ok', 'parity', 'main is empty and no session branch holds claims');
  }

  const largest = Math.max(...candidates.map((candidate) => candidate.claims));
  const leaders = candidates.filter((candidate) => candidate.claims === largest);
  const leaderText = leaders.map((candidate) => `${candidate.ref} (${candidate.claims} claims)`).join(', ');
  const base = `main has 0 claims while ${leaderText} holds the ingested baseline`;
  const remediation = 'lore promote from that session, or lore doctor --fix';

  if (!fix) return check('warn', 'parity', base, remediation);

  const target = chooseBaseline(candidates);
  if (!target) {
    return check(
      'warn',
      'parity',
      `${base}; --fix skipped because several branches hold claims and none is agent/onboard*`,
      'lore promote from the session that ran the ingest',
    );
  }

  let promotedAdd = 0;
  try {
    const principal = requireAction(root, 'promote');
    const author = `human:${principal.id}`;
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    const plan = promoteRef(db, root, target.ref, 'main', { dryRun: true, author });
    if (plan.mode === 'conflict' || plan.plan.retract.length > 0) {
      return check(
        'warn',
        'parity',
        `${base}; --fix could not promote ${target.ref} safely (${plan.mode}, ${plan.plan.retract.length} retractions)`,
        'lore promote from that session and resolve the conflict',
      );
    }
    promoteRef(db, root, target.ref, 'main', {
      author,
      message: `doctor: promote baseline ${target.ref} into main`,
    });
    promotedAdd = activeAt(db, head(db, 'main')).size;
  } catch (error) {
    return check('warn', 'parity', `${base}; --fix failed: ${errorText(error)}`, 'lore promote from that session');
  }

  return check('ok', 'parity', `promoted ${target.ref} into main (main now holds ${promotedAdd} claims)`);
}

function diagnoseOntology(root: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const file = path.join(root, 'lore.ontology.yml');
  if (!existsSync(file)) {
    checks.push(check('warn', 'ontology', 'lore.ontology.yml is missing; extractor predicates fall back to defaults', 'lore init'));
    return checks;
  }
  let required: string[] = [];
  try {
    const template = parseYaml(ONTOLOGY_TEMPLATE) as { predicates?: Record<string, unknown> };
    required = Object.keys(template.predicates ?? {});
  } catch {
    required = [];
  }
  const ontology = loadOntology(root);
  const missing = required.filter((predicate) => !ontology.known(predicate));
  if (missing.length) {
    const shown = missing.slice(0, 6).join(', ');
    const more = missing.length > 6 ? `, +${missing.length - 6} more` : '';
    checks.push(
      check('warn', 'ontology', `lore.ontology.yml is missing extractor predicates: ${shown}${more}`, 'add them to lore.ontology.yml; the template lists every default'),
    );
  } else {
    checks.push(check('ok', 'ontology', `ontology defines all ${required.length} extractor predicates`));
  }
  return checks;
}

function diagnoseHealth(db: Database.Database): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  try {
    const stale = (db.prepare("SELECT COUNT(*) AS n FROM claim WHERE state = 'active' AND trust = 'stale'").get() as {
      n: number;
    }).n;
    checks.push(
      stale
        ? check('warn', 'health.stale', `${stale} active claims are marked stale`, 'lore ingest to re-observe changed files, or lore verify --all')
        : check('ok', 'health.stale', 'no active claim is marked stale'),
    );
  } catch (error) {
    checks.push(check('err', 'health.stale', `cannot count stale claims: ${errorText(error)}`));
  }

  try {
    const mergeConflicts = (db.prepare('SELECT COUNT(*) AS n FROM merge_conflict WHERE resolved = 0').get() as {
      n: number;
    }).n;
    const claimConflicts = (db.prepare('SELECT COUNT(*) AS n FROM claim_conflict WHERE resolved = 0').get() as {
      n: number;
    }).n;
    const total = mergeConflicts + claimConflicts;
    checks.push(
      total
        ? check('warn', 'health.conflicts', `${total} unresolved conflicts (${mergeConflicts} merge, ${claimConflicts} claim)`, 'lore resolve --auto-semantic or lore canon resolve')
        : check('ok', 'health.conflicts', 'no unresolved conflicts'),
    );
  } catch (error) {
    checks.push(check('err', 'health.conflicts', `cannot count conflicts: ${errorText(error)}`));
  }
  return checks;
}

function render(checks: DoctorCheck[]): void {
  console.log(pc.bold('lore doctor'));
  const width = Math.max(...checks.map((item) => item.id.length), 4);
  for (const item of checks) {
    const label = `[${STATUS_LABEL[item.status]}]`.padEnd(6);
    const color = item.status === 'ok' ? pc.green : item.status === 'warn' ? pc.yellow : pc.red;
    console.log(`  ${color(label)} ${item.id.padEnd(width)}  ${item.message}`);
    if (item.remediation) console.log(`         ${' '.repeat(width)}  ${pc.dim(`remediation: ${item.remediation}`)}`);
  }
  const count = (status: DoctorStatus): number => checks.filter((item) => item.status === status).length;
  const summary = `doctor: ${count('ok')} OK, ${count('warn')} WARN, ${count('err')} ERR`;
  console.log(count('err') ? pc.red(summary) : count('warn') ? pc.yellow(summary) : pc.green(summary));
}

export function doctorCommand(opts: DoctorOptions = {}): void {
  const start = path.resolve(opts.root ?? process.cwd());
  const workspaceRoot = findStateRoot(start) ?? findWorkspaceRoot(start);
  const checks: DoctorCheck[] = [];

  let storePath: string | null = null;
  try {
    storePath = dbPathFor(workspaceRoot);
  } catch (error) {
    checks.push(check('err', 'store.path', `cannot resolve the state directory: ${errorText(error)}`, 'set LORE_STATE_DIR or worktree_mode=isolated'));
  }

  let db: Database.Database | null = null;
  let storeHealthy = false;
  if (storePath) {
    const store = diagnoseStore(workspaceRoot, storePath);
    checks.push(...store.checks);
    db = store.db;
    storeHealthy = store.checks.every((item) => item.status !== 'err');
  }

  if (db) {
    try {
      checks.push(diagnoseParity(workspaceRoot, db, Boolean(opts.fix) && storeHealthy));
    } catch (error) {
      checks.push(check('err', 'parity', `branch parity check failed: ${errorText(error)}`));
    }
  } else {
    checks.push(check('warn', 'parity', 'skipped because the store is not readable'));
  }

  for (const config of MCP_CONFIGS) checks.push(checkMcpConfig(workspaceRoot, config));

  checks.push(
    binaryOnPath('lore')
      ? check('ok', 'mcp.binary', 'lore is on PATH')
      : check(
          'warn',
          'mcp.binary',
          'lore is not on PATH; MCP configs that call "lore" will not start',
          'npm link (or npm install -g @529studio/lore), then re-run lore setup',
        ),
  );

  checks.push(...diagnoseOntology(workspaceRoot));
  if (db) {
    checks.push(...diagnoseHealth(db));
    db.close();
  } else {
    checks.push(check('warn', 'health.stale', 'skipped because the store is not readable'));
    checks.push(check('warn', 'health.conflicts', 'skipped because the store is not readable'));
  }

  const result: DoctorResult = { ok: checks.every((item) => item.status !== 'err'), checks };
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    render(checks);
  }
  if (!result.ok) process.exitCode = 1;
}
