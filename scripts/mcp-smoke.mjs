#!/usr/bin/env node
// MCP smoke test: real stdio handshake against a throwaway repo.
// initialize → initialized → tools/list → tools/call memory_search/memory_write,
// and asserts the write landed on an agent/<session> branch.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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

function lore(args, env = {}) {
  return new Promise((resolve, reject) => {
    spawn(process.execPath, [CLI, ...args], { cwd: work, env: { ...process.env, ...env } })
      .on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`lore ${args.join(' ')} exit ${code}`))));
  });
}
await lore(['init']);
await lore(['ingest']);

// --- tiny JSON-RPC client ------------------------------------------------------
// --- tiny JSON-RPC client ------------------------------------------------------
// The server reads `.lore/session` (no LORE_SESSION override) so it shares the
// session that ingest wrote to — the realistic no-env agent launch.
const server = spawn(process.execPath, [CLI, 'mcp'], {
  cwd: work,
  env: { ...process.env },
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
  const expected = ['memory_blame', 'memory_diff', 'memory_search', 'memory_status', 'memory_write'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail(`tools/list: ${JSON.stringify(names)} != ${JSON.stringify(expected)}`);

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

  // the server session matches `.lore/session`, so the write landed on its branch
  const session = readFileSync(path.join(work, '.lore', 'session'), 'utf8').trim();
  const branch = `agent/${session}`;
  if (write.result?.structuredContent?.branch !== branch) {
    fail(`memory_write branch: ${write.result?.structuredContent?.branch} != ${branch}`);
  }

  // server did not touch main, and the draft is on the agent branch
  const diff = await rpc('tools/call', {
    name: 'memory_diff',
    arguments: { from: 'main', to: branch },
  });
  expectContains(
    JSON.stringify(diff.result?.structuredContent?.added ?? []),
    'concept:mcp-smoke-note',
    'memory_diff main..agent: write landed on agent branch',
  );

  // --- protocol robustness ---------------------------------------------------------
  const badMethod = await rpc('bogus/method');
  if (badMethod.error?.code !== -32601) fail(`unknown method should be -32601, got ${JSON.stringify(badMethod.error)}`);
  server.stdin.write('not json at all\n');
  await new Promise((r) => setTimeout(r, 150));
  const alive = await rpc('ping', undefined, { timeoutMs: 3000 });
  if (!('result' in alive)) fail('server did not survive malformed JSON (ping failed)');
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
console.log('MCP SMOKE OK — initialize, tools/list, search, write to agent/<session>, error handling');
