#!/usr/bin/env node
// MCP smoke test: real stdio handshake against a throwaway repo.
// initialize → initialized → tools/list → tools/call memory_search/memory_write,
// and asserts the write landed on an agent/<session> branch.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');

let failures = 0;
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures++;
}
function expectContains(actual, needle, label) {
  if (actual === undefined || actual === null || !String(actual).includes(needle)) {
    fail(`${label}: expected to contain "${needle}", got ${JSON.stringify(actual)}`);
    return false;
  }
  return true;
}

const work = mkdtempSync(path.join(tmpdir(), 'lore-mcp-smoke-'));

// --- minimal repo -------------------------------------------------------------
mkdirSync(path.join(work, 'src'));
writeFileSync(
  path.join(work, 'package.json'),
  JSON.stringify({ name: 'mcp-smoke-app', dependencies: { zod: '^4.0.0' } }),
);
writeFileSync(path.join(work, 'src', 'cli.ts'), 'import { z } from "zod";\nexport const s = z.string();\n');

function loreAt(cwd, args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`lore ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
}
await loreAt(work, ['init']);
await loreAt(work, ['ingest']);

const mockBin = path.join(work, 'mock-litestream');
writeFileSync(mockBin, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
chmodSync(mockBin, 0o755);

// --- tiny JSON-RPC client ------------------------------------------------------
// The server reads `.lore/session` (no LORE_SESSION override) so it shares the
// session that ingest wrote to — the realistic no-env agent launch.
const server = spawn(process.execPath, [CLI, 'mcp'], {
  cwd: work,
  env: {
    ...process.env,
    LORE_LITESTREAM_PATH: process.env.LORE_LITESTREAM_PATH ?? mockBin,
    // Loopback hub remotes are allowed only with this flag; the offline
    // scenario needs the security check to reach the connection attempt.
    LORE_HUB_ALLOW_INSECURE: '1',
    LORE_HUB_TOKEN: 'offline-token',
  },
});
const outChunks = [];
server.stdout.on('data', (c) => {
  outChunks.push(c);
  pump();
});

const pending = new Map();
function pump() {
  let text = Buffer.concat(outChunks).toString();
  let idx;
  while ((idx = text.indexOf('\n')) !== -1) {
    const line = text.slice(0, idx).trim();
    text = text.slice(idx + 1);
    outChunks.splice(0, outChunks.length);
    if (text) outChunks.push(Buffer.from(text));
    if (!line) continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
}

let nextId = 0;
function rpc(method, params, { notification = false, timeoutMs = 10_000 } = {}) {
  const id = notification ? undefined : ++nextId;
  const message = { jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, ...(params !== undefined ? { params } : {}) };
  const promise = id === undefined
    ? Promise.resolve(null)
    : new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout waiting for response to ${method}`));
        }, timeoutMs);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
  server.stdin.write(`${JSON.stringify(message)}\n`);
  return promise;
}

try {
  // --- handshake -----------------------------------------------------------------
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'lore-mcp-smoke', version: '0' },
  });
  expectContains(init.result?.serverInfo?.name, 'lore', 'initialize.serverInfo.name');
  if (init.result?.protocolVersion !== '2025-06-18') fail(`initialize.protocolVersion: ${init.result?.protocolVersion}`);
  if (!init.result?.capabilities?.tools) fail('initialize.capabilities.tools missing');

  await rpc('notifications/initialized', undefined, { notification: true });

  // --- tools/list ------------------------------------------------------------------
  const list = await rpc('tools/list');
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  const expected = ['memory_approve', 'memory_blame', 'memory_commit', 'memory_diff', 'memory_propose', 'memory_search', 'memory_status', 'memory_sync', 'memory_write'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail(`tools/list: ${JSON.stringify(names)} != ${JSON.stringify(expected)}`);
  for (const tool of list.result?.tools ?? []) {
    if (!tool.outputSchema || tool.outputSchema.type !== 'object') {
      fail(`tools/list: ${tool.name} is missing an object outputSchema`);
    }
  }

  // --- protocol negotiation -----------------------------------------------------------
  const negotiated = await rpc('initialize', {
    protocolVersion: '1999-01-01',
    capabilities: {},
    clientInfo: { name: 'future-client', version: '0' },
  });
  if (negotiated.result?.protocolVersion !== '2025-06-18') {
    fail(`unsupported protocol should negotiate to 2025-06-18, got ${negotiated.result?.protocolVersion}`);
  }

  // --- memory_search -----------------------------------------------------------------
  const search = await rpc('tools/call', {
    name: 'memory_search',
    arguments: { files: ['src/cli.ts'], budget_tokens: 4000 },
  });
  if (search.result?.isError) fail(`memory_search returned isError: ${JSON.stringify(search.result)}`);
  expectContains(search.result?.content?.[0]?.text, 'imports_module', 'memory_search text');
  const hits = search.result?.structuredContent?.hits ?? [];
  if (!hits.some((h) => h.subject === 'file:src/cli.ts' && typeof h.score === 'number')) {
    fail('memory_search structuredContent missing file:src/cli.ts hit with score');
  }
  const badArgs = await rpc('tools/call', {
    name: 'memory_blame',
    arguments: { subject: 'concepts:nothing-here' },
  });
  if (badArgs.result?.isError !== true) fail('memory_blame on unknown subject should return isError:true');

  // unknown tool → protocol error, not a crash
  const unknownTool = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
  if (unknownTool.error?.code !== -32602) fail(`unknown tool should be -32602, got ${JSON.stringify(unknownTool.error)}`);

  // --- memory_write → agent/<session> draft ----------------------------------------
  const write = await rpc('tools/call', {
    name: 'memory_write',
    arguments: {
      subject: 'concept:mcp-smoke-note',
      predicate: 'verified_by',
      object: 'mcp smoke asserts this claim exists',
      kind: 'agent',
    },
  });
  if (write.result?.isError) fail(`memory_write returned isError: ${JSON.stringify(write.result)}`);
  expectContains(write.result?.structuredContent?.state, 'draft', 'memory_write kind agent → draft');

  const badTtl = await rpc('tools/call', {
    name: 'memory_write',
    arguments: {
      subject: 'concept:bad-ttl',
      predicate: 'verified_by',
      object: 'should be rejected',
      kind: 'agent',
      ttl_days: -1,
    },
  });
  if (badTtl.result?.isError !== true) fail('memory_write should reject a negative ttl_days');

  // the server session matches `.lore/session`, so the write landed on its branch
  const session = readFileSync(path.join(work, '.lore', 'session'), 'utf8').trim();
  const branch = `agent/${session}`;
  if (write.result?.structuredContent?.branch !== branch) {
    fail(`memory_write branch: ${write.result?.structuredContent?.branch} != ${branch}`);
  }

  // drafts are not committed, so they are invisible to diff but visible to blame
  const blame = await rpc('tools/call', {
    name: 'memory_blame',
    arguments: { subject: 'concept:mcp-smoke-note' },
  });
  const blameText = JSON.stringify(blame.result?.structuredContent ?? {});
  expectContains(blameText, 'concept:mcp-smoke-note', 'memory_blame sees the draft');
  expectContains(blameText, 'draft', 'memory_blame reports draft state');

  // --- draft gating + approve over MCP ---------------------------------------------
  const draftId = write.result?.structuredContent?.id;
  const statusAfterDraft = await rpc('tools/call', { name: 'memory_status', arguments: {} });
  if (!(statusAfterDraft.result?.structuredContent?.drafts >= 1)) {
    fail(`memory_status.drafts should count the draft, got ${statusAfterDraft.result?.structuredContent?.drafts}`);
  }
  const draftSearch = await rpc('tools/call', {
    name: 'memory_search',
    arguments: { query: 'mcp smoke asserts this claim exists', include_stale: true, budget_tokens: 4000 },
  });
  const draftHits = draftSearch.result?.structuredContent?.hits ?? [];
  if (draftHits.some((h) => h.id === draftId)) fail('draft leaked into memory_search');

  const approve = await rpc('tools/call', { name: 'memory_approve', arguments: { claim: draftId } });
  if (approve.result?.isError) fail(`memory_approve returned isError: ${JSON.stringify(approve.result)}`);

  const afterApprove = await rpc('tools/call', {
    name: 'memory_search',
    arguments: { query: 'mcp smoke asserts this claim exists', include_stale: true, budget_tokens: 4000 },
  });
  const approvedHits = afterApprove.result?.structuredContent?.hits ?? [];
  if (!approvedHits.some((h) => h.id === draftId)) fail('approved claim not visible in memory_search');

  const checkpoint = await rpc('tools/call', { name: 'memory_commit', arguments: { message: 'mcp smoke checkpoint' } });
  if (!checkpoint.result?.structuredContent?.commit) fail('memory_commit did not return a commit id');

  // --- contested facts are withheld and warned about ---------------------------
  const pmNpm = await rpc('tools/call', {
    name: 'memory_write',
    arguments: {
      subject: 'env:MCP_PM',
      predicate: 'package_manager',
      object: 'npm',
      kind: 'file',
      ref: 'package.json',
    },
  });
  if (pmNpm.result?.isError) fail(`memory_write npm returned isError: ${JSON.stringify(pmNpm.result)}`);
  const pmPnpm = await rpc('tools/call', {
    name: 'memory_write',
    arguments: {
      subject: 'env:MCP_PM',
      predicate: 'package_manager',
      object: 'pnpm',
      kind: 'file',
      ref: 'src/cli.ts',
    },
  });
  if (pmPnpm.result?.isError) fail(`memory_write pnpm returned isError: ${JSON.stringify(pmPnpm.result)}`);

  const contested = await rpc('tools/call', {
    name: 'memory_search',
    arguments: { query: 'package_manager', budget_tokens: 4000 },
  });
  const contestedHits = contested.result?.structuredContent?.hits ?? [];
  if (contestedHits.some((h) => h.subject === 'env:MCP_PM')) fail('contested claim leaked into memory_search');
  expectContains(
    contested.result?.content?.[0]?.text,
    'memory contested: env:MCP_PM:package_manager — see lore explain',
    'memory_search contested warning',
  );
  const warnings = contested.result?.structuredContent?.warnings ?? [];
  if (!warnings.some((w) => w.includes('env:MCP_PM:package_manager'))) {
    fail(`memory_search structuredContent.warnings missing the contested fact: ${JSON.stringify(warnings)}`);
  }
  const contestedFacts = contested.result?.structuredContent?.contested ?? [];
  if (!contestedFacts.some((f) => f.subject === 'env:MCP_PM' && f.claim_ids.length === 2)) {
    fail(`memory_search structuredContent.contested missing both sides: ${JSON.stringify(contestedFacts)}`);
  }

  // --- memory_sync -------------------------------------------------------------
  const syncMissing = await rpc('tools/call', {
    name: 'memory_sync',
    arguments: {},
  });
  if (syncMissing.result?.isError !== true) {
    fail('memory_sync without replica configured should return isError:true');
  }
  expectContains(
    syncMissing.result?.content?.[0]?.text,
    'no remote configured',
    'memory_sync missing remote error',
  );

  const syncWithReplica = await rpc('tools/call', {
    name: 'memory_sync',
    arguments: { replica_url: 'file:///mock/replica/lore.db' },
  });
  if (syncWithReplica.result?.isError) {
    fail(`memory_sync returned isError: ${JSON.stringify(syncWithReplica.result)}`);
  }
  const syncStructured = syncWithReplica.result?.structuredContent;
  if (!syncStructured?.pull || !syncStructured?.push) {
    fail(`memory_sync structuredContent missing pull/push: ${JSON.stringify(syncStructured)}`);
  }
  if (syncStructured.replica_url !== 'file:///mock/replica/lore.db') {
    fail(`memory_sync replica_url mismatch: ${syncStructured.replica_url}`);
  }
  if (syncStructured.kind !== 'litestream') {
    fail(`memory_sync explicit replica should use the litestream adapter, got ${syncStructured.kind}`);
  }
  if (syncStructured.push.walCheckpointed !== true) {
    fail('memory_sync push walCheckpointed should be true for the litestream backup path');
  }
  expectContains(
    syncWithReplica.result?.content?.[0]?.text,
    'synced litestream file:///mock/replica/lore.db',
    'memory_sync text',
  );

  // --- protocol robustness ---------------------------------------------------------
  const badMethod = await rpc('bogus/method');
  if (badMethod.error?.code !== -32601) fail(`unknown method should be -32601, got ${JSON.stringify(badMethod.error)}`);
  server.stdin.write('not json at all\n');
  await new Promise((r) => setTimeout(r, 150));
  const alive = await rpc('ping', undefined, { timeoutMs: 3000 });
  if (!('result' in alive)) fail('server did not survive malformed JSON (ping failed)');

  // --- initialize pulls a remote that is ahead (dir adapter) ------------------
  const repoId = JSON.parse(readFileSync(path.join(work, '.lore', 'config.json'), 'utf8')).repo_id;
  const teamRepo = path.join(work, 'team-repo');
  const sharedDir = path.join(work, 'team-shared');
  mkdirSync(path.join(teamRepo, 'src'), { recursive: true });
  mkdirSync(sharedDir, { recursive: true });
  writeFileSync(path.join(teamRepo, '.lore.yml'), `repo_id: ${repoId}\n`);
  writeFileSync(path.join(teamRepo, 'package.json'), JSON.stringify({ name: 'team-repo' }));
  writeFileSync(path.join(teamRepo, 'src', 'team.ts'), 'export const teamAuth = true;\n');
  loreAt(teamRepo, ['init'], { LORE_TRUST_MODE: 'permissive' });
  loreAt(teamRepo, ['ingest'], { LORE_TRUST_MODE: 'permissive' });
  loreAt(
    teamRepo,
    [
      'write',
      '--subject',
      'sym:src/team.ts#sync',
      '--predicate',
      'enforces_invariant',
      '--object',
      'team claim delivered by the shared remote',
      '--kind',
      'file',
      '--ref',
      'src/team.ts',
    ],
    { LORE_TRUST_MODE: 'permissive' },
  );
  loreAt(teamRepo, ['promote'], { LORE_TRUST_MODE: 'permissive' });
  loreAt(teamRepo, ['push', '--path', sharedDir], { LORE_TRUST_MODE: 'permissive' });
  loreAt(work, ['remote', sharedDir]);

  const aheadInit = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'team-client', version: '0' },
  });
  if (!aheadInit.result?.serverInfo) fail('initialize with a remote ahead must succeed');

  let dirStatus = {};
  for (let i = 0; i < 80; i += 1) {
    const status = await rpc('tools/call', { name: 'memory_status', arguments: {} });
    dirStatus = status.result?.structuredContent ?? {};
    if (dirStatus.remote_state === 'synced') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (dirStatus.remote_state !== 'synced') {
    fail(`auto_sync should pull the dir delta, state=${dirStatus.remote_state} error=${dirStatus.remote?.error}`);
  }
  if (dirStatus.remote_behind !== 0) fail(`remote_behind should be 0 after the pull, got ${dirStatus.remote_behind}`);
  expectContains(JSON.stringify(dirStatus), 'rows_behind', 'memory_status remote detail');

  // The long-lived smoke session owns unmerged commits, so the pulled main is
  // not its active set; blame proves the claim landed in the shared store and a
  // fresh session inherits it from main.
  const teamBlame = await rpc('tools/call', {
    name: 'memory_blame',
    arguments: { subject: 'sym:src/team.ts#sync' },
  });
  if (teamBlame.result?.isError) {
    fail(`auto_sync import did not land the team claim: ${JSON.stringify(teamBlame.result)}`);
  }
  expectContains(
    JSON.stringify(teamBlame.result?.structuredContent ?? {}),
    'team claim delivered by the shared remote',
    'pulled team claim object',
  );

  const dirSync = await rpc('tools/call', { name: 'memory_sync', arguments: {} });
  if (dirSync.result?.isError) fail(`memory_sync dir returned isError: ${JSON.stringify(dirSync.result)}`);
  if (dirSync.result?.structuredContent?.kind !== 'dir') {
    fail(`memory_sync should dispatch to the dir adapter, got ${dirSync.result?.structuredContent?.kind}`);
  }
  if (dirSync.result?.structuredContent?.push?.walCheckpointed !== false) {
    fail('dir adapter must not claim a Litestream WAL checkpoint');
  }

  // --- unreachable remote degrades to a warning ------------------------------
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const closedPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  loreAt(work, ['remote', '--hub', `http://127.0.0.1:${closedPort}`]);

  const started = Date.now();
  const offlineInit = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'offline-client', version: '0' },
  });
  const elapsed = Date.now() - started;
  if (!offlineInit.result?.serverInfo) fail('initialize must succeed while the remote is unreachable');
  if (elapsed > 3000) fail(`initialize blocked ${elapsed}ms on an unreachable remote`);

  let offlineStatus = {};
  for (let i = 0; i < 80; i += 1) {
    const status = await rpc('tools/call', { name: 'memory_status', arguments: {} });
    offlineStatus = status.result?.structuredContent ?? {};
    if (offlineStatus.remote_state === 'unreachable') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (offlineStatus.remote_state !== 'unreachable') {
    fail(`unreachable remote should degrade, got state=${offlineStatus.remote_state}`);
  }
  if (offlineStatus.remote?.reachable !== false) fail('memory_status should mark the remote unreachable');
  if (!offlineStatus.remote?.error) fail('memory_status should explain why the remote is unreachable');

  const afterOffline = await rpc('ping', undefined, { timeoutMs: 3000 });
  if (!('result' in afterOffline)) fail('server died after a failed auto_sync');
} catch (error) {
  fail(error.message);
} finally {
  server.stdin.end();
  server.kill();
  await new Promise((r) => server.on('exit', r));
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // temp cleanup best-effort
  }
}

if (failures > 0) {
  console.error(`MCP SMOKE FAILED — ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  'MCP SMOKE OK — initialize, tools/list, search, draft gating, approve, commit, contested warning, adapter dispatch, auto_sync, offline degradation, error handling',
);
