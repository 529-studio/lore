#!/usr/bin/env node
// Two-store regression for #189a: redact/purge tombstones and token revocations
// must survive push/fetch without resurrecting plaintext or deleted claims.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const work = mkdtempSync(path.join(tmpdir(), 'lore-tombstone-smoke-'));
const remoteDir = path.join(work, 'remote');
const aRoot = path.join(work, 'a');
const bRoot = path.join(work, 'b');
const PLAINTEXT = 'TOP-SECRET-PLAINTEXT-VALUE-9271';
const TEAM_SECRET = 'smoke-team-secret-tombstone-1234567890';

let failures = 0;
function fail(message) {
  console.error(`[ERR] ${message}`);
  failures += 1;
}
function check(cond, message) {
  if (!cond) fail(message);
  return cond;
}

function run(cwd, args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...env },
  });
  if (result.status !== 0) {
    throw new Error(`lore ${args.join(' ')} exited ${result.status}\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function runExpectFailure(cwd, args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...env },
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function openDb(root) {
  return new Database(path.join(root, '.lore', 'lore.db'));
}

function seedRepo(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: path.basename(root) }));
  writeFileSync(path.join(root, 'README.md'), '# Tombstone fixture\n');
}

function claimIdFor(root, subject) {
  const db = openDb(root);
  try {
    const row = db.prepare('SELECT id FROM claim WHERE subject_id = ?').get(subject);
    return row?.id ?? null;
  } finally {
    db.close();
  }
}

try {
  seedRepo(aRoot);
  seedRepo(bRoot);
  mkdirSync(remoteDir, { recursive: true });

  run(aRoot, ['init', '--solo', '--no-gitignore']);
  run(aRoot, ['init', '--solo', '--no-gitignore']); // idempotent
  run(aRoot, ['remote', remoteDir]);

  const subject = 'doc:notes.md';
  run(aRoot, ['write', '--subject', subject, '--predicate', 'has_section', '--object', PLAINTEXT, '--kind', 'human', '--ref', 'README.md'], {
    LORE_SESSION: 'seed',
  });
  const claimId = claimIdFor(aRoot, subject);
  if (!check(claimId, 'claim was not written to store A')) throw new Error('cannot continue without a claim id');

  run(aRoot, ['promote'], { LORE_SESSION: 'seed' });
  run(aRoot, ['attest', claimId, '--verdict', 'agree'], { LORE_SESSION: 'seed' });
  run(aRoot, ['push']);

  const repoId = run(aRoot, ['config', 'get', 'repo_id']).trim();
  if (!check(repoId.length > 0, 'store A has no repo_id')) throw new Error('cannot continue without a repo_id');

  run(bRoot, ['init', '--solo', '--no-gitignore']);
  run(bRoot, ['config', 'set', 'repo_id', repoId]);
  run(bRoot, ['remote', remoteDir]);
  run(bRoot, ['fetch']);

  let bDb = openDb(bRoot);
  const replicated = bDb.prepare('SELECT * FROM claim WHERE id = ?').get(claimId);
  const attestationCount = bDb.prepare('SELECT COUNT(*) AS n FROM attestation').get().n;
  bDb.close();
  check(Boolean(replicated), 'store B did not receive the claim');
  check(String(replicated?.object_json ?? '').includes(PLAINTEXT), 'store B lost the original plaintext before redaction');
  check(Number(attestationCount) === 1, `attestation did not propagate (got ${attestationCount})`);

  // --- Redaction propagates, and never leaves plaintext in the audit trail ---
  run(aRoot, ['redact', claimId, '--reason', 'smoke redaction'], { LORE_SESSION: 'seed' });
  run(aRoot, ['push']);
  run(bRoot, ['fetch']);

  bDb = openDb(bRoot);
  const redacted = bDb.prepare('SELECT object_json, state, trust FROM claim WHERE id = ?').get(claimId);
  const bLogs = bDb.prepare("SELECT previous_state, new_state FROM agent_action_log WHERE table_name = 'claim'").all();
  const bRedaction = bDb.prepare('SELECT * FROM redaction WHERE claim_id = ?').get(claimId);
  bDb.close();
  check(redacted?.object_json === '"[redacted]"', `redaction did not propagate (object=${redacted?.object_json})`);
  check(redacted?.state === 'retracted' && redacted?.trust === 'retracted', 'redacted claim is still live');
  check(Boolean(bRedaction), 'redaction record did not propagate');
  check(
    !JSON.stringify(bLogs).includes(PLAINTEXT),
    'store B audit log still contains the plaintext payload after redaction',
  );

  // A store written by an older version must be scrubbed on next open.
  const legacy = openDb(aRoot);
  legacy.prepare("DELETE FROM meta WHERE key = 'audit_scrub_v1'").run();
  legacy
    .prepare(
      "INSERT INTO agent_action_log (agent_id, action, table_name, row_id, ts, previous_state) VALUES ('legacy', 'UPDATE', 'claim', ?, datetime('now'), ?)",
    )
    .run(claimId, JSON.stringify({ subject_id: subject, predicate: 'has_section', object: PLAINTEXT }));
  legacy.close();
  run(aRoot, ['status']);
  const scrubbed = openDb(aRoot);
  const legacyRow = scrubbed
    .prepare("SELECT previous_state FROM agent_action_log WHERE agent_id = 'legacy' ORDER BY id DESC LIMIT 1")
    .get();
  scrubbed.close();
  check(
    !String(legacyRow?.previous_state ?? '').includes(PLAINTEXT),
    'migration did not scrub the legacy audit payload',
  );

  // --- Purge is permanent across both directions ---
  run(aRoot, ['purge', claimId, '--yes', '--reason', 'smoke purge']);
  run(aRoot, ['push']);
  run(bRoot, ['fetch']);

  bDb = openDb(bRoot);
  const purgedClaim = bDb.prepare('SELECT id FROM claim WHERE id = ?').get(claimId);
  const purgeAudit = bDb.prepare('SELECT * FROM purge_audit WHERE claim_id = ?').get(claimId);
  const orphanEvidence = bDb.prepare('SELECT COUNT(*) AS n FROM evidence WHERE claim_id = ?').get(claimId).n;
  const orphanEntries = bDb.prepare('SELECT COUNT(*) AS n FROM commit_entry WHERE claim_id = ?').get(claimId).n;
  bDb.close();
  check(!purgedClaim, 'purged claim was resurrected on store B');
  check(Boolean(purgeAudit), 'purge_audit did not propagate to store B');
  check(Number(orphanEvidence) === 0 && Number(orphanEntries) === 0, 'purge left dependent rows on store B');

  // B pushes its (stale) history back; A must not resurrect the claim.
  run(bRoot, ['push']);
  run(aRoot, ['fetch']);
  const aDb = openDb(aRoot);
  const resurrected = aDb.prepare('SELECT id FROM claim WHERE id = ?').get(claimId);
  const aOrphans = aDb.prepare('SELECT COUNT(*) AS n FROM commit_entry WHERE claim_id = ?').get(claimId).n;
  aDb.close();
  check(!resurrected, 'a stale peer push resurrected the purged claim on store A');
  check(Number(aOrphans) === 0, 'a stale peer re-added commit entries for the purged claim');

  // --- Token revocation travels with the bundle ---
  const token = run(aRoot, ['identity', 'issue', '--user', 'maintainer@smoke', '--role', 'maintainer', '--jti', 'smoke-jti-001'], {
    LORE_TEAM_SECRET: TEAM_SECRET,
  }).trim();
  check(token.split('.').length === 2, 'identity issue did not return a signed token');
  run(aRoot, ['identity', 'revoke', 'smoke-jti-001', '--reason', 'smoke compromise'], {
    LORE_TEAM_SECRET: TEAM_SECRET,
    LORE_TOKEN: token,
  });
  run(aRoot, ['push']);
  run(bRoot, ['fetch']);

  bDb = openDb(bRoot);
  const revocation = bDb.prepare('SELECT * FROM token_revocation WHERE jti = ?').get('smoke-jti-001');
  bDb.close();
  check(Boolean(revocation), 'token revocation did not propagate to store B');

  const rejected = runExpectFailure(
    bRoot,
    ['write', '--subject', 'doc:revoked.md', '--predicate', 'has_section', '--object', 'x', '--kind', 'human', '--ref', 'README.md'],
    { LORE_TEAM_SECRET: TEAM_SECRET, LORE_TOKEN: token },
  );
  check(rejected.code !== 0, 'peer store accepted a revoked token');
  check(
    `${rejected.stdout}${rejected.stderr}`.includes('revoked'),
    `expected a revocation error, got: ${rejected.stderr || rejected.stdout}`,
  );

  if (failures) {
    console.error(`[ERR] ${failures} tombstone sync check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('[OK] redaction, purge, audit scrub, attestation and token revocation propagate across two stores');
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
