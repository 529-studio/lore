#!/usr/bin/env node
// Smoke test for remote sync dispatch: Litestream single-writer backup plus the
// http adapter selected from a configured lore-hub remote.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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

  // The mock hub lives in this process: spawnSync would block its event loop.
  function loreAsync(repoPath, args, extraEnv = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        cwd: repoPath,
        env: { ...process.env, LORE_TRUST_MODE: 'permissive', NO_COLOR: '1', FORCE_COLOR: '0', ...extraEnv },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('exit', (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`lore ${args.join(' ')} failed (${code}):\n${stdout}\n${stderr}`));
      });
    });
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

  // Scenario 4: a configured http remote selects HttpSyncAdapter, not Litestream.
  const httpRepoId = randomUUID();
  const sharedDir = path.join(work, 'hub-shared');
  mkdirSync(sharedDir, { recursive: true });

  const hubRepo = path.join(work, 'hub-repo');
  mkdirSync(path.join(hubRepo, 'src'), { recursive: true });
  writeFileSync(path.join(hubRepo, '.lore.yml'), `repo_id: ${httpRepoId}\n`);
  writeFileSync(path.join(hubRepo, 'package.json'), JSON.stringify({ name: 'hub-repo' }, null, 2), 'utf8');
  writeFileSync(path.join(hubRepo, 'src', 'auth.ts'), 'export const team = true;\n', 'utf8');
  lore(hubRepo, ['init']);
  lore(hubRepo, ['ingest']);
  lore(hubRepo, [
    'write',
    '--subject',
    'sym:src/auth.ts#team',
    '--predicate',
    'enforces_invariant',
    '--object',
    'team auth is hub-synced',
    '--kind',
    'file',
    '--ref',
    'src/auth.ts',
  ]);
  lore(hubRepo, ['promote']);
  lore(hubRepo, ['push', '--path', sharedDir]);
  const hubBundle = JSON.parse(readFileSync(path.join(sharedDir, `${httpRepoId}.lorebundle`), 'utf8'));
  const hubMain = hubBundle.refs.find((ref) => ref.name === 'main')?.commit_id ?? null;

  let pulls = 0;
  let pushes = 0;
  const hub = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/pull')) {
        pulls += 1;
        res.end(JSON.stringify({ bundle: hubBundle, main: hubMain, seq: pulls, auth_seq: 0 }));
        return;
      }
      if (req.url.endsWith('/push')) {
        pushes += 1;
        const pushedMain = body.bundle?.refs?.find((ref) => ref.name === 'main')?.commit_id ?? hubMain;
        res.end(JSON.stringify({ main: pushedMain, seq: pulls, auth_seq: 0 }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve));
  const hubUrl = `http://127.0.0.1:${hub.address().port}`;

  try {
    const clientRepo = path.join(work, 'hub-client');
    mkdirSync(clientRepo, { recursive: true });
    writeFileSync(path.join(clientRepo, '.lore.yml'), `repo_id: ${httpRepoId}\n`);
    writeFileSync(path.join(clientRepo, 'package.json'), JSON.stringify({ name: 'hub-client' }, null, 2), 'utf8');
    lore(clientRepo, ['init'], { LORE_LITESTREAM_PATH: '' });
    lore(clientRepo, ['remote', '--hub', hubUrl, '--token-env', 'LORE_HUB_TOKEN'], {
      LORE_HUB_ALLOW_INSECURE: '1',
      LORE_HUB_TOKEN: 'smoke-token',
      LORE_LITESTREAM_PATH: '',
    });

    const clientEnv = {
      LORE_HUB_ALLOW_INSECURE: '1',
      LORE_HUB_TOKEN: 'smoke-token',
      LORE_LITESTREAM_PATH: '',
    };
    const synced = await loreAsync(clientRepo, ['sync'], clientEnv);
    assert.match(synced.stdout, /sync:pull via http/);
    assert.match(synced.stdout, /\[OK\] pulled \d+ commits, [1-9]\d* claims/);
    assert.doesNotMatch(synced.stdout, /litestream/i);
    // Blame reads the store regardless of evidence freshness in this checkout.
    const found = await loreAsync(clientRepo, ['blame', 'sym:src/auth.ts#team'], clientEnv);
    assert.match(found.stdout, /sym:src\/auth\.ts#team/);
    assert.match(found.stdout, /team auth is hub-synced/);
    assert.ok(pulls >= 2, `expected pull before and during push, saw ${pulls}`);
    assert.equal(pushes, 1);
  } finally {
    await new Promise((resolve) => hub.close(resolve));
  }

  console.log('[OK] Scenario 4: http remote dispatches to HttpSyncAdapter');
  console.log('[OK] All end-to-end sync adapter smoke tests passed cleanly');
} finally {
  rmSync(work, { recursive: true, force: true });
}
