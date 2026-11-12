import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { scanText } from '../secrets.js';

export interface GuardOptions {
  staged?: boolean;
  path?: string;
  install?: boolean;
  force?: boolean;
}

const HOOK_MARKER = '# installed by lore guard --install';
const MAX_BYTES = 1024 * 1024;

function repoRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

function stagedFiles(root: string): string[] {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    cwd: root,
    encoding: 'utf8',
  });
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

function workingFiles(root: string, scope: string): string[] {
  let files: string[] = [];
  try {
    files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    files = [];
  }
  const prefix = scope === '.' ? '' : scope.replace(/^\.\//, '').replace(/\/$/, '');
  return files.filter((rel) => (prefix ? rel === prefix || rel.startsWith(`${prefix}/`) : true));
}

function allowlist(root: string): RegExp[] {
  const file = path.join(root, '.loresecretignore');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      try {
        return new RegExp(line);
      } catch {
        return null;
      }
    })
    .filter((re): re is RegExp => Boolean(re));
}

function contentOf(root: string, rel: string, staged: boolean): string | null {
  try {
    if (staged) {
      const text = execFileSync('git', ['show', `:${rel}`], { cwd: root, encoding: 'utf8', maxBuffer: MAX_BYTES });
      return text;
    }
    const abs = path.join(root, rel);
    if (!existsSync(abs) || statSync(abs).size > MAX_BYTES) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

export function guardCommand(opts: GuardOptions): void {
  const root = repoRoot();

  if (opts.install) {
    const hook = path.join(root, '.git', 'hooks', 'pre-commit');
    if (existsSync(hook)) {
      const current = readFileSync(hook, 'utf8');
      if (!current.includes(HOOK_MARKER) && !opts.force) {
        throw new Error(`a pre-commit hook already exists at ${hook}; re-run with --force to replace it`);
      }
    }
    writeFileSync(hook, `#!/bin/sh\n${HOOK_MARKER}\nexec lore guard --staged\n`);
    chmodSync(hook, 0o755);
    console.log(`${pc.green('✓')} installed ${hook}`);
    console.log(pc.dim('  the hook needs `lore` on PATH (npm i -g @529studio/lore)'));
    return;
  }

  const staged = Boolean(opts.staged);
  const files = staged ? stagedFiles(root) : workingFiles(root, opts.path ?? '.');
  const allowed = allowlist(root);

  let findings = 0;
  for (const rel of files) {
    const text = contentOf(root, rel, staged);
    if (!text || text.includes('\u0000')) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      for (const finding of scanText(lines[i])) {
        if (allowed.some((re) => re.test(finding.match))) continue;
        findings += 1;
        console.log(`${rel}:${i + 1}  ${pc.red(finding.kind)}  ${pc.dim(finding.masked)}`);
      }
    }
  }

  if (findings) {
    console.error(`\n[ERR] ${findings} potential secret(s) found${staged ? ' in the staged diff' : ''}`);
    console.error('  remove them, or add a justified regex to .loresecretignore');
    process.exitCode = 1;
    return;
  }

  console.log(pc.green(`[OK] no secrets in ${files.length} file(s)${staged ? ' (staged)' : ''}`));
}
