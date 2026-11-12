// Docs budget and language lint.
// Lessons from ProjectKV: an always-loaded document costs its size on every task,
// and a 143 KB register is a defect, not an archive.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ALWAYS_LOADED = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md'];
const ALWAYS_TOTAL_LIMIT = 36 * 1024;
const ALWAYS_FILE_LIMIT = 16 * 1024;
const ON_DEMAND_LIMIT = 25 * 1024;

const VIETNAMESE = /[\u1EA0-\u1EF9\u0103\u0111\u01A1\u01B0\u00E0-\u00E3\u00E8-\u00EA\u00EC-\u00ED\u00F2-\u00F5\u00F9-\u00FA\u00FD]/;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

const files = execFileSync('git', ['ls-files', '*.md'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

let failed = false;
const fail = (message) => {
  failed = true;
  console.error(`[ERR] ${message}`);
};

let alwaysTotal = 0;
for (const file of files) {
  if (!existsSync(file)) continue;
  const size = statSync(file).size;
  const text = readFileSync(file, 'utf8');

  if (ALWAYS_LOADED.includes(file)) {
    alwaysTotal += size;
    if (size > ALWAYS_FILE_LIMIT) {
      fail(`${file} is ${(size / 1024).toFixed(1)} KB; always-loaded files must stay under 16 KB`);
    }
  } else if (size > ON_DEMAND_LIMIT) {
    fail(`${file} is ${(size / 1024).toFixed(1)} KB; on-demand docs must stay under 25 KB`);
  }

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (EMOJI.test(lines[i])) fail(`${file}:${i + 1} contains an emoji`);
    if (VIETNAMESE.test(lines[i]) && !file.endsWith('README.vi.md') && !file.startsWith('docs/i18n/')) {
      fail(`${file}:${i + 1} contains Vietnamese text; the codebase and docs are English`);
    }
  }
}

if (alwaysTotal > ALWAYS_TOTAL_LIMIT) {
  fail(`always-loaded docs total ${(alwaysTotal / 1024).toFixed(1)} KB; limit is 36 KB`);
}

if (failed) process.exit(1);
console.log(`[OK] docs-lint: ${files.length} markdown files, always-loaded ${(alwaysTotal / 1024).toFixed(1)} KB`);
