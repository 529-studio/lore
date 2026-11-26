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

function cleanText(raw: string, maxLen = 400): string {
  const clean = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= maxLen) return clean;
  const sliced = clean.slice(0, maxLen);
  const lastSpace = sliced.lastIndexOf(' ');
  return lastSpace > maxLen * 0.7 ? `${sliced.slice(0, lastSpace)}...` : `${sliced}...`;
}

function extractSectionBody(text: string, headingRe: RegExp, maxLen = 400): string | null {
  const match = headingRe.exec(text);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const nextHeading = rest.search(/\n##+\s+/);
  const rawBody = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const cleaned = cleanText(rawBody, maxLen);
  return cleaned.length > 5 ? cleaned : null;
}

function extractInlinePrefix(text: string, prefixRe: RegExp, maxLen = 400): string | null {
  const match = prefixRe.exec(text);
  if (!match || !match[1]) return null;
  const cleaned = cleanText(match[1], maxLen);
  return cleaned.length > 5 ? cleaned : null;
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

/** Which keys of a TOML table hold dependency arrays (`authors` must not be read). */
function pyDependencyArrayKey(section: string, key: string): boolean {
  if (section === 'project') return key === 'dependencies';
  if (section === 'build-system') return key === 'requires';
  return section === 'project.optional-dependencies';
}
const PY_QUOTED_RE = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;

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
      while (!body.includes(']') && i + 1 < lines.length) {
        i += 1;
        body += `\n${lines[i] ?? ''}`;
      }
      const close = body.indexOf(']');
      if (close !== -1) body = body.slice(0, close);
      for (const q of body.matchAll(PY_QUOTED_RE)) {
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

const PY_STDLIB = new Set([
  '__future__', '_thread', 'abc', 'aifc', 'argparse', 'array', 'ast', 'asyncio', 'atexit', 'base64',
  'bdb', 'binascii', 'bisect', 'builtins', 'bz2', 'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd',
  'code', 'codecs', 'codeop', 'collections', 'colorsys', 'compileall', 'concurrent', 'configparser',
  'contextlib', 'contextvars', 'copy', 'crypt', 'csv', 'ctypes', 'curses', 'datetime', 'dbm',
  'decimal', 'difflib', 'dis', 'doctest', 'email', 'encodings', 'ensurepip', 'enum', 'errno',
  'faulthandler', 'fcntl', 'filecmp', 'fileinput', 'fnmatch', 'fractions', 'ftplib', 'functools',
  'gc', 'getopt', 'getpass', 'gettext', 'glob', 'graphlib', 'grp', 'gzip', 'hashlib', 'heapq', 'hmac',
  'html', 'http', 'imaplib', 'imghdr', 'imp', 'importlib', 'inspect', 'io', 'ipaddress', 'itertools',
  'json', 'keyword', 'lib2to3', 'linecache', 'locale', 'logging', 'lzma', 'mailbox', 'mailcap',
  'marshal', 'math', 'mimetypes', 'mmap', 'modulefinder', 'msilib', 'msvcrt', 'multiprocessing',
  'netrc', 'nis', 'nntplib', 'numbers', 'operator', 'optparse', 'os', 'ossaudiodev', 'pathlib', 'pdb',
  'pickle', 'pickletools', 'pipes', 'pkgutil', 'platform', 'plistlib', 'poplib', 'posix', 'posixpath',
  'pprint', 'profile', 'pstats', 'pty', 'pwd', 'py_compile', 'pyclbr', 'pydoc', 'queue', 'quopri',
  'random', 're', 'readline', 'reprlib', 'resource', 'rlcompleter', 'runpy', 'sched', 'secrets',
  'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal', 'site', 'smtpd', 'smtplib', 'sndhdr',
  'socket', 'socketserver', 'spwd', 'sqlite3', 'ssl', 'stat', 'statistics', 'string', 'stringprep',
  'struct', 'subprocess', 'sunau', 'symtable', 'sys', 'sysconfig', 'syslog', 'tabnanny', 'tarfile',
  'telnetlib', 'tempfile', 'termios', 'textwrap', 'threading', 'time', 'timeit', 'tkinter', 'token',
  'tokenize', 'tomllib', 'trace', 'traceback', 'tracemalloc', 'tty', 'turtle', 'turtledemo', 'types',
  'typing', 'unicodedata', 'unittest', 'urllib', 'uu', 'uuid', 'venv', 'warnings', 'wave', 'weakref',
  'webbrowser', 'winreg', 'winsound', 'wsgiref', 'xdrlib', 'xml', 'xmlrpc', 'zipapp', 'zipfile',
  'zipimport', 'zlib', 'zoneinfo',
]);

const PY_MODULE_RE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;

function addPythonImport(rel: string, spec: string, out: Candidate[]): void {
  if (spec.startsWith('.') || !PY_MODULE_RE.test(spec)) return;
  const root = spec.split('.')[0] ?? '';
  if (!root || PY_STDLIB.has(root)) return;
  out.push({ subject: `file:${rel}`, predicate: 'imports_module', object: spec, confidence: 0.9 });
}

/** Non-relative `import x` / `from x import y`; relative and stdlib imports are noise. */
function scanPythonImports(rel: string, text: string, out: Candidate[]): void {
  // Docstrings hold usage examples, not imports. Strip them before line matching.
  const code = text.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '');
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
