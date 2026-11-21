#!/usr/bin/env node
// Smoke test for permissive trust mode (solo development vs team gating).
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const work = mkdtempSync(path.join(tmpdir(), 'lore-trust-smoke-'));

function lore(args, env = {}, cwd = work) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

async function callMcp(requests, cwd = work, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CLI, 'mcp'], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    proc.on('close', (code) => {
      const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
      const responses = lines.map((l) => JSON.parse(l));
      resolve({ code, responses, stderr });
    });

    proc.on('error', reject);

    for (const req of requests) {
      proc.stdin.write(JSON.stringify(req) + '\n');
    }
    proc.stdin.end();
  });
}

try {
  // --- Step 1: Default strict mode ---
  writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'trust-fixture' }));
  const initRes = lore(['init']);
  if (initRes.code !== 0) throw new Error(`init failed: ${initRes.stderr}`);

  // In default strict mode, agent write must be draft
  const writeStrict = lore([
    'write',
    '--subject',
    'sym:src/a.ts#calc',
    '--predicate',
    'enforces_invariant',
    '--object',
    'pure function',
    '--kind',
    'agent',
  ]);
  if (writeStrict.code !== 0) throw new Error(`write strict failed: ${writeStrict.stderr}`);
  if (!writeStrict.stdout.includes('draft')) {
    throw new Error(`expected draft state in strict mode, got: ${writeStrict.stdout}`);
  }

  // Draft must NOT be retrieved by search
  const searchStrict = lore(['search', 'calc']);
  if (searchStrict.stdout.includes('sym:src/a.ts#calc')) {
    throw new Error(`draft claim was unexpectedly retrieved in strict mode: ${searchStrict.stdout}`);
  }

  // --- Step 2: Enable permissive mode via config ---
  const configSet = lore(['config', 'set', 'trust_mode', 'permissive']);
  if (configSet.code !== 0) throw new Error(`config set failed: ${configSet.stderr}`);

  const configGet = lore(['config', 'get', 'trust_mode']);
  if (!configGet.stdout.includes('permissive')) {
    throw new Error(`expected trust_mode permissive, got: ${configGet.stdout}`);
  }

  const statusCheck = lore(['status']);
  if (!statusCheck.stdout.includes('mode: permissive')) {
    throw new Error(`lore status should report mode: permissive, got:\n${statusCheck.stdout}`);
  }

  // --- Step 3: Permissive mode write & immediate retrieval ---
  const writePermissive = lore([
    'write',
    '--subject',
    'sym:src/a.ts#validate',
    '--predicate',
    'enforces_invariant',
    '--object',
    'schema check',
    '--kind',
    'agent',
  ]);
  if (writePermissive.code !== 0) throw new Error(`write permissive failed: ${writePermissive.stderr}`);
  if (!writePermissive.stdout.includes('active')) {
    throw new Error(`expected active state in permissive mode, got: ${writePermissive.stdout}`);
  }

  // Active claim MUST be immediately retrieved by search in the session branch
  const searchPermissive = lore(['search', 'validate']);
  if (!searchPermissive.stdout.includes('sym:src/a.ts#validate')) {
    throw new Error(`active claim was not retrieved in permissive mode: ${searchPermissive.stdout}`);
  }

  // --- Step 4: MCP tool interactions with permissive mode ---
  const mcpRes = await callMcp([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_status', arguments: {} } },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'memory_write',
        arguments: {
          subject: 'sym:src/a.ts#mcpTest',
          predicate: 'enforces_invariant',
          object: 'mcp auto active',
          kind: 'agent',
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'memory_search',
        arguments: { query: 'mcpTest' },
      },
    },
  ]);

  const statusResult = mcpRes.responses.find((r) => r.id === 1)?.result;
  if (statusResult?.structuredContent?.trust_mode !== 'permissive') {
    throw new Error(`MCP memory_status expected trust_mode 'permissive', got: ${JSON.stringify(statusResult)}`);
  }

  const writeResult = mcpRes.responses.find((r) => r.id === 2)?.result;
  if (writeResult?.structuredContent?.state !== 'active') {
    throw new Error(`MCP memory_write expected state 'active' in permissive mode, got: ${JSON.stringify(writeResult)}`);
  }

  const searchResult = mcpRes.responses.find((r) => r.id === 3)?.result;
  const hits = searchResult?.structuredContent?.hits ?? [];
  const foundMcpClaim = hits.some((h) => h.subject === 'sym:src/a.ts#mcpTest');
  if (!foundMcpClaim) {
    throw new Error(`MCP memory_search failed to find newly written active claim: ${JSON.stringify(searchResult)}`);
  }

  // --- Step 5: Fail-closed override in team mode ---
  const TEAM_SECRET = 'team-secret-trust-1234567890';
  const aliceRes = lore(
    ['identity', 'issue', '--user', 'alice@company', '--role', 'maintainer'],
    { LORE_TEAM_SECRET: TEAM_SECRET },
  );
  if (aliceRes.code !== 0) throw new Error(`issue alice failed: ${aliceRes.stderr}`);
  const aliceToken = aliceRes.stdout.trim();

  const writeTeam = lore(
    [
      'write',
      '--subject',
      'sym:src/a.ts#teamSecret',
      '--predicate',
      'enforces_invariant',
      '--object',
      'team secure',
      '--kind',
      'agent',
    ],
    { LORE_TEAM_SECRET: TEAM_SECRET, LORE_TOKEN: aliceToken },
  );
  if (writeTeam.code !== 0) throw new Error(`write team mode failed: ${writeTeam.stderr}`);
  if (!writeTeam.stdout.includes('draft')) {
    throw new Error(`expected team mode to force draft even when permissive configured, got: ${writeTeam.stdout}`);
  }

  // --- Step 6: Test lore init --solo ---
  const workSolo = mkdtempSync(path.join(tmpdir(), 'lore-solo-init-'));
  try {
    writeFileSync(path.join(workSolo, 'package.json'), JSON.stringify({ name: 'solo-app' }));
    const initSolo = lore(['init', '--solo'], {}, workSolo);
    if (initSolo.code !== 0) throw new Error(`init --solo failed: ${initSolo.stderr}`);

    const cfg = JSON.parse(readFileSync(path.join(workSolo, '.lore', 'config.json'), 'utf8'));
    if (cfg.trust_mode !== 'permissive') {
      throw new Error(`expected .lore/config.json to have trust_mode permissive, got: ${JSON.stringify(cfg)}`);
    }

    const writeSolo = lore(
      ['write', '--subject', 'sym:src/b.ts#solo', '--predicate', 'enforces_invariant', '--object', 'solo ok', '--kind', 'agent'],
      {},
      workSolo,
    );
    if (!writeSolo.stdout.includes('active')) {
      throw new Error(`expected active claim on solo repo, got: ${writeSolo.stdout}`);
    }
  } finally {
    rmSync(workSolo, { recursive: true, force: true });
  }

  console.log('[OK] permissive-trust-smoke: all assertions passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
