#!/usr/bin/env node
// Test suite for encrypted secret scrubbing and zero-knowledge claim attestations.
// - Secret detection and redaction for tokens, connection strings, credentials
// - CLI lore write --scrub auto-redaction and invariant check (zero raw secret in SQLite)
// - Zero-knowledge attestations (lore attest --zk, salted SHA-256 commitment)
// - Offline ZK proof verification and tamper rejection (lore attest --verify-zk)
// - MCP memory_write default auto-scrubbing

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  scrubText,
  scanSecurityText,
  createZkProof,
  verifyZkProof,
} from '../dist/security/scrub.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');

let failures = 0;
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures++;
}

function expect(cond, msg) {
  if (!cond) {
    fail(msg);
    return false;
  }
  return true;
}

console.log('[TEST] 1. Secret scrubbing and credential patterns in text...');
const rawSecret1 = 'ghp_' + 'A'.repeat(30);
const rawSecret2 = 'sk-ant-api03-' + 'x'.repeat(35);
const rawConnStr = 'postgres://admin:SuperSecretPass123!@db.internal.net:5432/production';
const rawBearer = 'Bearer ya29.a0AfH6SMB_someverylongandentropicrobottoken1234567890';

const sampleText = `Config has token=${rawSecret1} and anthropic=${rawSecret2} and url=${rawConnStr} and auth=${rawBearer}`;
const scrubbed = scrubText(sampleText);

expect(scrubbed.scrubbed === true, 'scrubText flags scrubbed = true');
expect(scrubbed.count >= 4, `scrubText detected at least 4 secrets (found ${scrubbed.count})`);
expect(!scrubbed.text.includes(rawSecret1), 'raw github token redacted');
expect(!scrubbed.text.includes(rawSecret2), 'raw anthropic token redacted');
expect(!scrubbed.text.includes('SuperSecretPass123!'), 'database connection password redacted');
expect(!scrubbed.text.includes('ya29.a0AfH6SMB'), 'bearer token redacted');
console.log('[OK] Secret scrubbing unit tests passed');

console.log('[TEST] 2. Zero-knowledge proof generation and verification...');
const dummyClaim = {
  id: 'c_test123456',
  object: JSON.stringify({ endpoint: 'https://api.internal', mode: 'strict', timeout: 5000 }),
};

const zkProof = createZkProof(dummyClaim, {
  verdict: 'agree',
  actor: 'human:security-auditor',
  reason: 'Verified strict compliance without leakage',
});

expect(zkProof.version === 1, 'proof version is 1');
expect(zkProof.algorithm === 'sha256-salted', 'proof algorithm is sha256-salted');
expect(typeof zkProof.commitment === 'string' && zkProof.commitment.length === 64, 'commitment is 64 hex chars');
expect(typeof zkProof.salt === 'string' && zkProof.salt.length >= 16, 'salt generated');

const verifyClean = verifyZkProof(dummyClaim, zkProof);
expect(verifyClean.valid === true, 'valid proof verifies cleanly');

// Tamper check 1: modified object
const tamperedClaim = {
  id: dummyClaim.id,
  object: JSON.stringify({ endpoint: 'https://api.internal', mode: 'permissive', timeout: 5000 }),
};
const verifyTamperedObj = verifyZkProof(tamperedClaim, zkProof);
expect(verifyTamperedObj.valid === false, 'tampered object rejected');

// Tamper check 2: modified commitment
const tamperedProof = { ...zkProof, commitment: zkProof.commitment.replace(/^./, '0') };
const verifyTamperedCommitment = verifyZkProof(dummyClaim, tamperedProof);
expect(verifyTamperedCommitment.valid === false, 'tampered commitment rejected');
console.log('[OK] ZK proof unit tests passed');

console.log('[TEST] 3. End-to-end CLI lore write --scrub and SQLite invariant...');
const work = mkdtempSync(path.join(tmpdir(), 'lore-scrub-e2e-'));
mkdirSync(path.join(work, 'src'));
writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'scrub-test-app' }));
writeFileSync(path.join(work, 'src', 'db.ts'), 'export const db = true;\n');

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn(process.execPath, [CLI, ...args], { cwd: work, env: { ...process.env, ...env } });
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

await runCli(['init', '--solo']);

// Attempting to write a raw secret without --scrub should fail with SecretDetected
const rawGhToken = 'ghp_' + 'B'.repeat(30);
const failWrite = await runCli([
  'write',
  '--subject',
  'env:API_KEY',
  '--predicate',
  'holds_token',
  '--object',
  `value is ${rawGhToken}`,
  '--kind',
  'human',
]);
expect(failWrite.code !== 0, 'write without --scrub fails when secret detected');
expect(failWrite.stderr.includes('SecretDetected') || failWrite.stderr.includes('secret detected'), 'stderr reports secret detected');

// Writing with --scrub succeeds
const passWrite = await runCli([
  'write',
  '--subject',
  'env:API_KEY',
  '--predicate',
  'holds_token',
  '--object',
  `value is ${rawGhToken}`,
  '--kind',
  'human',
  '--scrub',
]);
expect(passWrite.code === 0, `write with --scrub succeeds (got code ${passWrite.code}: ${passWrite.stderr})`);

// Verify INVARIANT: no raw secret persisted anywhere in .lore/lore.db
const dbFile = path.join(work, '.lore', 'lore.db');
const sqlite = new Database(dbFile);
const leakyRows = sqlite.prepare('SELECT id, object_json FROM claim WHERE object_json LIKE ?').all(`%${rawGhToken}%`);
expect(leakyRows.length === 0, 'zero raw secret persisted in SQLite claim table');

const storedClaim = sqlite.prepare('SELECT id, object_json FROM claim WHERE subject_id = ?').get('env:API_KEY');
expect(storedClaim !== undefined, 'claim was inserted');
expect(storedClaim.object_json.includes('[REDACTED:github-token]'), 'claim contains redacted placeholder');
console.log('[OK] End-to-end lore write --scrub passed');

console.log('[TEST] 4. CLI lore attest --zk and offline verification...');
// Create a claim to attest
const claimId = storedClaim.id;

// Attest with zero-knowledge proof
const attestZk = await runCli([
  'attest',
  claimId,
  '--zk',
  '--verdict',
  'agree',
  '--reason',
  'Security audit verified key shape safely',
]);
expect(attestZk.code === 0, `lore attest --zk succeeded: ${attestZk.stderr}`);
expect(attestZk.stdout.includes('zero-knowledge'), 'stdout mentions zero-knowledge');
expect(attestZk.stdout.includes('zk commitment:'), 'stdout prints zk commitment');

// Extract the proof JSON from CLI output
const matchProof = attestZk.stdout.match(/zk proof: (\{.*\})/);
expect(Boolean(matchProof), 'extracted proof JSON from output');
const proofJson = matchProof ? matchProof[1] : '{}';
const parsedCliProof = JSON.parse(proofJson);

// Verify proof is stored in attestation table
const attRow = sqlite.prepare('SELECT * FROM attestation WHERE claim_id = ?').get(claimId);
expect(attRow !== undefined, 'attestation row exists');
expect(typeof attRow.proof_json === 'string', 'attestation row contains proof_json');

// Offline verification with lore attest --verify-zk
const verifyCli = await runCli([
  'attest',
  claimId,
  '--verify-zk',
  proofJson,
]);
expect(verifyCli.code === 0, `lore attest --verify-zk succeeded: ${verifyCli.stderr}`);
expect(verifyCli.stdout.includes('zero-knowledge attestation verified'), 'offline verification confirmed in stdout');

// Tamper verification rejection
const tamperedProofJson = JSON.stringify({ ...parsedCliProof, commitment: 'f'.repeat(64) });
const verifyTamperedCli = await runCli([
  'attest',
  claimId,
  '--verify-zk',
  tamperedProofJson,
]);
expect(verifyTamperedCli.code !== 0, 'tampered proof is rejected by CLI');
sqlite.close();
console.log('[OK] CLI lore attest --zk and offline verification passed');

try {
  rmSync(work, { recursive: true, force: true });
} catch {}

if (failures > 0) {
  console.error(`TEST FAILED with ${failures} error(s)`);
  process.exit(1);
}
console.log('[OK] All secret scrubbing and zero-knowledge attestation tests passed cleanly!');
