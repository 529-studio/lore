#!/usr/bin/env node
// Regression for #189b: every write/lifecycle entry point must enforce the
// same policy as `lore write`. A contributor token must fail closed on
// protected subjects (write, supersede, rename, ingest, approve, UI, MCP),
// auto-resolve, wrapup, tombstone purge, and token issuance.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { startUi } from '../dist/ui/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const work = mkdtempSync(path.join(tmpdir(), 'lore-policy-guards-'));
const SECRET = 'smoke-team-secret-policy-guards-123456';

let failures = 0;
function fail(message) {
  console.error(`[ERR] ${message}`);
  failures += 1;
}
function check(cond, message) {
  if (!cond) fail(message);
  return cond;
}

function run(args, env = {}) {
  return runAt(work, args, env);
}
function runAt(cwd, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...env },
  });
}
function expectOk(args, env = {}) {
  const result = run(args, env);
  if (result.status !== 0) {
    throw new Error(`lore ${args.join(' ')} exited ${result.status}\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
function expectDenied(args, env, needle, label) {
  return expectDeniedAt(work, args, env, needle, label);
}
function expectDeniedAt(cwd, args, env, needle, label) {
  const result = runAt(cwd, args, env);
  if (result.status === 0) {
    fail(`${label}: command unexpectedly succeeded\n${result.stdout}`);
    return result;
  }
  const text = `${result.stdout}${result.stderr}`;
  if (needle && !text.includes(needle)) {
    fail(`${label}: expected "${needle}", got: ${text}`);
  }
  return result;
}
function openDb() {
  return new Database(path.join(work, '.lore', 'lore.db'));
}
function claimIdFor(subject, predicate) {
  const db = openDb();
  try {
    const row = db.prepare('SELECT id FROM claim WHERE subject_id = ? AND predicate = ?').get(subject, predicate);
    return row?.id ?? null;
  } finally {
    db.close();
  }
}

function startMcp(env) {
  const server = spawn(process.execPath, [CLI, 'mcp'], {
    cwd: work,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...env },
  });
  const pending = new Map();
  let buffer = '';
  let nextId = 0;
  let stderr = '';
  server.stderr.on('data', (chunk) => (stderr += chunk));
  server.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });
  function rpc(method, params, { notification = false, timeoutMs = 10_000 } = {}) {
    const id = notification ? undefined : ++nextId;
    const message = {
      jsonrpc: '2.0',
      ...(id !== undefined ? { id } : {}),
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const promise =
      id === undefined
        ? Promise.resolve(null)
        : new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              reject(new Error(`timeout waiting for ${method}; stderr=${stderr}`));
            }, timeoutMs);
            pending.set(id, (msg) => {
              clearTimeout(timer);
              resolve(msg);
            });
          });
    server.stdin.write(`${JSON.stringify(message)}\n`);
    return promise;
  }
  return {
    rpc,
    close: () => new Promise((resolve) => {
      server.once('exit', resolve);
      server.kill();
    }),
  };
}

try {
  writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'policy-guards' }));
  writeFileSync(path.join(work, 'README.md'), '# Policy guards fixture\n');

  expectOk(['init']);
  writeFileSync(
    path.join(work, 'lore.policy.yml'),
    `roles:
  maintainers: [alice@company]
  contributors: [bob@company]
approve:
  t0: ["*"]
  t1: ["*"]
  t2: [maintainers]
  t4: ["*"]
resolve: [maintainers]
promote: [maintainers]
purge: [maintainers]
redact: [maintainers]
admin: [maintainers]
protected:
  "doc:*": [contributors]
  "doc:locked.md": [maintainers]
  "doc:tier.md": [contributors, maintainers]
  "doc:AGENTS.md*": [maintainers]
`,
  );

  // Bootstrap two identities with only the signing secret.
  const alice = expectOk(['identity', 'issue', '--user', 'alice@company', '--role', 'maintainer', '--jti', 'alice-1'], {
    LORE_TEAM_SECRET: SECRET,
  }).trim();
  const bob = expectOk(['identity', 'issue', '--user', 'bob@company', '--role', 'contributor', '--jti', 'bob-1'], {
    LORE_TEAM_SECRET: SECRET,
  }).trim();
  const aliceEnv = { LORE_TEAM_SECRET: SECRET, LORE_TOKEN: alice };
  const bobEnv = { LORE_TEAM_SECRET: SECRET, LORE_TOKEN: bob };

  // Alice owns a protected, active claim on main.
  expectOk(
    ['write', '--subject', 'doc:locked.md', '--predicate', 'has_section', '--object', 'Protected rules', '--kind', 'human', '--ref', 'README.md', '--author', 'human:alice'],
    { ...aliceEnv, LORE_SESSION: 'alice' },
  );
  const lockedId = claimIdFor('doc:locked.md', 'has_section');
  if (!check(lockedId, 'failed to create the protected claim')) throw new Error('cannot continue');
  expectOk(['approve', lockedId], { ...aliceEnv, LORE_SESSION: 'alice' });
  expectOk(['promote'], { ...aliceEnv, LORE_SESSION: 'alice' });

  // 1. supersede on a protected subject is a write -> denied for a contributor.
  expectDenied(
    ['supersede', lockedId, '--object', 'hijacked', '--kind', 'human', '--ref', 'README.md'],
    { ...bobEnv, LORE_SESSION: 'bob' },
    'protected',
    'supersede protected',
  );

  // 2. Renaming a protected entity rewrites its claim subjects.
  expectDenied(['rename', 'doc:locked.md', 'doc:renamed.md'], bobEnv, 'protected', 'rename protected entity');
  const afterRename = openDb();
  const lockedEntity = afterRename.prepare("SELECT id FROM entity WHERE id = 'doc:locked.md'").get();
  afterRename.close();
  check(Boolean(lockedEntity), 'denied rename still moved the protected entity');

  // 3. Bulk ingest must not write a protected extracted subject.
  writeFileSync(path.join(work, 'AGENTS.md'), '# AGENTS\n\n## 1. Guardrail\n\nNever bypass policy.\n');
  expectDenied(['ingest'], { ...bobEnv, LORE_SESSION: 'bob' }, 'protected', 'ingest protected document');

  // 4. Protected membership must not bypass the tier approval rule.
  expectOk(
    ['write', '--subject', 'doc:tier.md', '--predicate', 'has_section', '--object', 'tier draft', '--kind', 'human', '--ref', 'README.md', '--author', 'human:alice'],
    { ...aliceEnv, LORE_SESSION: 'alice' },
  );
  const tierDraft = claimIdFor('doc:tier.md', 'has_section');
  if (!check(tierDraft, 'failed to create the tier draft')) throw new Error('cannot continue');
  expectDenied(['approve', tierDraft], bobEnv, 'approve t2', 'protected membership must not skip the tier rule');
  const afterTier = openDb();
  const tierState = afterTier.prepare('SELECT state FROM claim WHERE id = ?').get(tierDraft)?.state;
  afterTier.close();
  check(tierState === 'draft', 'denied tier approval still approved the draft');

  // 5. auto-semantic resolve must be authorized before recording anything.
  const db = openDb();
  db.prepare(
    `INSERT INTO merge_conflict (ours_tip, theirs_tip, subject_id, predicate, ours_claim, theirs_claim, base_claim, reason, ts)
     VALUES (NULL, NULL, 'doc:locked.md', 'has_section', ?, NULL, NULL, 'smoke conflict', ?)`,
  ).run(lockedId, new Date().toISOString());
  db.close();
  expectDenied(['resolve', '--auto-semantic'], { ...bobEnv, LORE_SESSION: 'bob' }, 'protected', 'resolve --auto-semantic');
  const afterResolve = openDb();
  const resolutions = afterResolve.prepare('SELECT COUNT(*) AS n FROM resolution').get().n;
  afterResolve.close();
  check(Number(resolutions) === 0, 'denied auto-resolve still wrote a resolution row');

  // 3. wrapup fast-forward moves main -> promote role required.
  expectOk(
    ['write', '--subject', 'doc:bob.md', '--predicate', 'has_section', '--object', 'bob note', '--kind', 'file', '--ref', 'README.md'],
    { ...bobEnv, LORE_SESSION: 'bob' },
  );
  expectDenied(['wrapup', '--yes', '--session', 'bob'], bobEnv, 'promote requires role', 'wrapup fast-forward');
  const afterWrapup = openDb();
  const bobTip = afterWrapup.prepare("SELECT commit_id FROM ref WHERE name = 'agent/bob'").get()?.commit_id;
  const mainTip = afterWrapup.prepare("SELECT commit_id FROM ref WHERE name = 'main'").get()?.commit_id;
  afterWrapup.close();
  check(Boolean(bobTip) && bobTip !== mainTip, 'denied wrapup still moved main');

  // A denied wrapup must not approve its drafts before failing.
  expectOk(
    ['write', '--subject', 'doc:bob-draft.md', '--predicate', 'has_section', '--object', 'bob draft', '--kind', 'agent', '--ref', 'README.md'],
    { ...bobEnv, LORE_SESSION: 'bob' },
  );
  const bobDraft = claimIdFor('doc:bob-draft.md', 'has_section');
  if (!check(bobDraft, 'failed to create the wrapup draft')) throw new Error('cannot continue');
  expectDenied(['wrapup', '--yes', '--session', 'bob'], bobEnv, 'promote requires role', 'wrapup partial');
  const afterWrapupDraft = openDb();
  const bobDraftState = afterWrapupDraft.prepare('SELECT state FROM claim WHERE id = ?').get(bobDraft)?.state;
  afterWrapupDraft.close();
  check(bobDraftState === 'draft', 'denied wrapup still approved its drafts');

  // 4. gc --purge-tombstones permanently deletes -> purge role required.
  expectOk(
    ['write', '--subject', 'doc:gc.md', '--predicate', 'has_section', '--object', 'expire me', '--kind', 'file', '--ref', 'README.md'],
    { ...aliceEnv, LORE_SESSION: 'alice' },
  );
  const gcId = claimIdFor('doc:gc.md', 'has_section');
  if (!check(gcId, 'failed to create the gc claim')) throw new Error('cannot continue');
  expectOk(['promote'], { ...aliceEnv, LORE_SESSION: 'alice' });
  expectOk(['redact', gcId, '--reason', 'smoke tombstone'], { ...aliceEnv, LORE_SESSION: 'alice' });

  // An eligible draft must also survive a denied purge invocation.
  expectOk(
    ['write', '--subject', 'doc:gc-draft.md', '--predicate', 'has_section', '--object', 'gc draft', '--kind', 'agent', '--ref', 'README.md'],
    { ...aliceEnv, LORE_SESSION: 'gcdraft' },
  );
  const gcDraftId = claimIdFor('doc:gc-draft.md', 'has_section');
  if (!check(gcDraftId, 'failed to create the gc draft')) throw new Error('cannot continue');
  runAt(work, ['status'], { LORE_SESSION: 'gcother1' });
  runAt(work, ['status'], { LORE_SESSION: 'gcother2' });

  expectDenied(
    ['gc', '--ttl-sessions', '1', '--purge-tombstones', '--tombstone-ttl-days', '0'],
    bobEnv,
    'purge requires role',
    'gc --purge-tombstones',
  );
  const afterGc = openDb();
  const gcRow = afterGc.prepare('SELECT id FROM claim WHERE id = ?').get(gcId);
  const gcDraft = afterGc.prepare('SELECT state FROM claim WHERE id = ?').get(gcDraftId);
  afterGc.close();
  check(Boolean(gcRow), 'denied gc still purged the tombstone');
  check(gcDraft?.state === 'draft', 'denied gc still retracted its drafts');

  // 5. A token holder cannot mint another role, even outside a repository.
  expectDenied(
    ['identity', 'issue', '--user', 'evil@company', '--role', 'maintainer', '--jti', 'evil-1'],
    bobEnv,
    'admin requires role',
    'identity issue as contributor',
  );
  expectDeniedAt(
    tmpdir(),
    ['identity', 'issue', '--user', 'evil@company', '--role', 'maintainer', '--jti', 'evil-2'],
    bobEnv,
    'lore repository',
    'identity issue outside a repository',
  );

  // 6. Approving a protected draft is denied even when the tier itself is open.
  expectOk(
    ['write', '--subject', 'doc:locked.md', '--predicate', 'verified_by', '--object', 'draft target', '--kind', 'agent', '--ref', 'README.md', '--author', 'agent:alice'],
    { ...aliceEnv, LORE_SESSION: 'alice' },
  );
  const protectedDraft = claimIdFor('doc:locked.md', 'verified_by');
  if (!check(protectedDraft, 'failed to create the protected draft')) throw new Error('cannot continue');
  expectDenied(['approve', protectedDraft], bobEnv, 'protected', 'CLI approve protected draft');

  // 7. MCP memory_write and memory_approve enforce the same ACL.

  const mcp = startMcp({ ...bobEnv, LORE_SESSION: 'mcp-bob' });
  try {
    await mcp.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'policy-guards-smoke', version: '0' },
    });
    await mcp.rpc('notifications/initialized', undefined, { notification: true });

    const writeResult = await mcp.rpc('tools/call', {
      name: 'memory_write',
      arguments: {
        subject: 'doc:locked.md',
        predicate: 'has_section',
        object: 'mcp bypass',
        kind: 'human',
        ref: 'README.md',
      },
    });
    check(writeResult.result?.isError === true, 'MCP memory_write to a protected subject did not fail');
    check(
      JSON.stringify(writeResult.result ?? {}).includes('protected'),
      `MCP memory_write error did not mention the protected subject: ${JSON.stringify(writeResult.result)}`,
    );

    const approveResult = await mcp.rpc('tools/call', {
      name: 'memory_approve',
      arguments: { claim: protectedDraft },
    });
    check(approveResult.result?.isError === true, 'MCP memory_approve on a protected draft did not fail');
    check(
      JSON.stringify(approveResult.result ?? {}).includes('protected'),
      `MCP memory_approve error did not mention the protected subject: ${JSON.stringify(approveResult.result)}`,
    );
  } finally {
    await mcp.close();
  }

  // 8. The dashboard write routes enforce the same ACL as the CLI.
  const savedToken = process.env.LORE_TOKEN;
  const savedSecret = process.env.LORE_TEAM_SECRET;
  process.env.LORE_TEAM_SECRET = SECRET;
  process.env.LORE_TOKEN = bob;
  const ui = await startUi(work, { port: 0 });
  try {
    const html = await (await fetch(ui.url)).text();
    const csrf = html.match(/const CSRF = '([^']+)'/)?.[1];
    if (!check(csrf, 'UI did not expose a CSRF token')) throw new Error('cannot continue');
    const post = (route, body) =>
      fetch(`${ui.url}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lore-csrf': csrf },
        body: JSON.stringify(body),
      });
    const uiWrite = await post('/api/claim', {
      subject: 'doc:locked.md',
      predicate: 'has_section',
      object: 'ui bypass',
    });
    const uiWriteBody = await uiWrite.text();
    check(uiWrite.status === 403, `UI /api/claim to a protected subject returned ${uiWrite.status}`);
    check(uiWriteBody.includes('protected'), `UI /api/claim denial did not mention the protected subject: ${uiWriteBody}`);
    const uiSupersede = await post('/api/supersede', { claim: lockedId, object: 'ui hack' });
    const uiSupersedeBody = await uiSupersede.text();
    check(uiSupersede.status === 403, `UI /api/supersede on a protected subject returned ${uiSupersede.status}`);
    check(
      uiSupersedeBody.includes('protected'),
      `UI /api/supersede denial did not mention the protected subject: ${uiSupersedeBody}`,
    );
  } finally {
    await ui.close();
    if (savedToken === undefined) delete process.env.LORE_TOKEN;
    else process.env.LORE_TOKEN = savedToken;
    if (savedSecret === undefined) delete process.env.LORE_TEAM_SECRET;
    else process.env.LORE_TEAM_SECRET = savedSecret;
  }

  if (failures) {
    console.error(`[ERR] ${failures} policy guard check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('[OK] supersede, rename, ingest, approve tiers, auto-resolve, wrapup, gc, identity issue, UI and MCP fail closed for contributors');
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
