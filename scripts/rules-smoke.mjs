#!/usr/bin/env node
// Smoke test for rich agent memory protocol rules and dynamic updates.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const work = mkdtempSync(path.join(tmpdir(), 'lore-rules-smoke-'));

function lore(args, env = {}, cwd = work) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

try {
  // --- Step 1: Test lore rules --print ---
  const printRes = lore(['rules', '--print']);
  if (printRes.code !== 0) throw new Error(`rules --print failed: ${printRes.stderr}`);
  if (!printRes.stdout.includes('<!-- lore:memory-protocol:start -->')) {
    throw new Error('rules --print missing start boundary comment');
  }
  if (!printRes.stdout.includes('Entity ID Conventions')) {
    throw new Error('rules --print missing entity ID conventions');
  }
  if (!printRes.stdout.includes('sym:<relative-path>#<name>')) {
    throw new Error('rules --print missing symbol format');
  }
  if (!printRes.stdout.includes('enforces_invariant')) {
    throw new Error('rules --print missing standard predicates');
  }

  // --- Step 2: Test creation in clean repository ---
  writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'rules-fixture' }));
  const initRules = lore(['rules']);
  if (initRules.code !== 0) throw new Error(`rules install failed: ${initRules.stderr}`);
  if (!initRules.stdout.includes('Created AGENTS.md')) {
    throw new Error(`expected Created AGENTS.md, got:\n${initRules.stdout}`);
  }

  const agentsContent = readFileSync(path.join(work, 'AGENTS.md'), 'utf8');
  if (!agentsContent.includes('## 11. Persistent memory protocol (Lore)')) {
    throw new Error('AGENTS.md missing protocol header');
  }
  if (!agentsContent.includes('### Standard Predicates')) {
    throw new Error('AGENTS.md missing standard predicates');
  }

  // --- Step 3: Test idempotency ---
  const secondRun = lore(['rules']);
  if (secondRun.code !== 0) throw new Error(`second rules run failed: ${secondRun.stderr}`);
  if (!secondRun.stdout.includes('already up to date')) {
    throw new Error(`expected already up to date, got:\n${secondRun.stdout}`);
  }

  // --- Step 4: Test update of legacy / outdated snippet ---
  const legacyContent = `# My Project\n\nSome rules.\n\n<!-- lore:memory-protocol:start -->\n## 11. Persistent memory protocol (Lore)\n- Task start: call memory_search\n<!-- lore:memory-protocol:end -->\n\n## Next Section\nMore rules.\n`;
  writeFileSync(path.join(work, 'AGENTS.md'), legacyContent, 'utf8');

  // Without --update, it should NOT overwrite
  const noUpdateRun = lore(['rules']);
  if (!noUpdateRun.stdout.includes('already up to date')) {
    throw new Error(`expected already up to date without update flag, got:\n${noUpdateRun.stdout}`);
  }
  const unupdatedContent = readFileSync(path.join(work, 'AGENTS.md'), 'utf8');
  if (!unupdatedContent.includes('Task start: call memory_search')) {
    throw new Error('file was unexpectedly modified without --update');
  }

  // With --update, it MUST replace the snippet while preserving surrounding sections
  const updateRun = lore(['rules', '--update']);
  if (updateRun.code !== 0) throw new Error(`rules --update failed: ${updateRun.stderr}`);
  if (!updateRun.stdout.includes('Updated autonomous memory protocol in AGENTS.md')) {
    throw new Error(`expected Updated autonomous memory protocol in AGENTS.md, got:\n${updateRun.stdout}`);
  }

  const updatedContent = readFileSync(path.join(work, 'AGENTS.md'), 'utf8');
  if (!updatedContent.includes('Entity ID Conventions')) {
    throw new Error('updated AGENTS.md missing Entity ID Conventions');
  }
  if (!updatedContent.includes('# My Project') || !updatedContent.includes('## Next Section')) {
    throw new Error('rules --update damaged surrounding content in AGENTS.md');
  }

  // --- Step 5: Test target with CLAUDE.md ---
  writeFileSync(path.join(work, 'CLAUDE.md'), '# Claude Rules\n\nLegacy.\n', 'utf8');
  const claudeRun = lore(['rules']);
  if (claudeRun.code !== 0) throw new Error(`rules claude failed: ${claudeRun.stderr}`);
  const claudeContent = readFileSync(path.join(work, 'CLAUDE.md'), 'utf8');
  if (!claudeContent.includes('<!-- lore:memory-protocol:start -->')) {
    throw new Error('CLAUDE.md missing injected protocol');
  }

  console.log('[OK] rules-smoke: all assertions passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
