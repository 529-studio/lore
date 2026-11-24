#!/usr/bin/env node
// Test suite for MCP resource subscription protocol:
// - capabilities advertisement (resources: subscribe, listChanged)
// - resources/list and resources/templates/list
// - resources/read for active, status, rules, conflicts, and claims/{subject}
// - resources/subscribe and resources/unsubscribe
// - notifications/resources/updated broadcast on writes and commits

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

function expect(condition, msg) {
  if (!condition) {
    fail(msg);
    return false;
  }
  return true;
}

const work = mkdtempSync(path.join(tmpdir(), 'lore-mcp-res-test-'));

mkdirSync(path.join(work, 'src'));
writeFileSync(
  path.join(work, 'package.json'),
  JSON.stringify({ name: 'mcp-resource-test', dependencies: {} }),
);
writeFileSync(path.join(work, 'src', 'index.ts'), 'export const hello = "world";\n');

function runLore(args) {
  return new Promise((resolve, reject) => {
    spawn(process.execPath, [CLI, ...args], { cwd: work })
      .on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`lore ${args.join(' ')} exit ${code}`))));
  });
}

await runLore(['init']);
await runLore(['ingest']);

const server = spawn(process.execPath, [CLI, 'mcp'], {
  cwd: work,
  env: { ...process.env },
});

const outChunks = [];
const notifications = [];
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
    try {
      const msg = JSON.parse(line);
      if (msg.method && !('id' in msg)) {
        notifications.push(msg);
      } else if (msg.id !== undefined) {
        const resolve = pending.get(msg.id);
        if (resolve) {
          pending.delete(msg.id);
          resolve(msg);
        }
      }
    } catch {
      // ignore non-json log lines
    }
  }
}

server.stdout.on('data', (c) => {
  outChunks.push(c);
  pump();
});

let nextId = 0;
function rpc(method, params, { notification = false, timeoutMs = 8_000 } = {}) {
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
  // 1. Handshake
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0' },
  });
  expect(init.result?.capabilities?.resources?.subscribe === true, 'initialize advertises resources.subscribe');
  expect(init.result?.capabilities?.resources?.listChanged === true, 'initialize advertises resources.listChanged');

  await rpc('notifications/initialized', undefined, { notification: true });

  // 2. resources/list
  const resList = await rpc('resources/list');
  const uris = (resList.result?.resources ?? []).map((r) => r.uri);
  expect(uris.includes('lore://memory/active'), 'resources/list includes lore://memory/active');
  expect(uris.includes('lore://memory/status'), 'resources/list includes lore://memory/status');
  expect(uris.includes('lore://memory/rules'), 'resources/list includes lore://memory/rules');
  expect(uris.includes('lore://memory/conflicts'), 'resources/list includes lore://memory/conflicts');

  // 3. resources/templates/list
  const tplList = await rpc('resources/templates/list');
  const tpls = (tplList.result?.resourceTemplates ?? []).map((t) => t.uriTemplate);
  expect(tpls.includes('lore://claims/{subject}'), 'resources/templates/list includes lore://claims/{subject}');

  // 4. resources/read
  const statusRes = await rpc('resources/read', { uri: 'lore://memory/status' });
  expect(statusRes.result?.contents?.[0]?.mimeType === 'application/json', 'status resource mimeType is application/json');
  const statusData = JSON.parse(statusRes.result?.contents?.[0]?.text ?? '{}');
  expect(typeof statusData.activeClaims === 'number', 'status contains activeClaims count');
  expect(typeof statusData.branch === 'string', 'status contains branch name');

  const rulesRes = await rpc('resources/read', { uri: 'lore://memory/rules' });
  const rulesData = JSON.parse(rulesRes.result?.contents?.[0]?.text ?? '{}');
  expect(rulesData !== null && typeof rulesData === 'object', 'rules resource returns ontology object');

  const subjectRes = await rpc('resources/read', { uri: 'lore://claims/file%3Asrc%2Findex.ts' });
  const subjectData = JSON.parse(subjectRes.result?.contents?.[0]?.text ?? '[]');
  expect(Array.isArray(subjectData), 'subject claims is an array');

  const badRes = await rpc('resources/read', { uri: 'lore://unknown/resource' });
  expect(badRes.error !== undefined, 'unknown resource returns error');

  // 5. resources/subscribe
  const subStatus = await rpc('resources/subscribe', { uri: 'lore://memory/status' });
  expect(subStatus.result !== undefined, 'subscribe to status succeeded');

  const subActive = await rpc('resources/subscribe', { uri: 'lore://memory/active' });
  expect(subActive.result !== undefined, 'subscribe to active succeeded');

  const subSubject = await rpc('resources/subscribe', { uri: 'lore://claims/env%3ATEST_API_KEY' });
  expect(subSubject.result !== undefined, 'subscribe to subject succeeded');

  // 6. Trigger mutation via tool write
  notifications.length = 0;
  const writeRes = await rpc('tools/call', {
    name: 'memory_write',
    arguments: {
      subject: 'env:TEST_API_KEY',
      predicate: 'has_constraint',
      object: 'must be 32 chars alphanumeric',
      kind: 'agent',
    },
  });
  expect(writeRes.result?.structuredContent?.id !== undefined, 'tool write succeeded');

  // Wait for notification delivery
  await new Promise((r) => setTimeout(r, 200));

  const receivedUris = notifications.map((n) => n.params?.uri);
  expect(receivedUris.includes('lore://memory/status'), 'notification received for lore://memory/status');
  expect(receivedUris.includes('lore://memory/active'), 'notification received for lore://memory/active');
  expect(receivedUris.includes('lore://claims/env%3ATEST_API_KEY'), 'notification received for subscribed subject');

  // 7. resources/unsubscribe
  notifications.length = 0;
  const unsubActive = await rpc('resources/unsubscribe', { uri: 'lore://memory/active' });
  expect(unsubActive.result !== undefined, 'unsubscribe from active succeeded');

  // Trigger commit
  const commitRes = await rpc('tools/call', {
    name: 'memory_commit',
    arguments: { message: 'test commit for notification' },
  });
  expect(commitRes.result?.structuredContent?.commit !== undefined, 'commit succeeded');

  await new Promise((r) => setTimeout(r, 200));

  const secondReceivedUris = notifications.map((n) => n.params?.uri);
  expect(secondReceivedUris.includes('lore://memory/status'), 'notification still received for status');
  expect(!secondReceivedUris.includes('lore://memory/active'), 'notification NOT received for unsubscribed active resource');

} catch (err) {
  fail(err.stack || err.message);
} finally {
  server.stdin.end();
  server.kill();
  await new Promise((r) => server.on('exit', r));
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
}

if (failures > 0) {
  console.error(`TEST FAILED with ${failures} error(s)`);
  process.exit(1);
}
console.log('[OK] MCP resource subscription protocol tests passed cleanly');
