#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');

function fail(msg) {
  console.error(`[ERR] ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[OK] ${msg}`);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-temporal-smoke-'));

try {
  // 1. Direct unit checks for temporal helpers
  const { parseTemporalInstant, isInValidTime, isInTxTime } = await import(
    path.join(ROOT, 'dist', 'canon', 'temporal.js')
  );

  const t1 = parseTemporalInstant('2026-05-01T12:00:00Z', 'test');
  if (t1 !== Date.parse('2026-05-01T12:00:00Z')) fail('parseTemporalInstant mismatch for valid ISO');

  try {
    parseTemporalInstant('invalid-date', 'test');
    fail('parseTemporalInstant should have thrown on invalid date');
  } catch (err) {
    if (!String(err.message).includes('not a valid ISO date')) {
      fail(`unexpected error: ${err.message}`);
    }
  }

  // Check valid time logic
  const claimBounded = {
    valid_from: '2026-01-01T00:00:00Z',
    valid_to: '2026-06-01T00:00:00Z',
  };
  if (isInValidTime(claimBounded, Date.parse('2025-12-31T23:59:59Z'))) {
    fail('claim should not be valid before valid_from');
  }
  if (!isInValidTime(claimBounded, Date.parse('2026-03-01T00:00:00Z'))) {
    fail('claim should be valid within [valid_from, valid_to)');
  }
  if (isInValidTime(claimBounded, Date.parse('2026-06-01T00:00:00Z'))) {
    fail('claim should not be valid at or after valid_to');
  }

  // Range overlaps
  if (
    !isInValidTime(claimBounded, {
      from: '2025-10-01T00:00:00Z',
      to: '2026-02-01T00:00:00Z',
    })
  ) {
    fail('overlapping valid range should match');
  }
  if (
    isInValidTime(claimBounded, {
      from: '2026-07-01T00:00:00Z',
      to: '2026-08-01T00:00:00Z',
    })
  ) {
    fail('disjoint future valid range should not match');
  }

  // Check transaction time logic
  if (!isInTxTime('2026-01-01T00:00:00Z', null, Date.parse('2026-02-01T00:00:00Z'))) {
    fail('open transaction interval should be active');
  }
  if (isInTxTime('2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z', Date.parse('2026-04-01T00:00:00Z'))) {
    fail('closed transaction interval should not be active after txTo');
  }
  ok('temporal math and range evaluation passed');

  // 2. End-to-end repository test
  execFileSync('git', ['init', '-q'], { cwd: workDir });
  execFileSync('git', ['config', 'user.email', 'temporal@smoke.test'], { cwd: workDir });
  execFileSync('git', ['config', 'user.name', 'temporal-smoke'], { cwd: workDir });

  fs.writeFileSync(path.join(workDir, 'README.md'), '# Temporal Smoke\n');
  execFileSync('git', ['add', '-A'], { cwd: workDir });
  execFileSync('git', ['commit', '-qm', 'initial commit'], { cwd: workDir });

  // Init Lore
  execFileSync('node', [CLI, 'init'], { cwd: workDir });

  // Write initial fact with valid_from = 2026-01-01
  const out1 = execFileSync(
    'node',
    [
      CLI,
      'write',
      '--subject',
      'env:DATABASE_URL',
      '--predicate',
      'target_host',
      '--object',
      'pg-cluster-v1.internal',
      '--kind',
      'test',
      '--ref',
      'README.md',
      '--valid-from',
      '2026-01-01T00:00:00Z',
    ],
    { cwd: workDir, encoding: 'utf8' },
  );
  const match1 = out1.match(/c_[a-f0-9]{32}/);
  if (!match1) fail(`could not extract claim id from write output: ${out1}`);
  const claim1Id = match1[0];

  // Point query: before valid_from should return 0 hits
  const searchBefore = execFileSync(
    'node',
    [CLI, 'search', 'pg-cluster', '--valid-at', '2025-11-01T00:00:00Z', '--json'],
    { cwd: workDir, encoding: 'utf8' },
  );
  const resBefore = JSON.parse(searchBefore);
  if (resBefore.hits.length !== 0) {
    fail(`expected 0 hits before valid_from, got ${resBefore.hits.length}`);
  }

  // Point query: within valid time should return 1 hit
  const searchDuring = execFileSync(
    'node',
    [CLI, 'search', 'pg-cluster', '--valid-at', '2026-03-01T00:00:00Z', '--json'],
    { cwd: workDir, encoding: 'utf8' },
  );
  const resDuring = JSON.parse(searchDuring);
  if (resDuring.hits.length !== 1 || resDuring.hits[0].id !== claim1Id) {
    fail(`expected 1 hit with claim1Id, got: ${JSON.stringify(resDuring.hits)}`);
  }
  ok('point query in valid-time passed');

  // Point query: transaction time in past before claim existed
  const searchPastTx = execFileSync(
    'node',
    [CLI, 'search', 'pg-cluster', '--tx-at', '2024-01-01T00:00:00Z', '--json'],
    { cwd: workDir, encoding: 'utf8' },
  );
  const resPastTx = JSON.parse(searchPastTx);
  if (resPastTx.hits.length !== 0) {
    fail(`expected 0 hits for past tx-at, got ${resPastTx.hits.length}`);
  }
  ok('point query in transaction-time passed');

  // Reconstruct timeline
  const timelineJson = execFileSync(
    'node',
    [CLI, 'timeline', 'env:DATABASE_URL', '--json'],
    { cwd: workDir, encoding: 'utf8' },
  );
  const timelineObj = JSON.parse(timelineJson);
  if (timelineObj.entries.length !== 1) {
    fail(`expected 1 timeline entry, got ${timelineObj.entries.length}`);
  }
  if (timelineObj.entries[0].validFrom !== '2026-01-01T00:00:00Z') {
    fail(`expected validFrom 2026-01-01T00:00:00Z, got ${timelineObj.entries[0].validFrom}`);
  }

  // Human-readable timeline command
  const timelineText = execFileSync(
    'node',
    [CLI, 'timeline', 'env:DATABASE_URL'],
    { cwd: workDir, encoding: 'utf8' },
  );
  if (!timelineText.includes('Bi-temporal Timeline for env:DATABASE_URL')) {
    fail(`unexpected timeline text output: ${timelineText}`);
  }
  ok('lore timeline command and JSON output passed');

  // 3. MCP server tool testing over stdio
  const mcpProc = spawn('node', [CLI, 'mcp'], {
    cwd: workDir,
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const rl = readline.createInterface({ input: mcpProc.stdout });
  let rpcId = 1;
  const pending = new Map();

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {
      // ignore non-json lines
    }
  });

  function sendRpc(method, params = {}) {
    return new Promise((resolve) => {
      const id = rpcId++;
      pending.set(id, resolve);
      mcpProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  // Initialize
  await sendRpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'temporal-test', version: '1.0.0' },
  });

  // Call memory_search with valid_at
  const searchRpc = await sendRpc('tools/call', {
    name: 'memory_search',
    arguments: {
      query: 'pg-cluster',
      valid_at: '2026-03-01T00:00:00Z',
    },
  });

  if (!searchRpc.result || searchRpc.result.isError) {
    fail(`memory_search RPC error: ${JSON.stringify(searchRpc)}`);
  }
  const textContent = searchRpc.result.content?.[0]?.text ?? '';
  if (!textContent.includes('pg-cluster-v1.internal')) {
    fail(`expected pg-cluster-v1.internal in MCP search output: ${textContent}`);
  }

  // Call memory_search with valid_at before validity
  const searchRpcPast = await sendRpc('tools/call', {
    name: 'memory_search',
    arguments: {
      query: 'pg-cluster',
      valid_at: '2025-01-01T00:00:00Z',
    },
  });
  const textPast = searchRpcPast.result.content?.[0]?.text ?? '';
  if (textPast.includes('pg-cluster-v1.internal')) {
    fail(`expected no results before valid_from in MCP search: ${textPast}`);
  }

  mcpProc.kill();
  ok('MCP memory_search with bi-temporal parameters passed');

  ok('all bi-temporal search engine tests passed');
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
