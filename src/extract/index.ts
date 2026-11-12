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
const ISSUE_PATH_RE = /^(?:docs\/)?issues\/(\d+)[-_]?([^/]*)\.md$/i;

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

function addPackageJson(root: string, rel: string, text: string, out: Candidate[]): void {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  if (typeof pkg.name === 'string') {
    out.push({ subject: `pkg:${pkg.name}`, predicate: 'package_name', object: pkg.name });
  }
  if (typeof pkg.main === 'string') {
    out.push({ subject: `pkg:${String(pkg.name ?? 'unknown')}`, predicate: 'main_entry', object: pkg.main });
  }
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, version] of Object.entries(deps as Record<string, string>)) {
      out.push({
        subject: `pkg:${name}`,
        predicate: 'declared_dependency',
        object: `${version} (${section})`,
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
      });
    }
  }
  const bin = pkg.bin;
  if (typeof bin === 'string') {
    out.push({ subject: `pkg:${String(pkg.name ?? 'unknown')}`, predicate: 'provides_command', object: bin });
  } else if (bin && typeof bin === 'object') {
    for (const [name, target] of Object.entries(bin as Record<string, string>)) {
      out.push({ subject: `pkg:${String(pkg.name ?? 'unknown')}`, predicate: 'provides_command', object: `${name} -> ${target}` });
    }
  }
  const engines = pkg.engines;
  if (engines && typeof engines === 'object') {
    for (const [runtime, version] of Object.entries(engines as Record<string, string>)) {
      out.push({ subject: `pkg:${String(pkg.name ?? 'unknown')}`, predicate: 'requires_runtime', object: `${runtime} ${version}` });
    }
  }
  const keywords = pkg.keywords;
  if (Array.isArray(keywords)) {
    for (const keyword of keywords) {
      out.push({ subject: `pkg:${String(pkg.name ?? 'unknown')}`, predicate: 'has_keyword', object: String(keyword) });
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

function scanCode(root: string, rel: string, text: string, out: Candidate[]): void {
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

    if (base === 'package.json' && !rel.includes('/')) {
      const text = readText(root, rel);
      if (text) addPackageJson(root, rel, text, out);
    }

    if (base === 'Makefile' && !rel.includes('/')) {
      const text = readText(root, rel);
      if (text) {
        for (const m of text.matchAll(MAKE_TARGET_RE)) {
          const target = m[1];
          if (!target || target.startsWith('.')) continue;
          out.push({ subject: `file:${rel}`, predicate: 'has_make_target', object: target });
        }
      }
    }

    if (/^docker-compose.*\.(yml|yaml)$/.test(base) && !rel.includes('/')) {
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
        }

        const issue = rel.match(ISSUE_PATH_RE);
        if (issue) {
          const id = `issue:local:${issue[1]}`;
          if (title) out.push({ subject: id, predicate: 'title', object: title, confidence: 0.9, evidenceRef: rel });
          const status = text.match(STATUS_RE)?.[1];
          if (status) out.push({ subject: id, predicate: 'status', object: status, confidence: 0.9, evidenceRef: rel });
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
