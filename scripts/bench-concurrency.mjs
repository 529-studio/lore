#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import pc from 'picocolors';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');

const WORKLOAD_CYCLE = [
  'write',   // 0
  'search',  // 1
  'write',   // 2
  'sync',    // 3
  'write',   // 4
  'search',  // 5
  'commit',  // 6
  'write',   // 7
  'search',  // 8
  'write',   // 9
  'search',  // 10
  'write',   // 11
  'approve', // 12
  'sync',    // 13
  'write',   // 14
  'search',  // 15
  'write',   // 16
  'commit',  // 17
  'search',  // 18
  'sync',    // 19
];

/**
 * Deterministically determines operation type for step and worker offset.
 * Distribution: 40% write (8/20), 30% search (6/20), 15% commit/approve (3/20), 15% sync (3/20).
 */
export function getOperationType(step, workerId) {
  const offset = (workerId - 1) * 3;
  const cycleIndex = (step + offset) % WORKLOAD_CYCLE.length;
  return WORKLOAD_CYCLE[cycleIndex];
}

/**
 * Computes min, p50, p95, p99, and max percentiles for an array of latencies.
 * Handles empty arrays gracefully by returning 0 for all metrics.
 */
export function calculatePercentiles(latencies) {
  if (!latencies || latencies.length === 0) {
    return { min: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const getP = (p) => {
    if (sorted.length === 1) return sorted[0];
    const index = p * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  };

  return {
    min: sorted[0],
    p50: getP(0.5),
    p95: getP(0.95),
    p99: getP(0.99),
    max: sorted[sorted.length - 1],
  };
}

/**
 * Validates SQLite database integrity and data invariants after concurrent benchmark execution.
 */
export function auditDatabaseInvariants(dbPath, expectedWrites, expectedWorkers) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const check = db.prepare('PRAGMA integrity_check').all();
    if (check.length !== 1 || check[0].integrity_check !== 'ok') {
      throw new Error(`PRAGMA integrity_check failed: ${JSON.stringify(check)}`);
    }

    const totalWrites = db.prepare("SELECT COUNT(*) AS n FROM claim WHERE subject_id LIKE 'sym:worker-%'").get().n;
    if (totalWrites !== expectedWrites) {
      throw new Error(`claim count mismatch: expected ${expectedWrites}, found ${totalWrites}`);
    }

    const distinctClaims = db.prepare("SELECT COUNT(DISTINCT id) AS n FROM claim WHERE subject_id LIKE 'sym:worker-%'").get().n;
    if (distinctClaims !== expectedWrites) {
      throw new Error(`distinct claim ID mismatch: expected ${expectedWrites}, found ${distinctClaims}`);
    }

    const branchCount = db.prepare("SELECT COUNT(*) AS n FROM ref WHERE name LIKE 'agent/worker-%'").get().n;
    if (branchCount !== expectedWorkers) {
      throw new Error(`branch count mismatch: expected ${expectedWorkers}, found ${branchCount}`);
    }

    const syncLogs = db.prepare("SELECT COUNT(*) AS n FROM agent_action_log WHERE action IN ('SYNC_OUTGOING', 'SYNC_INCOMING')").get().n;
    if (syncLogs <= 0) {
      throw new Error(`sync action log mismatch: expected > 0 entries in agent_action_log, found ${syncLogs}`);
    }

    return {
      integrityOk: true,
      totalWrites,
      distinctClaims,
      branchCount,
      syncLogs,
    };
  } finally {
    db.close();
  }
}

function runLore(args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`lore ${args.join(' ')} failed (exit ${code}): ${stderr || stdout}`));
      }
    });
  });
}

export async function setupBenchmarkFixture() {
  const work = mkdtempSync(path.join(tmpdir(), 'lore-bench-concurrency-'));
  mkdirSync(path.join(work, 'src'), { recursive: true });
  writeFileSync(
    path.join(work, 'package.json'),
    JSON.stringify({ name: 'bench-concurrency-fixture', dependencies: {} }, null, 2),
  );
  writeFileSync(
    path.join(work, 'README.md'),
    '# Lore Concurrency Soak Fixture\n\nInitial repository baseline for soak benchmarking.\n',
  );
  writeFileSync(
    path.join(work, 'src', 'index.ts'),
    'export const fixture = true;\n',
  );

  const mockLitestream = path.join(work, 'mock-litestream');
  writeFileSync(mockLitestream, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  chmodSync(mockLitestream, 0o755);

  const env = {
    LORE_LITESTREAM_PATH: process.env.LORE_LITESTREAM_PATH ?? mockLitestream,
  };

  await runLore(['init'], work, env);
  await runLore(['ingest'], work, env);
  await runLore(
    ['replicate', 'config', '--replica', `file://${path.join(work, 'replica.db')}`],
    work,
    env,
  );

  return { work, mockLitestream };
}

export class BenchmarkClient {
  constructor(session, cwd, options = {}) {
    this.session = session;
    this.cwd = cwd;
    this.chunks = [];
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.child = spawn(process.execPath, [CLI, 'mcp'], {
      cwd: this.cwd,
      env: {
        ...process.env,
        LORE_SESSION: this.session,
        ...(options.env ?? {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', (c) => {
      this.chunks.push(c);
      this._pump();
    });
    this.child.stderr.on('data', () => {});
    this.child.on('error', (err) => {
      for (const [id, { reject }] of this.pending) {
        reject(err);
      }
      this.pending.clear();
    });
    this.child.on('exit', (code) => {
      if (this.pending.size > 0) {
        const err = new Error(`MCP client ${this.session} exited prematurely with code ${code}`);
        for (const [id, { reject }] of this.pending) {
          reject(err);
        }
        this.pending.clear();
      }
    });
  }

  _pump() {
    let text = Buffer.concat(this.chunks).toString();
    let idx;
    while ((idx = text.indexOf('\n')) !== -1) {
      const line = text.slice(0, idx).trim();
      text = text.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg);
        }
      } catch {
        // ignore malformed line
      }
    }
    this.chunks = text.length > 0 ? [Buffer.from(text)] : [];
  }

  call(method, params, { timeoutMs = 25_000 } = {}) {
    const id = ++this.nextId;
    const payload = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.session}: timeout waiting for response to ${method} (id=${id})`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async init() {
    await this.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: `bench-${this.session}`, version: '0.0.1' },
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;

    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }

    if (this.child.exitCode !== null) return;

    this.child.kill('SIGTERM');

    await new Promise((resolve) => {
      let killTimer;
      const onExit = () => {
        clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        resolve();
      };

      const termTimer = setTimeout(() => {
        if (this.child.exitCode === null) {
          try {
            this.child.kill('SIGKILL');
          } catch {
            // ignore
          }
          killTimer = setTimeout(onExit, 200);
        } else {
          onExit();
        }
      }, 1000);

      this.child.once('exit', onExit);
    });
  }
}

export async function executeOperation(client, workerId, step, opType) {
  const start = performance.now();
  let success = false;
  let error;

  try {
    let res;
    switch (opType) {
      case 'write': {
        res = await client.call('tools/call', {
          name: 'memory_write',
          arguments: {
            subject: `sym:worker-${workerId}.ts#fn${step}`,
            predicate: 'enforces_invariant',
            object: 'rule validation',
            kind: 'file',
            ref: 'README.md',
          },
        });
        break;
      }
      case 'search': {
        const query = step % 2 === 0 ? 'rule' : 'worker';
        res = await client.call('tools/call', {
          name: 'memory_search',
          arguments: {
            query,
            budget_tokens: 4000,
          },
        });
        break;
      }
      case 'approve': {
        res = await client.call('tools/call', {
          name: 'memory_approve',
          arguments: {},
        });
        break;
      }
      case 'commit': {
        res = await client.call('tools/call', {
          name: 'memory_commit',
          arguments: {
            message: `worker ${workerId} checkpoint ${step}`,
          },
        });
        break;
      }
      case 'sync': {
        res = await client.call('tools/call', {
          name: 'memory_sync',
          arguments: {},
        });
        break;
      }
      default:
        throw new Error(`Unknown operation type: ${opType}`);
    }

    if (res.error || res.result?.isError) {
      error = res.error?.message ?? JSON.stringify(res.result?.content ?? res.result);
      success = false;
    } else {
      success = true;
    }
  } catch (err) {
    error = err.message;
    success = false;
  }

  const durationMs = performance.now() - start;
  return {
    worker: workerId,
    op: opType,
    type: opType,
    durationMs,
    success,
    ...(error ? { error } : {}),
  };
}

export async function runWorker(client, workerId, opsCount) {
  const records = [];
  for (let step = 0; step < opsCount; step++) {
    const opType = getOperationType(step, workerId);
    const rec = await executeOperation(client, workerId, step, opType);
    records.push(rec);
  }
  return records;
}

export async function runBenchmark(options = {}) {
  const workers = options.workers ?? Number(process.env.LORE_SOAK_WORKERS ?? 4);
  const opsPerWorker = options.opsPerWorker ?? Number(process.env.LORE_SOAK_OPS ?? 25);

  const fixture = await setupBenchmarkFixture();
  const clients = [];
  let audit = null;

  try {
    for (let i = 0; i < workers; i++) {
      const client = new BenchmarkClient(`worker-${i + 1}`, fixture.work, {
        env: {
          LORE_LITESTREAM_PATH: fixture.mockLitestream,
        },
      });
      clients.push(client);
    }

    await Promise.all(clients.map((c) => c.init()));

    const benchStart = performance.now();
    const workerResults = await Promise.all(
      clients.map((client, idx) => runWorker(client, idx + 1, opsPerWorker)),
    );
    const benchDurationMs = performance.now() - benchStart;

    const allRecords = workerResults.flat();
    const expectedWrites = allRecords.filter((r) => r.op === 'write').length;

    // Gracefully terminate worker clients before inspecting database
    await Promise.all(clients.map((c) => c.close()));

    // Audit database invariants before deleting fixture workspace
    const dbPath = path.join(fixture.work, '.lore', 'lore.db');
    audit = auditDatabaseInvariants(dbPath, expectedWrites, workers);

    return {
      workDir: fixture.work,
      workers,
      opsPerWorker,
      totalOps: allRecords.length,
      expectedWrites,
      durationMs: benchDurationMs,
      records: allRecords,
      audit,
    };
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    try {
      rmSync(fixture.work, { recursive: true, force: true });
    } catch {
      // ignore teardown cleanup error
    }
  }
}

/**
 * Formats operation latencies into a clean box-drawing table.
 */
export function formatLatencyTable(records) {
  const opTypes = ['write', 'search', 'sync', 'commit', 'approve'];
  const rows = [];

  for (const op of opTypes) {
    const opRecords = records.filter((r) => r.op === op);
    if (opRecords.length === 0) continue;
    const passed = opRecords.filter((r) => r.success).length;
    const latencies = opRecords.map((r) => r.durationMs);
    const p = calculatePercentiles(latencies);
    rows.push({
      op,
      count: String(opRecords.length),
      success: `${passed}/${opRecords.length}`,
      min: p.min.toFixed(2),
      p50: p.p50.toFixed(2),
      p95: p.p95.toFixed(2),
      p99: p.p99.toFixed(2),
      max: p.max.toFixed(2),
    });
  }

  const allPassed = records.filter((r) => r.success).length;
  const allLatencies = records.map((r) => r.durationMs);
  const allP = calculatePercentiles(allLatencies);
  const totalRow = {
    op: 'total',
    count: String(records.length),
    success: `${allPassed}/${records.length}`,
    min: allP.min.toFixed(2),
    p50: allP.p50.toFixed(2),
    p95: allP.p95.toFixed(2),
    p99: allP.p99.toFixed(2),
    max: allP.max.toFixed(2),
  };

  const colWidths = {
    op: 10,
    count: 7,
    success: 9,
    min: 9,
    p50: 9,
    p95: 9,
    p99: 9,
    max: 9,
  };

  const padLeft = (str, len) => str.padStart(len);
  const padRight = (str, len) => str.padEnd(len);

  const top = '┌' + Object.values(colWidths).map((w) => '─'.repeat(w + 2)).join('┬') + '┐';
  const mid = '├' + Object.values(colWidths).map((w) => '─'.repeat(w + 2)).join('┼') + '┤';
  const bot = '└' + Object.values(colWidths).map((w) => '─'.repeat(w + 2)).join('┴') + '┘';

  const header =
    '│ ' +
    [
      padRight('Op Type', colWidths.op),
      padLeft('Count', colWidths.count),
      padLeft('Success', colWidths.success),
      padLeft('Min (ms)', colWidths.min),
      padLeft('p50 (ms)', colWidths.p50),
      padLeft('p95 (ms)', colWidths.p95),
      padLeft('p99 (ms)', colWidths.p99),
      padLeft('Max (ms)', colWidths.max),
    ].join(' │ ') +
    ' │';

  const formatRow = (r) =>
    '│ ' +
    [
      padRight(r.op, colWidths.op),
      padLeft(r.count, colWidths.count),
      padLeft(r.success, colWidths.success),
      padLeft(r.min, colWidths.min),
      padLeft(r.p50, colWidths.p50),
      padLeft(r.p95, colWidths.p95),
      padLeft(r.p99, colWidths.p99),
      padLeft(r.max, colWidths.max),
    ].join(' │ ') +
    ' │';

  return [
    pc.dim(top),
    pc.bold(header),
    pc.dim(mid),
    ...rows.map((r) => formatRow(r)),
    pc.dim(mid),
    pc.bold(formatRow(totalRow)),
    pc.dim(bot),
  ].join('\n');
}

/**
 * Prints comprehensive benchmark performance and invariant verification report.
 */
export function printReport(result) {
  const passed = result.records.filter((r) => r.success).length;
  const failed = result.records.filter((r) => !r.success);
  const throughput = ((result.totalOps / result.durationMs) * 1000).toFixed(1);

  console.log(
    pc.green(
      `[OK] benchmark finished: ${result.totalOps} ops in ${result.durationMs.toFixed(1)}ms (${throughput} ops/sec, ${passed}/${result.totalOps} succeeded)`,
    ),
  );

  console.log(formatLatencyTable(result.records));

  if (result.audit) {
    console.log(pc.green('[OK] SQLite PRAGMA integrity_check: ok'));
    console.log(
      pc.green(
        `[OK] claim uniqueness and write persistence: ${result.audit.totalWrites}/${result.expectedWrites}`,
      ),
    );
    console.log(
      pc.green(`[OK] branch continuity: ${result.audit.branchCount}/${result.workers}`),
    );
    console.log(pc.green(`[OK] action audit log entries: ${result.audit.syncLogs}`));
  }

  if (failed.length > 0) {
    console.error(pc.red(`[ERR] ${failed.length} operations failed`));
    for (const f of failed.slice(0, 5)) {
      console.error(pc.red(`  worker ${f.worker} op ${f.op}: ${f.error}`));
    }
  }
}

async function main() {
  const workers = Number(process.env.LORE_SOAK_WORKERS ?? 4);
  const opsPerWorker = Number(process.env.LORE_SOAK_OPS ?? 25);

  console.log(
    pc.green(
      `[OK] starting concurrency benchmark: ${workers} workers x ${opsPerWorker} ops (${workers * opsPerWorker} total)`,
    ),
  );
  const result = await runBenchmark({ workers, opsPerWorker });
  printReport(result);

  if (result.records.some((r) => !r.success)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(pc.red(`[ERR] benchmark crashed: ${err.message}`));
    process.exit(1);
  });
}
