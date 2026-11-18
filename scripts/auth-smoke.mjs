#!/usr/bin/env node
// Smoke test for granular permissions, token revocation, and JTI tracking.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const work = mkdtempSync(path.join(tmpdir(), 'lore-auth-smoke-'));

function lore(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const TEAM_SECRET = 'smoke-team-secret-auth-9876543210';

try {
  // 1. Initialise repository
  writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'auth-fixture' }));
  writeFileSync(path.join(work, 'README.md'), '# Auth Smoke Test\n\n## Overview\nGranular ACL and token revocation.\n');
  const initRes = lore(['init']);
  if (initRes.code !== 0) throw new Error(`init failed: ${initRes.stderr}`);

  // 2. Issue tokens
  const aliceRes = lore(['identity', 'issue', '--user', 'alice@company', '--role', 'maintainer'], { LORE_TEAM_SECRET: TEAM_SECRET });
  if (aliceRes.code !== 0) throw new Error(`issue alice failed: ${aliceRes.stderr}`);
  const aliceToken = aliceRes.stdout.trim();

  const bobRes = lore(['identity', 'issue', '--user', 'bob@company', '--role', 'contributor', '--jti', 'token-bob-001'], { LORE_TEAM_SECRET: TEAM_SECRET });
  if (bobRes.code !== 0) throw new Error(`issue bob failed: ${bobRes.stderr}`);
  const bobToken = bobRes.stdout.trim();

  // 3. Verify Bob's identity before revocation
  const bobCheck = lore(['identity', '--json'], { LORE_TEAM_SECRET: TEAM_SECRET, LORE_TOKEN: bobToken });
  if (bobCheck.code !== 0) throw new Error(`bob identity failed: ${bobCheck.stderr}`);
  const bobId = JSON.parse(bobCheck.stdout);
  if (bobId.id !== 'bob@company' || bobId.jti !== 'token-bob-001' || bobId.status !== 'active') {
    throw new Error(`bob identity payload unexpected: ${bobCheck.stdout}`);
  }

  // 4. Set granular policy
  writeFileSync(
    path.join(work, 'lore.policy.yml'),
    `roles:
  maintainers: [alice@company]
  contributors: [bob@company]
  infra: [alice@company]
write:
  "env:*": [infra]
  "rule:*": [maintainers]
admin: [maintainers]
`
  );

  // 5. Test granular write ACL: bob (contributor) cannot write to env:DATABASE_URL
  const bobWriteEnv = lore(
    ['write', '--subject', 'env:DATABASE_URL', '--predicate', 'read_by', '--object', 'README.md', '--kind', 'file', '--ref', 'README.md'],
    { LORE_TEAM_SECRET: TEAM_SECRET, LORE_TOKEN: bobToken },
  );
  if (bobWriteEnv.code === 0) {
    throw new Error('bob must NOT be allowed to write to env:* under granular policy');
  }
  if (!bobWriteEnv.stderr.includes('write to env:DATABASE_URL requires role infra')) {
    throw new Error(`expected role infra error, got: ${bobWriteEnv.stderr}`);
  }

  // 6. Alice (infra/maintainer) can write to env:DATABASE_URL
  const aliceWriteEnv = lore(
    ['write', '--subject', 'env:DATABASE_URL', '--predicate', 'read_by', '--object', 'README.md', '--kind', 'file', '--ref', 'README.md'],
    { LORE_TEAM_SECRET: TEAM_SECRET, LORE_TOKEN: aliceToken },
  );
  if (aliceWriteEnv.code !== 0) {
    throw new Error(`alice write failed: ${aliceWriteEnv.stderr}`);
  }

  // 7. Non-admin cannot revoke tokens
  const bobRevoke = lore(['identity', 'revoke', 'token-bob-001'], { LORE_TEAM_SECRET: TEAM_SECRET, LORE_TOKEN: bobToken });
  if (bobRevoke.code === 0) {
    throw new Error('contributor must NOT be allowed to revoke tokens');
  }

  // 8. Admin (Alice) revokes Bob's token
  const aliceRevoke = lore(
    ['identity', 'revoke', bobToken, '--reason', 'credential compromise on workstation'],
    { LORE_TEAM_SECRET: TEAM_SECRET, LORE_TOKEN: aliceToken },
  );
  if (aliceRevoke.code !== 0) {
    throw new Error(`alice revoke failed: ${aliceRevoke.stderr}`);
  }
  if (!aliceRevoke.stdout.includes('[OK] revoked token')) {
    throw new Error(`expected confirmation, got: ${aliceRevoke.stdout}`);
  }

  // 9. List revocations
  const listRevoked = lore(['identity', 'revoked', '--json'], { LORE_TEAM_SECRET: TEAM_SECRET, LORE_TOKEN: aliceToken });
  if (listRevoked.code !== 0) throw new Error(`list revoked failed: ${listRevoked.stderr}`);
  const revocations = JSON.parse(listRevoked.stdout);
  if (!Array.isArray(revocations) || revocations.length !== 1 || revocations[0].jti !== 'token-bob-001') {
    throw new Error(`revocation list unexpected: ${listRevoked.stdout}`);
  }

  // 10. Attempt action with revoked token must fail immediately
  const bobWriteAfterRevoke = lore(
    ['write', '--subject', 'doc:notes.md', '--predicate', 'has_section', '--object', 'Notes', '--kind', 'file', '--ref', 'README.md'],
    { LORE_TEAM_SECRET: TEAM_SECRET, LORE_TOKEN: bobToken },
  );
  if (bobWriteAfterRevoke.code === 0) {
    throw new Error('revoked token must NOT be allowed to perform any write actions');
  }
  if (!bobWriteAfterRevoke.stderr.includes('token has been revoked')) {
    throw new Error(`expected revocation error, got: ${bobWriteAfterRevoke.stderr}`);
  }

  // 11. Bob identity check reflects revoked state
  const bobStatusCheck = lore(['identity', '--json'], { LORE_TEAM_SECRET: TEAM_SECRET, LORE_TOKEN: bobToken });
  if (bobStatusCheck.code !== 0) throw new Error(`bob identity check failed: ${bobStatusCheck.stderr}`);
  const bobCheckJson = JSON.parse(bobStatusCheck.stdout);
  if (bobCheckJson.status !== 'revoked') {
    throw new Error(`expected status revoked, got: ${bobCheckJson.status}`);
  }

  console.log('[OK] auth: token issuance with JTI, granular subject ACL, admin gate, token revocation, revoked rejection');
} finally {
  rmSync(work, { recursive: true, force: true });
}
