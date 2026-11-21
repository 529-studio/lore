#!/usr/bin/env node
// Smoke test for lore wrapup and session lifecycle management.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const work = mkdtempSync(path.join(tmpdir(), 'lore-wrapup-smoke-'));

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
  // --- Step 1: Initialise clean repository ---
  writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'wrapup-fixture' }));
  const initRes = lore(['init']);
  if (initRes.code !== 0) throw new Error(`init failed: ${initRes.stderr}`);

  // Clean session wrapup must succeed with 0 exit code
  const cleanWrapup = lore(['wrapup']);
  if (cleanWrapup.code !== 0) throw new Error(`clean wrapup failed: ${cleanWrapup.stderr}`);
  if (!cleanWrapup.stdout.includes('Nothing to wrap up') && !cleanWrapup.stdout.includes('clean')) {
    throw new Error(`expected clean session message, got:\n${cleanWrapup.stdout}`);
  }

  // --- Step 2: Write draft and test dry-run ---
  const initialSession = readFileSync(path.join(work, '.lore', 'session'), 'utf8').trim();
  const writeRes = lore([
    'write',
    '--subject',
    'sym:src/auth.ts#login',
    '--predicate',
    'enforces_invariant',
    '--object',
    'require MFA',
    '--kind',
    'agent',
  ]);
  if (writeRes.code !== 0) throw new Error(`write failed: ${writeRes.stderr}`);
  if (!writeRes.stdout.includes('draft')) {
    throw new Error(`expected draft state, got: ${writeRes.stdout}`);
  }

  // Test dry-run: must preview without changing state
  const dryRun = lore(['wrapup', '--dry-run']);
  if (dryRun.code !== 0) throw new Error(`dry-run failed: ${dryRun.stderr}`);
  if (!dryRun.stdout.includes('Drafts to approve:') || !dryRun.stdout.includes('sym:src/auth.ts#login')) {
    throw new Error(`dry run missing draft preview: ${dryRun.stdout}`);
  }
  if (!dryRun.stdout.includes('dry run: would approve 1 draft(s)')) {
    throw new Error(`dry run missing summary: ${dryRun.stdout}`);
  }

  // --- Step 3: Test non-interactive safety without --yes ---
  const noYesRun = lore(['wrapup']);
  if (noYesRun.code !== 0) throw new Error(`non-interactive run errored: ${noYesRun.stderr}`);
  if (!noYesRun.stdout.includes('Non-interactive environment')) {
    throw new Error(`expected Non-interactive environment warning, got:\n${noYesRun.stdout}`);
  }

  // --- Step 4: Execute wrapup with --yes ---
  const wrapupExec = lore(['wrapup', '--yes']);
  if (wrapupExec.code !== 0) throw new Error(`wrapup --yes failed: ${wrapupExec.stderr}`);
  if (!wrapupExec.stdout.includes('Approved 1 draft(s)')) {
    throw new Error(`wrapup missing approval confirmation:\n${wrapupExec.stdout}`);
  }
  if (!wrapupExec.stdout.includes('Rotated session')) {
    throw new Error(`wrapup missing session rotation:\n${wrapupExec.stdout}`);
  }

  // Verify session rotation occurred in .lore/session
  const newSession = readFileSync(path.join(work, '.lore', 'session'), 'utf8').trim();
  if (newSession === initialSession) {
    throw new Error(`session was not rotated: ${newSession} === ${initialSession}`);
  }

  // Verify claim is now active on main and retrievable via search
  const searchRes = lore(['search', 'MFA']);
  if (!searchRes.stdout.includes('sym:src/auth.ts#login')) {
    throw new Error(`search on main failed to retrieve approved claim:\n${searchRes.stdout}`);
  }

  // --- Step 5: Test nested session commands ---
  const sessionStatus = lore(['session', 'status']);
  if (sessionStatus.code !== 0) throw new Error(`session status failed: ${sessionStatus.stderr}`);
  if (!sessionStatus.stdout.includes(`session: ${newSession}`)) {
    throw new Error(`session status output mismatch:\n${sessionStatus.stdout}`);
  }

  const sessionRotate = lore(['session', 'rotate']);
  if (sessionRotate.code !== 0) throw new Error(`session rotate failed: ${sessionRotate.stderr}`);
  const rotatedAgain = readFileSync(path.join(work, '.lore', 'session'), 'utf8').trim();
  if (rotatedAgain === newSession) {
    throw new Error(`session rotate did not change id: ${rotatedAgain}`);
  }

  // Test alias session wrapup
  lore([
    'write',
    '--subject',
    'sym:src/db.ts#query',
    '--predicate',
    'enforces_invariant',
    '--object',
    'prepared statements only',
    '--kind',
    'agent',
  ]);
  const aliasWrapup = lore(['session', 'wrapup', '--yes']);
  if (aliasWrapup.code !== 0) throw new Error(`session wrapup alias failed: ${aliasWrapup.stderr}`);
  if (!aliasWrapup.stdout.includes('Approved 1 draft(s)')) {
    throw new Error(`session wrapup failed to approve:\n${aliasWrapup.stdout}`);
  }

  console.log('[OK] wrapup-smoke: all assertions passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
