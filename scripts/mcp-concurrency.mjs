#!/usr/bin/env node
// Concurrency proof: several MCP servers writing to one store at the same time.
// The realistic case is two agents (Claude + Codex) on one repository; this runs
// four and asserts nothing is lost, duplicated, or locked out.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');

const SERVERS = Number(process.env.LORE_CONCURRENCY_SERVERS ?? 4);
const WRITES = Number(process.env.LORE_CONCURRENCY_WRITES ?? 25);

const work = mkdtempSync(path.join(tmpdir(), 'lore-concurrency-'));
mkdirSync(path.join(work, 'src'));
writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'concurrency-app' }));
writeFileSync(path.join(work, 'README.md'), '# Concurrency fixture\n\n## Scope\n');
writeFileSync(path.join(work, 'src', 'app.ts'), 'const url = process.env.APP_URL;\nexport default url;\n');

function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: work, env: { ...process.env, ...env } });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`lore ${args.join(' ')} exit ${code}: ${stderr}`))));
  });
}

await run(['init']);
await run(['ingest']);

class Client {
  constructor(session) {
    this.session = session;
    this.child = spawn(process.execPath, [CLI, 'mcp'], {
      cwd: work,
      env: { ...process.env, LORE_SESSION: session },
    });
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 0;
    this.child.stdout.on('data', (chunk) => this.pump(chunk.toString()));
    this.child.stderr.on('data', () => {});
  }

  pump(text) {
    this.buffer += text;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = this.pending.get(message.id);
      if (resolve) {
        this.pending.delete(message.id);
        resolve(message);
      }
    }
  }

  call(method, params) {
    const id = ++this.nextId;
    const payload = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.session}: timeout on ${method}`));
      }, 20_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async init() {
    await this.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: `conc-${this.session}`, version: '0.0.1' },
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  close() {
    this.child.kill();
  }
}

const clients = Array.from({ length: SERVERS }, (_, i) => new Client(`conc${i + 1}`));
await Promise.all(clients.map((client) => client.init()));

const errors = [];
await Promise.all(
  clients.map(async (client, serverIndex) => {
    for (let i = 0; i < WRITES; i += 1) {
      const response = await client.call('tools/call', {
        name: 'memory_write',
        arguments: {
          subject: `concept:conc-${serverIndex + 1}-${i + 1}`,
          predicate: 'verified_by',
          object: `session ${serverIndex + 1} claim ${i + 1}`,
          kind: 'file',
          ref: 'README.md',
        },
      });
      if (response.error || response.result?.isError) {
        errors.push(JSON.stringify(response.error ?? response.result));
      }
    }
  }),
);

for (const client of clients) client.close();

const db = new Database(path.join(work, '.lore', 'lore.db'), { readonly: true });
const total = db.prepare("SELECT COUNT(*) AS n FROM claim WHERE subject_id LIKE 'concept:conc-%'").get().n;
const distinct = db.prepare("SELECT COUNT(DISTINCT id) AS n FROM claim WHERE subject_id LIKE 'concept:conc-%'").get().n;
const branches = db
  .prepare("SELECT COUNT(*) AS n FROM ref WHERE name LIKE 'agent/conc%'")
  .get().n;
db.close();

const expected = SERVERS * WRITES;
const problems = [];
if (errors.length) problems.push(`${errors.length} tool errors: ${errors.slice(0, 2).join(' | ')}`);
if (total !== expected) problems.push(`expected ${expected} claims, found ${total}`);
if (distinct !== expected) problems.push(`expected ${expected} distinct ids, found ${distinct}`);
if (branches !== SERVERS) problems.push(`expected ${SERVERS} agent branches, found ${branches}`);

if (problems.length) {
  console.error(`[ERR] concurrency: ${problems.join('; ')}`);
  process.exit(1);
}

console.log(
  `[OK] concurrency: ${SERVERS} MCP servers x ${WRITES} writes = ${total} claims, ${branches} branches, no lost writes`,
);
