#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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
      this.chunks = text.length > 0 ? [Buffer.from(text)] : [];
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
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    this.child.kill('SIGTERM');
    if (this.child.exitCode === null) {
      await new Promise((r) => {
        const timer = setTimeout(r, 200);
        this.child.once('exit', () => {
          clearTimeout(timer);
          r();
        });
      });
    }
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
    return {
      workDir: fixture.work,
      workers,
      opsPerWorker,
      totalOps: allRecords.length,
      durationMs: benchDurationMs,
      records: allRecords,
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

async function main() {
  const workers = Number(process.env.LORE_SOAK_WORKERS ?? 4);
  const opsPerWorker = Number(process.env.LORE_SOAK_OPS ?? 25);

  console.log(`[OK] starting concurrency benchmark: ${workers} workers x ${opsPerWorker} ops (${workers * opsPerWorker} total)`);
  const result = await runBenchmark({ workers, opsPerWorker });

  const passed = result.records.filter((r) => r.success).length;
  const failed = result.records.filter((r) => !r.success);
  const throughput = ((result.totalOps / result.durationMs) * 1000).toFixed(1);

  console.log(
    `[OK] benchmark finished: ${result.totalOps} ops in ${result.durationMs.toFixed(1)}ms (${throughput} ops/sec, ${passed}/${result.totalOps} succeeded)`,
  );

  const breakdown = {};
  for (const r of result.records) {
    if (!breakdown[r.op]) breakdown[r.op] = { total: 0, passed: 0 };
    breakdown[r.op].total++;
    if (r.success) breakdown[r.op].passed++;
  }

  for (const [op, stats] of Object.entries(breakdown)) {
    console.log(`  ${op.padEnd(8)}: ${stats.passed}/${stats.total} successful`);
  }

  if (failed.length > 0) {
    console.error(`[ERR] ${failed.length} operations failed`);
    for (const f of failed.slice(0, 5)) {
      console.error(`  worker ${f.worker} op ${f.op}: ${f.error}`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`[ERR] benchmark crashed: ${err.message}`);
    process.exit(1);
  });
}
