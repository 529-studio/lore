#!/usr/bin/env node
// Smoke test for bi-directional remote sync adapter (Litestream / storage target)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');

const work = mkdtempSync(path.join(tmpdir(), 'lore-sync-smoke-'));

try {
  const repoA = path.join(work, 'repoA');
  const repoB = path.join(work, 'repoB');
  const replicaFile = path.join(work, 'shared-replica.db');

  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });

  // Mock Litestream bash script
  const mockLitestreamPath = path.join(work, 'mock-litestream');
  const mockScript = `#!/usr/bin/env bash
if [ "$1" = "version" ]; then
  echo "litestream v0.3.13"
  exit 0
fi

if [ "$1" = "generations" ]; then
  echo "generation  created"
  echo "gen_abc123  2026-11-22T10:00:00Z"
  exit 0
fi

if [ "$1" = "replicate" ]; then
  echo "litestream: replication started successfully"
  exit 0
fi

if [ "$1" = "restore" ]; then
  shift
  OUT=""
  SRC=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -o)
        OUT="$2"
        shift 2
        ;;
      -config|-timestamp)
        shift 2
        ;;
      *)
        SRC="$1"
        shift
        ;;
    esac
  done
  SRC="\${SRC#file://}"
  if [ -n "$SRC" ] && [ -f "$SRC" ] && [ -n "$OUT" ]; then
    mkdir -p "$(dirname "$OUT")"
    cp "$SRC" "$OUT"
  fi
  exit 0
fi

exit 0
`;
  writeFileSync(mockLitestreamPath, mockScript, 'utf8');
  chmodSync(mockLitestreamPath, 0o755);

  function lore(repoPath, args, extraEnv = {}) {
    const res = spawnSync(process.execPath, [CLI, ...args], {
      cwd: repoPath,
      encoding: 'utf8',
      env: {
        ...process.env,
        LORE_LITESTREAM_PATH: mockLitestreamPath,
        LORE_TRUST_MODE: 'permissive',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        ...extraEnv,
      },
    });
    if (res.status !== 0) {
      throw new Error(
        `Command failed (code ${res.status}): lore ${args.join(' ')}\nSTDOUT: ${res.stdout}\nSTDERR: ${res.stderr}`,
      );
    }
    return res;
  }

  // Set up repo workspaces with sample project files
  mkdirSync(path.join(repoA, 'src'), { recursive: true });
  writeFileSync(path.join(repoA, 'src', 'api.ts'), 'export const apiKey = process.env.API_KEY;\n', 'utf8');
  writeFileSync(path.join(repoA, 'package.json'), JSON.stringify({ name: 'repo-a', dependencies: {} }, null, 2), 'utf8');

  mkdirSync(path.join(repoB, 'src'), { recursive: true });
  writeFileSync(path.join(repoB, 'src', 'api.ts'), 'export const apiKey = process.env.API_KEY;\n', 'utf8');
  writeFileSync(path.join(repoB, 'package.json'), JSON.stringify({ name: 'repo-b', dependencies: {} }, null, 2), 'utf8');

  // Initialize both repositories
  lore(repoA, ['init']);
  lore(repoB, ['init']);

  // Configure replica URL in both
  lore(repoA, ['replicate', 'config', '--replica', `file://${replicaFile}`]);
  lore(repoB, ['replicate', 'config', '--replica', `file://${replicaFile}`]);
  console.log('[OK] Setup: Repo A and Repo B initialized with replica configuration');

  // Scenario 1: Additive multi-node convergence
  lore(repoA, [
    'write',
    '--subject',
    'env:API_KEY',
    '--predicate',
    'read_by',
    '--object',
    'src/api.ts',
    '--kind',
    'file',
    '--ref',
    'src/api.ts',
  ]);
  lore(repoA, ['promote']);
  lore(repoA, ['sync']);

  // Simulate Litestream replication by updating shared replica db
  copyFileSync(path.join(repoA, '.lore', 'lore.db'), replicaFile);

  lore(repoB, [
    'write',
    '--subject',
    'sym:lib.ts#auth',
    '--predicate',
    'enforces_invariant',
    '--object',
    'token validation',
    '--kind',
    'agent',
  ]);
  lore(repoB, ['promote']);
  lore(repoB, ['sync']);

  // Verify Repo B has Fact 1 and Fact 2
  const searchB1 = lore(repoB, ['search', 'API_KEY']);
  assert.match(searchB1.stdout, /env:API_KEY/);
  const searchB2 = lore(repoB, ['search', 'auth']);
  assert.match(searchB2.stdout, /sym:lib\.ts#auth/);

  // Simulate Litestream replication from Repo B to shared replica
  copyFileSync(path.join(repoB, '.lore', 'lore.db'), replicaFile);

  // Repo A syncs to pull Fact 2
  lore(repoA, ['sync']);

  // Verify Repo A has Fact 2 and Fact 1
  const searchA1 = lore(repoA, ['search', 'auth']);
  assert.match(searchA1.stdout, /sym:lib\.ts#auth/);
  const searchA2 = lore(repoA, ['search', 'API_KEY']);
  assert.match(searchA2.stdout, /env:API_KEY/);

  console.log('[OK] Scenario 1: Additive multi-node convergence passed');

  // Scenario 2: Cardinality-one conflict detection
  lore(repoA, [
    'write',
    '--subject',
    'pkg:demo',
    '--predicate',
    'declared_dependency',
    '--object',
    '1.0.0',
    '--kind',
    'file',
    '--ref',
    'package.json',
  ]);
  lore(repoA, ['promote']);

  lore(repoB, [
    'write',
    '--subject',
    'pkg:demo',
    '--predicate',
    'declared_dependency',
    '--object',
    '2.0.0',
    '--kind',
    'file',
    '--ref',
    'package.json',
  ]);
  lore(repoB, ['promote']);

  lore(repoA, ['sync']);
  copyFileSync(path.join(repoA, '.lore', 'lore.db'), replicaFile);
  lore(repoB, ['sync']);

  // Verify search in Repo B shows contested trust and warning
  const searchBConflictPlain = lore(repoB, ['search', 'pkg:demo']);
  assert.match(searchBConflictPlain.stdout, /memory contested: pkg:demo:declared_dependency/);

  const searchBConflictJson = lore(repoB, ['search', 'pkg:demo', '--json']);
  const parsedConflict = JSON.parse(searchBConflictJson.stdout);
  assert.equal(parsedConflict.hits.length, 0);
  assert.ok(parsedConflict.warnings.some((w) => w.includes('memory contested: pkg:demo:declared_dependency')));
  assert.ok(parsedConflict.contested.some((c) => c.subject === 'pkg:demo' && c.predicate === 'declared_dependency'));

  const dbB = new Database(path.join(repoB, '.lore', 'lore.db'), { readonly: true });
  const contestedClaims = dbB.prepare("SELECT * FROM claim WHERE subject_id = 'pkg:demo'").all();
  assert.equal(contestedClaims.length, 2);
  assert.ok(contestedClaims.every((c) => c.trust === 'contested'));
  const conflictRows = dbB.prepare("SELECT * FROM claim_conflict WHERE subject_id = 'pkg:demo'").all();
  assert.equal(conflictRows.length, 1);
  dbB.close();

  console.log('[OK] Scenario 2: Cardinality-one conflict detection passed');

  // Scenario 3: Action log inspection
  const dbAInspect = new Database(path.join(repoA, '.lore', 'lore.db'), { readonly: true });
  const dbBInspect = new Database(path.join(repoB, '.lore', 'lore.db'), { readonly: true });

  const actionsA = dbAInspect
    .prepare("SELECT * FROM agent_action_log WHERE action IN ('SYNC_OUTGOING', 'SYNC_INCOMING')")
    .all();
  const actionsB = dbBInspect
    .prepare("SELECT * FROM agent_action_log WHERE action IN ('SYNC_OUTGOING', 'SYNC_INCOMING')")
    .all();

  assert.ok(actionsA.some((r) => r.action === 'SYNC_OUTGOING' && r.table_name === 'memory_commit' && r.ts));
  assert.ok(actionsA.some((r) => r.action === 'SYNC_INCOMING' && r.table_name === 'memory_commit' && r.ts));

  assert.ok(actionsB.some((r) => r.action === 'SYNC_OUTGOING' && r.table_name === 'memory_commit' && r.ts));
  assert.ok(actionsB.some((r) => r.action === 'SYNC_INCOMING' && r.table_name === 'memory_commit' && r.ts));

  dbAInspect.close();
  dbBInspect.close();

  console.log('[OK] Scenario 3: Action log inspection passed');
  console.log('[OK] All end-to-end sync adapter smoke tests passed cleanly');
} finally {
  rmSync(work, { recursive: true, force: true });
}
