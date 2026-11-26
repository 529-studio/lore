import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export interface Candidate {
  subject: string;
  evidenceRef?: string;
  predicate: string;
  object: string;
  confidence?: number;
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.venv',
  '.venv-seg',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'coverage',
  '.lore',
  'vendor',
  'target',
  '.turbo',
  '.cache',
]);

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt',
  '.rb', '.php', '.cs', '.c', '.h', '.cpp', '.sh', '.yml', '.yaml', '.json', '.toml',
  '.md', '.sql', '.html', '.css',
]);

const MAX_BYTES = 512 * 1024;

export function listFiles(root: string): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    // git only knows about .gitignore; a fresh repo has none, so filter the
    // usual build/vendor directories ourselves.
    return out
      .split('\0')
      .filter(Boolean)
      .filter((rel) => !rel.split('/').some((part) => IGNORED_DIRS.has(part)));
  } catch {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          walk(abs);
        } else if (entry.isFile()) {
          files.push(path.relative(root, abs));
        }
      }
    };
    walk(root);
    return files;
  }
}

function readText(root: string, rel: string): string | null {
  if (!TEXT_EXT.has(path.extname(rel))) return null;
  const real = resolveInside(root, rel);
  if (!real) return null;
  try {
    return readFileSync(real, 'utf8');
  } catch {
    return null;
  }
}

/** Resolve a repository-relative path, refusing escapes, non-files and huge files. */
export function resolveInside(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  let real: string;
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
    real = realpathSync(abs);
  } catch {
    return null;
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
  try {
    const st = statSync(real);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
  } catch {
    return null;
  }
  return real;
}

export function hashFile(root: string, rel: string): string | null {
  const real = resolveInside(root, rel);
  if (!real) return null;
  try {
    return `sha256:${createHash('sha256').update(readFileSync(real)).digest('hex')}`;
  } catch {
    return null;
  }
}

const ENV_RE =
  /(?:process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]|os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)|os\.environ\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]|import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*))/g;
const IMPORT_RE = /^\s*(?:import|export)\s[^'";]*from\s*['"]([^'"]+)['"]/gm;
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const DECORATOR_ROUTE_RE = /@(?:app|router|api)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/gi;
const EXPRESS_ROUTE_RE = /\b(?:app|router)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/gi;
const MAKE_TARGET_RE = /^([A-Za-z0-9_.-]+):(?!=)/gm;
const COMPOSE_IMAGE_RE = /^\s*image:\s*(\S+)/gm;
const COMPOSE_PORT_RE = /^\s*-\s*["']?(\d{2,5}:\d{2,5})["']?\s*$/gm;
const HEADING_RE = /^##\s+(.+?)\s*$/gm;
const TITLE_RE = /^#\s+(.+?)\s*$/m;
const STATUS_RE = /^\s*Status:\s*(.+?)\s*$/im;
const ADR_PATH_RE = /(?:^|\/)(?:adr\/)?ADR-(\d+)[-_]?([^/]*)\.md$/i;
const LESSON_PATH_RE = /(?:^|\/)(?:docs\/)?lessons\/L(\d+)[-_]?([^/]*)\.md$/i;
const ISSUE_PATH_RE = /^(?:docs\/)?issues\/(\d+)[-_]?([^/]*)\.md$/i;
const AGENTS_RULE_DOC_RE = /(?:^|\/)(?:AGENTS|CLAUDE|ARCHITECTURE|CONTRIBUTING|RULES)\.md$/i;
const NUMBERED_RULE_HEADING_RE = /^##\s+(\d+\.\s*.+?)\s*$/gm;
const LESSONS_LOG_RE =
  /(?:^|\/)(?:lessons?-learned|lessons|learnings|retrospectives?|postmortems?|incidents?)\.md$/i;

/**
 * Rule prose is capped generously: a 400-character cut used to sever the
 * rationale from the rule itself, which is exactly the part a later agent
 * needs. The cap only guards against a whole-document paste.
 */
const RULE_MAX_LEN = 1200;

function cleanText(raw: string, maxLen = RULE_MAX_LEN): string {
  const clean = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= maxLen) return clean;
  const sliced = clean.slice(0, maxLen);
  const lastSpace = sliced.lastIndexOf(' ');
  return lastSpace > maxLen * 0.7 ? `${sliced.slice(0, lastSpace)}...` : `${sliced}...`;
}

/** Level of a markdown heading line (`## x` -> 2), or 0 for anything else. */
function headingLevel(line: string): number {
  const m = /^(#{1,6})\s+/.exec(line);
  return m?.[1]?.length ?? 0;
}

interface Fence {
  char: string;
  length: number;
}

/** Opening code fence: the marker character and its full run length. */
function fenceOpen(line: string): Fence | null {
  const m = /^(`{3,}|~{3,})/.exec(line.trimStart());
  const marker = m?.[1];
  return marker ? { char: marker[0] ?? '`', length: marker.length } : null;
}

/** A closing fence uses the same character and at least the opening length. */
function isFenceClose(line: string, fence: Fence): boolean {
  const trimmed = line.trim();
  if (trimmed.length < fence.length) return false;
  for (const ch of trimmed) if (ch !== fence.char) return false;
  return true;
}

/** Drop fenced code blocks so examples are never read as rules or headings. */
function stripFencedBlocks(text: string): string {
  const out: string[] = [];
  let fence: Fence | null = null;
  for (const line of text.split('\n')) {
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }
    const open = fenceOpen(line);
    if (open) {
      fence = open;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Offset of the first heading at `level` or above in `text`, skipping fenced
 * code blocks. A `##` body therefore keeps its nested `###` subsections while
 * the following `##` still ends it.
 */
function nextHeadingIndex(text: string, level: number): number {
  let offset = 0;
  let fence: Fence | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (fence) {
      if (isFenceClose(trimmed, fence)) fence = null;
    } else {
      const open = fenceOpen(trimmed);
      if (open) {
        fence = open;
      } else {
        const found = headingLevel(trimmed);
        if (found > 0 && found <= level) return offset;
      }
    }
    offset += line.length + 1;
  }
  return -1;
}

/**
 * Body of the first heading matched by `headingRe`, cut at the next heading of
 * the same or a higher level. Nested `###` rules under `## <N>.` survive.
 */
function extractSectionBody(text: string, headingRe: RegExp, maxLen = RULE_MAX_LEN): string | null {
  const match = headingRe.exec(text);
  if (!match) return null;
  const level = headingLevel(text.slice(match.index, match.index + 8)) || 2;
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const nextHeading = nextHeadingIndex(rest, level);
  const rawBody = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const cleaned = cleanText(rawBody, maxLen);
  return cleaned.length > 5 ? cleaned : null;
}

function extractInlinePrefix(text: string, prefixRe: RegExp, maxLen = 800): string | null {
  const match = prefixRe.exec(text);
  if (!match || !match[1]) return null;
  const cleaned = cleanText(match[1], maxLen);
  return cleaned.length > 5 ? cleaned : null;
}

interface MarkdownHeading {
  index: number;
  level: number;
  title: string;
}

/** Headings outside fenced code blocks, in document order. */
function markdownHeadings(text: string): MarkdownHeading[] {
  const out: MarkdownHeading[] = [];
  let offset = 0;
  let fence: Fence | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (fence) {
      if (isFenceClose(trimmed, fence)) fence = null;
    } else {
      const open = fenceOpen(trimmed);
      if (open) {
        fence = open;
      } else {
        const m = /^(#{1,6})\s+(.+?)\s*$/.exec(trimmed);
        if (m?.[1] && m[2]) out.push({ index: offset, level: m[1].length, title: m[2] });
      }
    }
    offset += line.length + 1;
  }
  return out;
}

/** A heading that names a date, e.g. "2026-11-20 — Retry storm" or "Nov 20, 2026: ...". */
const DATED_HEADING_RE =
  /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/i;

/**
 * Entries of a lessons log: each dated heading and the body up to the next
 * heading of the same or a higher level. This is the shape teams use when the
 * file is not the numbered `docs/lessons/LNN` set.
 */
function datedLessonEntries(text: string): Array<{ title: string; body: string }> {
  const headings = markdownHeadings(text);
  const entries: Array<{ title: string; body: string }> = [];
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    if (!heading || !DATED_HEADING_RE.test(heading.title)) continue;
    const lineEnd = text.indexOf('\n', heading.index);
    const start = lineEnd === -1 ? text.length : lineEnd + 1;
    let end = text.length;
    for (let j = i + 1; j < headings.length; j += 1) {
      const next = headings[j];
      if (next && next.level <= heading.level) {
        end = next.index;
        break;
      }
    }
    entries.push({ title: heading.title, body: text.slice(start, end) });
  }
  return entries;
}

const LESSON_BLOCK_RE =
  /^\s*(?:#{2,6}\s+|\*\*|__)?\s*(Problem|What happened|Root cause|Why it happened|Why it was expensive|Prevention|Guardrail|Rule|Solution|Lesson)\b\s*[:.]?\s*(?:\*\*|__)?\s*/gim;

/** Problem / root-cause / prevention blocks inside one dated entry. */
function lessonBlocks(body: string): Array<{ label: string; text: string }> {
  const searchable = stripFencedBlocks(body);
  const matches = [...searchable.matchAll(LESSON_BLOCK_RE)];
  const blocks: Array<{ label: string; text: string }> = [];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const label = match?.[1];
    if (!match || !label) continue;
    const start = (match.index ?? 0) + match[0].length;
    const next = matches[i + 1];
    const end = next ? next.index ?? searchable.length : searchable.length;
    const text = cleanText(searchable.slice(start, end), RULE_MAX_LEN);
    if (text.length > 5) blocks.push({ label, text });
  }
  return blocks;
}

function lessonBlockPredicate(label: string): string {
  const value = label.toLowerCase();
  if (value === 'problem' || value === 'what happened') return 'has_known_bug';
  if (value === 'root cause' || value === 'why it happened' || value === 'why it was expensive') {
    return 'describes_issue';
  }
  return 'has_guardrail';
}

/** Lessons logs with dated entries: problem, root cause and prevention become claims. */
function addLessonsLog(rel: string, text: string, out: Candidate[]): void {
  for (const entry of datedLessonEntries(text)) {
    const id = `lesson:${slug(entry.title)}`;
    out.push({ subject: id, predicate: 'title', object: entry.title, confidence: 0.9, evidenceRef: rel });
    const blocks = lessonBlocks(entry.body);
    for (const block of blocks) {
      out.push({
        subject: id,
        predicate: lessonBlockPredicate(block.label),
        object: `${block.label}: ${block.text}`,
        confidence: 0.9,
        evidenceRef: rel,
      });
    }
    if (!blocks.length) {
      const body = cleanText(entry.body, RULE_MAX_LEN);
      if (body.length > 20) {
        out.push({
          subject: id,
          predicate: 'describes_issue',
          object: body,
          confidence: 0.85,
          evidenceRef: rel,
        });
      }
    }
  }
}

/** Stable, readable section id: lowercase, accents removed, punctuation collapsed. */
export function slug(text: string): string {
  const value = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return value || 'section';
}

function isRelativeOrBuiltin(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec.startsWith('~');
}

/** Manifest files are not extension-gated by TEXT_EXT (`go.mod`, `*.txt`). */
function readManifestText(root: string, rel: string): string | null {
  const real = resolveInside(root, rel);
  if (!real) return null;
  try {
    const buf = readFileSync(real);
    if (buf.length > MAX_BYTES) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/** PEP 503 normalisation: runs of `-`, `_` and `.` collapse to one `-`. */
function pythonPackageName(raw: string): string | null {
  const name = raw.trim().toLowerCase().replace(/[-_.]+/g, '-');
  return /^[a-z0-9][a-z0-9-]*$/.test(name) ? name : null;
}

/** One requirement line -> package name and version specifier. Malformed line -> null. */
function parseRequirement(raw: string): { name: string; spec: string } | null {
  let line = raw.split('#')[0]?.trim() ?? '';
  if (!line || line.startsWith('-')) return null; // options, -r/-e includes, index URLs
  line = line.split(';')[0]?.trim() ?? ''; // environment markers are not the declared version
  const at = line.indexOf(' @ ');
  if (at !== -1) line = line.slice(0, at).trim(); // PEP 508 direct reference
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([<>=!~].*)?$/.exec(line);
  if (!m || !m[1]) return null;
  const name = pythonPackageName(m[1]);
  if (!name) return null;
  const spec = (m[2] ?? '').replace(/\s+/g, ' ').trim() || '*';
  return { name, spec };
}

function addRequirementLines(rel: string, text: string, out: Candidate[]): void {
  for (const line of text.split(/\r?\n/)) {
    const req = parseRequirement(line);
    if (!req) continue;
    out.push({
      subject: `pkg:${req.name}`,
      predicate: 'declared_dependency',
      object: req.spec,
      evidenceRef: rel,
    });
  }
}

const PY_POETRY_DEP_SECTION_RE = /^tool\.poetry\.(?:group\.(?:"?[\w-]+"?\.))?(?:dev-)?dependencies$/;
const PY_QUOTED_RE = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;

/**
 * Inner text of a TOML array: stops at the first `]` outside a string and
 * drops comments, so `"uvicorn[standard]"` and `# "fake"` are not delimiters
 * or entries. Null while the array is still open on a later line.
 */
function tomlArrayInner(text: string): string | null {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && quote === '"') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '#') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) return null;
      out += '\n';
      i = nl;
      continue;
    }
    if (ch === ']') return out;
    out += ch;
  }
  return null;
}

/** Which keys of a TOML table hold dependency arrays (`authors` must not be read). */
function pyDependencyArrayKey(section: string, key: string): boolean {
  if (section === 'project') return key === 'dependencies';
  if (section === 'build-system') return key === 'requires';
  return section === 'project.optional-dependencies';
}

/** pyproject.toml: `[project] dependencies`, optional groups and Poetry tables only. */
function addPyproject(rel: string, text: string, out: Candidate[]): void {
  const lines = text.split(/\r?\n/);
  let section = '';
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = (header[1] ?? '').trim();
      continue;
    }
    const arrayKey = /^([\w.-]+)\s*=\s*\[/.exec(line);
    if (arrayKey && arrayKey[1] && pyDependencyArrayKey(section, arrayKey[1])) {
      let body = line.slice(line.indexOf('[') + 1);
      // A TOML array may span lines; an unterminated array reads to EOF.
      let inner = tomlArrayInner(body);
      while (inner === null && i + 1 < lines.length) {
        i += 1;
        body += `\n${lines[i] ?? ''}`;
        inner = tomlArrayInner(body);
      }
      if (inner === null) continue;
      for (const q of inner.matchAll(PY_QUOTED_RE)) {
        const entry = q[1] ?? q[2];
        if (!entry) continue;
        const req = parseRequirement(entry);
        if (!req) continue;
        out.push({
          subject: `pkg:${req.name}`,
          predicate: 'declared_dependency',
          object: req.spec,
          evidenceRef: rel,
        });
      }
      continue;
    }
    if (PY_POETRY_DEP_SECTION_RE.test(section)) {
      const entry = /^("?[\w.@/-]+"?)\s*=\s*(.+)$/.exec(line);
      if (!entry || !entry[1]) continue;
      const key = entry[1].replace(/^"|"$/g, '');
      if (key === 'python') continue; // runtime constraint, not a package
      const value = entry[2] ?? '';
      const version = /version\s*=\s*"([^"]*)"/.exec(value)?.[1] ?? (/^["']([^"']*)["']$/.test(value) ? value.slice(1, -1) : null);
      const name = pythonPackageName(key);
      if (!name) continue;
      out.push({
        subject: `pkg:${name}`,
        predicate: 'declared_dependency',
        object: version?.trim() || '*',
        evidenceRef: rel,
      });
    }
  }
}

/** go.mod `require` entries, single-line and block form. */
function addGoMod(rel: string, text: string, out: Candidate[]): void {
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('//')[0]?.trim() ?? '';
    if (!line) continue;
    if (!inBlock) {
      const single = /^require\s+(.+)$/.exec(line);
      if (!single || !single[1]) continue;
      if (single[1].trim() === '(') {
        inBlock = true;
        continue;
      }
      addGoRequire(rel, single[1], out);
      continue;
    }
    if (line === ')') {
      inBlock = false;
      continue;
    }
    addGoRequire(rel, line, out);
  }
}

function addGoRequire(rel: string, entry: string, out: Candidate[]): void {
  const parts = entry.trim().split(/\s+/);
  const mod = parts[0];
  const version = parts[1];
  if (!mod || !version || !/^v\d/.test(version) || mod.startsWith('(')) return;
  out.push({ subject: `pkg:${mod}`, predicate: 'declared_dependency', object: version, evidenceRef: rel });
}

/**
 * Top-level Python standard-library roots (3.8 through 3.15), unioned with
 * every name in `sys.stdlib_module_names`. Static on purpose: deriving it from
 * the local interpreter would make the claim set machine-dependent.
 */
const PY_STDLIB = new Set([
  '__future__', '_abc', '_aix_support', '_android_support', '_apple_support', '_ast',
  '_ast_unparse', '_asyncio', '_bisect', '_blake2', '_bz2', '_codecs', '_codecs_cn', '_codecs_hk',
  '_codecs_iso2022', '_codecs_jp', '_codecs_kr', '_codecs_tw', '_collections', '_collections_abc',
  '_colorize', '_compat_pickle', '_contextvars', '_csv', '_ctypes', '_curses', '_curses_panel',
  '_datetime', '_dbm', '_decimal', '_dummy_thread', '_elementtree', '_frozen_importlib',
  '_frozen_importlib_external', '_functools', '_gdbm', '_hashlib', '_heapq', '_hmac', '_imp',
  '_interpchannels', '_interpqueues', '_interpreters', '_io', '_ios_support', '_json', '_locale',
  '_lsprof', '_lzma', '_markupbase', '_math_integer', '_md5', '_multibytecodec',
  '_multiprocessing', '_opcode', '_opcode_metadata', '_operator', '_osx_support', '_overlapped',
  '_pickle', '_posixshmem', '_posixsubprocess', '_py_abc', '_py_warnings', '_pydatetime',
  '_pydecimal', '_pyio', '_pylong', '_pyrepl', '_queue', '_random', '_remote_debugging',
  '_scproxy', '_sha1', '_sha2', '_sha3', '_signal', '_sitebuiltins', '_socket', '_sqlite3',
  '_sre', '_ssl', '_stat', '_statistics', '_string', '_strptime', '_struct', '_suggestions',
  '_symtable', '_sysconfig', '_thread', '_threading_local', '_tkinter', '_tokenize',
  '_tracemalloc', '_types', '_typing', '_uuid', '_warnings', '_weakref', '_weakrefset', '_winapi',
  '_wmi', '_zoneinfo', '_zstd', 'abc', 'aifc', 'annotationlib', 'antigravity', 'argparse',
  'array', 'ast', 'asynchat', 'asyncio', 'asyncore', 'atexit', 'audioop', 'base64', 'bdb',
  'binascii', 'bisect', 'builtins', 'bz2', 'cProfile', 'calendar', 'cgi', 'cgitb', 'chunk',
  'cmath', 'cmd', 'code', 'codecs', 'codeop', 'collections', 'colorsys', 'compileall',
  'compression', 'concurrent', 'configparser', 'contextlib', 'contextvars', 'copy', 'copyreg',
  'crypt', 'csv', 'ctypes', 'curses', 'dataclasses', 'datetime', 'dbm', 'decimal', 'difflib',
  'dis', 'distutils', 'doctest', 'dummy_threading', 'email', 'encodings', 'ensurepip', 'enum',
  'errno', 'faulthandler', 'fcntl', 'filecmp', 'fileinput', 'fnmatch', 'fractions', 'ftplib',
  'functools', 'gc', 'genericpath', 'getopt', 'getpass', 'gettext', 'glob', 'graphlib', 'grp',
  'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'idlelib', 'imaplib', 'imghdr', 'imp',
  'importlib', 'inspect', 'io', 'ipaddress', 'itertools', 'json', 'keyword', 'lib2to3',
  'linecache', 'locale', 'logging', 'lzma', 'mailbox', 'mailcap', 'marshal', 'math', 'mimetypes',
  'mmap', 'modulefinder', 'msilib', 'msvcrt', 'multiprocessing', 'netrc', 'nis', 'nntplib', 'nt',
  'ntpath', 'nturl2path', 'numbers', 'opcode', 'operator', 'optparse', 'os', 'ossaudiodev',
  'pathlib', 'pdb', 'pickle', 'pickletools', 'pipes', 'pkgutil', 'platform', 'plistlib', 'poplib',
  'posix', 'posixpath', 'pprint', 'profile', 'profiling', 'pstats', 'pty', 'pwd', 'py_compile',
  'pyclbr', 'pydoc', 'pydoc_data', 'pyexpat', 'queue', 'quopri', 'random', 're', 'readline',
  'reprlib', 'resource', 'rlcompleter', 'runpy', 'sched', 'secrets', 'select', 'selectors',
  'shelve', 'shlex', 'shutil', 'signal', 'site', 'smtpd', 'smtplib', 'sndhdr', 'socket',
  'socketserver', 'spwd', 'sqlite3', 'ssl', 'stat', 'statistics', 'string', 'stringprep',
  'struct', 'subprocess', 'sunau', 'symtable', 'sys', 'sysconfig', 'syslog', 'tabnanny',
  'tarfile', 'telnetlib', 'tempfile', 'termios', 'textwrap', 'this', 'threading', 'time',
  'timeit', 'tkinter', 'token', 'tokenize', 'tomllib', 'trace', 'traceback', 'tracemalloc', 'tty',
  'turtle', 'turtledemo', 'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'uu', 'uuid',
  'venv', 'warnings', 'wave', 'weakref', 'webbrowser', 'winreg', 'winsound', 'wsgiref', 'xdrlib',
  'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib', 'zoneinfo',
]);

const PY_MODULE_RE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;

function addPythonImport(rel: string, spec: string, out: Candidate[]): void {
  if (spec.startsWith('.') || !PY_MODULE_RE.test(spec)) return;
  const root = spec.split('.')[0] ?? '';
  if (!root || PY_STDLIB.has(root)) return;
  out.push({ subject: `file:${rel}`, predicate: 'imports_module', object: spec, confidence: 0.9 });
}

/**
 * Drop triple-quoted strings (docstrings and multi-line literals) while keeping
 * their newlines, so usage examples are not read as imports. Escaped quotes do
 * not close the literal.
 */
function stripPythonTripleQuotes(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '"' && ch !== "'") {
      out += ch;
      i += 1;
      continue;
    }
    const delimiter = ch.repeat(3);
    if (!text.startsWith(delimiter, i)) {
      out += ch;
      i += 1;
      continue;
    }
    let j = i + 3;
    while (j < text.length) {
      if (text[j] === '\\') {
        j += 2;
        continue;
      }
      if (text.startsWith(delimiter, j)) {
        j += 3;
        break;
      }
      j += 1;
    }
    out += '\n'.repeat(text.slice(i, j).split('\n').length - 1);
    i = j;
  }
  return out;
}

/** Non-relative `import x` / `from x import y`; relative and stdlib imports are noise. */
function scanPythonImports(rel: string, text: string, out: Candidate[]): void {
  // Docstrings hold usage examples, not imports. Strip them before line matching.
  const code = stripPythonTripleQuotes(text);
  for (const raw of code.split(/\r?\n/)) {
    for (const part of raw.split(';')) {
      const line = part.split('#')[0]?.trim() ?? '';
      if (!line) continue;
      const imported = /^import\s+(.+)$/.exec(line);
      if (imported && imported[1]) {
        for (const module of imported[1].split(',')) {
          const spec = module.trim().split(/\s+as\s+/)[0]?.trim();
          if (spec) addPythonImport(rel, spec, out);
        }
        continue;
      }
      const from = /^from\s+(\S+)\s+import\b/.exec(line);
      if (from && from[1]) addPythonImport(rel, from[1], out);
    }
  }
}

function addPackageJson(root: string, rel: string, text: string, out: Candidate[]): void {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  const self = typeof pkg.name === 'string' ? pkg.name : 'unknown';
  if (typeof pkg.name === 'string') {
    out.push({ subject: `pkg:${pkg.name}`, predicate: 'package_name', object: pkg.name, evidenceRef: rel });
  }
  if (typeof pkg.main === 'string') {
    out.push({ subject: `pkg:${self}`, predicate: 'main_entry', object: pkg.main, evidenceRef: rel });
  }
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, version] of Object.entries(deps as Record<string, string>)) {
      out.push({
        subject: `pkg:${name}`,
        predicate: 'declared_dependency',
        object: `${version} (${section})`,
        evidenceRef: rel,
      });
    }
  }
  const scripts = pkg.scripts;
  if (scripts && typeof scripts === 'object') {
    for (const [name, cmd] of Object.entries(scripts as Record<string, string>)) {
      out.push({
        subject: `file:${rel}`,
        predicate: 'defines_script',
        object: `${name} -> ${cmd}`,
        evidenceRef: rel,
      });
    }
  }
  const bin = pkg.bin;
  if (typeof bin === 'string') {
    out.push({ subject: `pkg:${self}`, predicate: 'provides_command', object: bin, evidenceRef: rel });
  } else if (bin && typeof bin === 'object') {
    for (const [name, target] of Object.entries(bin as Record<string, string>)) {
      out.push({ subject: `pkg:${self}`, predicate: 'provides_command', object: `${name} -> ${target}`, evidenceRef: rel });
    }
  }
  const engines = pkg.engines;
  if (engines && typeof engines === 'object') {
    for (const [runtime, version] of Object.entries(engines as Record<string, string>)) {
      out.push({ subject: `pkg:${self}`, predicate: 'requires_runtime', object: `${runtime} ${version}`, evidenceRef: rel });
    }
  }
  const keywords = pkg.keywords;
  if (Array.isArray(keywords)) {
    for (const keyword of keywords) {
      out.push({ subject: `pkg:${self}`, predicate: 'has_keyword', object: String(keyword), evidenceRef: rel });
    }
  }
}

const RULE_RE = /\bid:\s*['"]([A-Z][A-Z0-9_-]{2,})['"][^{}]{0,200}?\btitle:\s*['"]([^'"]+)['"]/g;
const SEVERITY_RE = /\bseverity:\s*['"](info|low|medium|high|critical)['"]/;

/** Rule registries: { id: "DYN-001", title: "..." } — common shape in linters/scanners. */
function addRules(text: string, rel: string, out: Candidate[]): void {
  for (const m of text.matchAll(RULE_RE)) {
    const id = m[1];
    const title = m[2];
    if (!id || !title) continue;
    const block = text.slice(m.index ?? 0, (m.index ?? 0) + 400);
    const severity = block.match(SEVERITY_RE)?.[1];
    out.push({
      subject: `rule:${id}`,
      evidenceRef: rel,
      predicate: 'detects',
      object: severity ? `${title} (severity: ${severity})` : title,
      confidence: 0.95,
    });
  }
}

const IN_CODE_LORE_RE =
  /(?:^|\n)[ \t]*(?:\/\/|#|\/\*)[ \t]*lore:(invariant|rule|constraint|decision)[ \t]*:?[ \t]*([^\r\n]+)/gi;
const IN_CODE_KEYWORD_RE =
  /(?:^|\n)[ \t]*(?:\/\/|#|\/\*)[ \t]*(INVARIANT|RULE|CONSTRAINT|ARCHITECTURE)[ \t]*:?[ \t]*([^\r\n]+)/g;

function predicateForKeyword(keyword: string): string {
  const k = keyword.toLowerCase();
  if (k === 'invariant') return 'enforces_invariant';
  if (k === 'rule' || k === 'architecture') return 'defines_rule';
  if (k === 'constraint') return 'has_constraint';
  if (k === 'decision') return 'decides';
  return 'enforces_invariant';
}

function scanInvariants(rel: string, text: string, out: Candidate[]): void {
  const scanRegex = (re: RegExp) => {
    for (const m of text.matchAll(re)) {
      const keyword = m[1];
      const rawText = m[2];
      if (!keyword || !rawText) continue;
      const cleanBody = rawText
        .replace(/\*\/$/, '')
        .replace(/\*+$/, '')
        .trim();
      const cleaned = cleanText(cleanBody, 300);
      if (cleaned.length < 3) continue;

      const offset = (m.index ?? 0) + (m[0].startsWith('\n') ? 1 : 0);
      const line = (text.slice(0, offset).match(/\n/g) || []).length + 1;
      const predicate = predicateForKeyword(keyword);

      out.push({
        subject: `file:${rel}#L${line}`,
        predicate,
        object: cleaned,
        evidenceRef: rel,
        confidence: 0.95,
      });
    }
  };

  scanRegex(IN_CODE_LORE_RE);
  scanRegex(IN_CODE_KEYWORD_RE);
}

function scanCode(root: string, rel: string, text: string, out: Candidate[]): void {
  scanInvariants(rel, text, out);
  for (const m of text.matchAll(ENV_RE)) {
    const name = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    if (!name) continue;
    out.push({ subject: `env:${name}`, predicate: 'read_by', object: rel, confidence: 0.9 });
  }
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec || isRelativeOrBuiltin(spec)) continue;
    out.push({ subject: `file:${rel}`, predicate: 'imports_module', object: spec, confidence: 0.9 });
  }
  for (const m of text.matchAll(REQUIRE_RE)) {
    const spec = m[1];
    if (!spec || isRelativeOrBuiltin(spec)) continue;
    out.push({ subject: `file:${rel}`, predicate: 'imports_module', object: spec, confidence: 0.9 });
  }
  if (rel.endsWith('.py')) scanPythonImports(rel, text, out);
  const routes = new Set<string>();
  for (const m of text.matchAll(DECORATOR_ROUTE_RE)) routes.add(`${m[1].toUpperCase()} ${m[2]}`);
  for (const m of text.matchAll(EXPRESS_ROUTE_RE)) {
    const verb = m[1];
    const route = m[2];
    if (!verb || !route) continue;
    routes.add(`${verb.toUpperCase()} ${route}`);
  }
  for (const route of routes) {
    out.push({ subject: `file:${rel}`, predicate: 'exposes_route', object: route, confidence: 0.85 });
  }
}

export function extractAll(root: string): Candidate[] {
  const files = listFiles(root);
  const out: Candidate[] = [];

  for (const rel of files) {
    const base = path.basename(rel);

    if (base === 'package.json') {
      const text = readText(root, rel);
      if (text) addPackageJson(root, rel, text, out);
    }

    if (base === 'Makefile') {
      const text = readManifestText(root, rel);
      if (text) {
        for (const m of text.matchAll(MAKE_TARGET_RE)) {
          const target = m[1];
          if (!target || target.startsWith('.')) continue;
          out.push({ subject: `file:${rel}`, predicate: 'has_make_target', object: target });
        }
      }
    }

    if (/^docker-compose.*\.(yml|yaml)$/.test(base)) {
      const text = readText(root, rel);
      if (text) {
        for (const m of text.matchAll(COMPOSE_IMAGE_RE)) {
          out.push({ subject: `file:${rel}`, predicate: 'uses_image', object: m[1] });
        }
        for (const m of text.matchAll(COMPOSE_PORT_RE)) {
          out.push({ subject: `file:${rel}`, predicate: 'publishes_port', object: m[1] });
        }
      }
    }

    if (/^requirements[\w.-]*\.txt$/.test(base)) {
      const text = readManifestText(root, rel);
      if (text) addRequirementLines(rel, text, out);
    }

    if (base === 'pyproject.toml') {
      const text = readManifestText(root, rel);
      if (text) addPyproject(rel, text, out);
    }

    if (base === 'go.mod') {
      const text = readManifestText(root, rel);
      if (text) addGoMod(rel, text, out);
    }

    if (rel.endsWith('.md')) {
      const text = readText(root, rel);
      if (text) {
        const title = text.match(TITLE_RE)?.[1];
        if (title) {
          out.push({ subject: `doc:${rel}`, predicate: 'title', object: title, confidence: 0.85 });
        }
        for (const m of text.matchAll(HEADING_RE)) {
          const heading = m[1];
          out.push({ subject: `doc:${rel}`, predicate: 'has_section', object: heading, confidence: 0.8 });
          out.push({
            subject: `doc:${rel}#${slug(heading)}`,
            predicate: 'section_title',
            object: heading,
            confidence: 0.85,
          });
        }

        const adr = rel.match(ADR_PATH_RE);
        if (adr) {
          const id = `adr:${adr[1].padStart(3, '0')}`;
          if (title) out.push({ subject: id, predicate: 'title', object: title, confidence: 0.95, evidenceRef: rel });
          const status = text.match(STATUS_RE)?.[1];
          if (status) out.push({ subject: id, predicate: 'status', object: status, confidence: 0.95, evidenceRef: rel });
          for (const m of text.matchAll(HEADING_RE)) {
            out.push({ subject: id, predicate: 'has_section', object: m[1], confidence: 0.8, evidenceRef: rel });
          }
          const decision = extractSectionBody(text, /^##\s+Decision\b:?/im);
          if (decision) {
            out.push({ subject: id, predicate: 'decides', object: decision, confidence: 0.95, evidenceRef: rel });
          }
        }

        if (LESSONS_LOG_RE.test(rel)) addLessonsLog(rel, text, out);

        const lesson = rel.match(LESSON_PATH_RE);
        if (lesson) {
          const id = `lesson:L${lesson[1].padStart(2, '0')}`;
          if (title) out.push({ subject: id, predicate: 'title', object: title, confidence: 0.95, evidenceRef: rel });
          const rule =
            extractInlinePrefix(text, /\*\*(?:Guardrail|Rule|Solution)\.\*\*\s*([^\n]+(?:\n(?!\*\*)[^\n#]+)*)/i) ||
            extractSectionBody(text, /^##\s+(?:Guardrail|Rule|Solution)\b:?/im);
          if (rule) {
            out.push({ subject: id, predicate: 'defines_rule', object: rule, confidence: 0.95, evidenceRef: rel });
          }
          const issue =
            extractInlinePrefix(text, /\*\*(?:What happened|Problem|Context)\.\*\*\s*([^\n]+(?:\n(?!\*\*)[^\n#]+)*)/i) ||
            extractSectionBody(text, /^##\s+(?:What happened|Problem|Context)\b:?/im);
          if (issue) {
            out.push({ subject: id, predicate: 'describes_issue', object: issue, confidence: 0.9, evidenceRef: rel });
          }
        }

        const issue = rel.match(ISSUE_PATH_RE);
        if (issue) {
          const id = `issue:local:${issue[1]}`;
          if (title) out.push({ subject: id, predicate: 'title', object: title, confidence: 0.9, evidenceRef: rel });
          const status = text.match(STATUS_RE)?.[1];
          if (status) out.push({ subject: id, predicate: 'status', object: status, confidence: 0.9, evidenceRef: rel });
        }

        if (AGENTS_RULE_DOC_RE.test(rel)) {
          for (const m of text.matchAll(NUMBERED_RULE_HEADING_RE)) {
            const heading = m[1];
            if (!heading) continue;
            const headingEsc = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const ruleBody = extractSectionBody(text, new RegExp(`^##\\s+${headingEsc}`, 'm'));
            if (ruleBody) {
              out.push({
                subject: `doc:${rel}#${slug(heading)}`,
                predicate: 'defines_rule',
                object: ruleBody,
                confidence: 0.9,
                evidenceRef: rel,
              });
            }
          }
        }
      }
    }

    if (TEXT_EXT.has(path.extname(rel)) && !rel.endsWith('.md')) {
      const text = readText(root, rel);
      if (text) {
        scanCode(root, rel, text, out);
        if (/\.[cm]?[jt]sx?$/.test(rel)) addRules(text, rel, out);
      }
    }
  }

  return dedupe(out);
}

function dedupe(list: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of list) {
    const key = `${c.subject}\u0000${c.predicate}\u0000${c.object}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
