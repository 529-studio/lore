import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');

const tmp = mkdtempSync(path.join(tmpdir(), 'lore-init-smoke-'));

try {
  // Step 1: Set up simulated pre-existing repository with code, rules, and existing MCP config
  writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({
      name: 'pre-existing-app',
      version: '1.0.0',
      dependencies: {
        express: '^4.19.0',
        zod: '^3.23.0',
      },
    }, null, 2),
    'utf8',
  );

  mkdirSync(path.join(tmp, 'src'), { recursive: true });
  writeFileSync(
    path.join(tmp, 'src', 'server.ts'),
    'export const port = process.env.API_PORT || 8080;\n',
    'utf8',
  );

  const initialAgentsRule = '# Pre-existing Agent Rules\n\nAlways maintain type safety and run linting.\n';
  writeFileSync(path.join(tmp, 'AGENTS.md'), initialAgentsRule, 'utf8');

  mkdirSync(path.join(tmp, '.cursor'), { recursive: true });
  const initialCursorMcp = {
    mcpServers: {
      github: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
      },
    },
  };
  writeFileSync(path.join(tmp, '.cursor', 'mcp.json'), JSON.stringify(initialCursorMcp, null, 2), 'utf8');

  // Step 2: Initialize git repo in tmp so git and branch features work
  execFileSync('git', ['init', '-b', 'main', tmp]);
  execFileSync('git', ['-C', tmp, 'config', 'user.name', 'Tester']);
  execFileSync('git', ['-C', tmp, 'config', 'user.email', 'tester@example.com']);
  execFileSync('git', ['-C', tmp, 'add', '.']);
  execFileSync('git', ['-C', tmp, 'commit', '-m', 'chore: initial pre-existing codebase']);

  // Step 3: Test bare init detection warning on pre-existing project
  const tmpBare = mkdtempSync(path.join(tmpdir(), 'lore-init-bare-'));
  writeFileSync(path.join(tmpBare, 'package.json'), JSON.stringify({ name: 'bare-pkg' }), 'utf8');
  writeFileSync(path.join(tmpBare, 'AGENTS.md'), '# Bare Rules\n', 'utf8');
  const bareOut = execFileSync('node', [cli, 'init', '--root', tmpBare], { encoding: 'utf8' });
  if (!bareOut.includes('[NOTE] Detected pre-existing project')) {
    throw new Error(`expected bare init to show detection warning, got:\n${bareOut}`);
  }
  if (!bareOut.includes('AGENTS.md')) {
    throw new Error('expected bare init to detect AGENTS.md');
  }
  rmSync(tmpBare, { recursive: true, force: true });

  // Step 4: Run lore init --full --solo on the pre-existing project
  const fullOut = execFileSync(
    'node',
    [cli, 'init', '--full', '--solo', '--root', tmp],
    { encoding: 'utf8' },
  );

  // Assert store creation
  if (!existsSync(path.join(tmp, '.lore', 'lore.db'))) {
    throw new Error('.lore/lore.db was not created');
  }

  // Assert solo permissive mode configured
  const trustMode = execFileSync('node', [cli, 'config', 'get', 'trust_mode', '--root', tmp], {
    encoding: 'utf8',
  }).trim();
  if (trustMode !== 'permissive') {
    throw new Error(`expected trust_mode to be permissive, got: ${trustMode}`);
  }

  // Assert non-destructive rule preservation and marker injection
  const updatedAgents = readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8');
  if (!updatedAgents.startsWith(initialAgentsRule.trimEnd())) {
    throw new Error('pre-existing AGENTS.md rules were wiped or corrupted');
  }
  if (!updatedAgents.includes('<!-- lore:memory-protocol:start -->')) {
    throw new Error('lore memory protocol marker missing from AGENTS.md');
  }

  // Assert non-destructive MCP config preservation and merge
  const cursorMcp = JSON.parse(readFileSync(path.join(tmp, '.cursor', 'mcp.json'), 'utf8'));
  if (!cursorMcp.mcpServers?.github) {
    throw new Error('pre-existing github MCP server was dropped from .cursor/mcp.json');
  }
  if (!cursorMcp.mcpServers?.lore) {
    throw new Error('lore MCP server was not injected into .cursor/mcp.json');
  }

  // Assert codebase facts were ingested into active memory
  const searchOut = execFileSync('node', [cli, 'search', 'express'], {
    cwd: tmp,
    encoding: 'utf8',
  });
  if (!searchOut.includes('pkg:express')) {
    throw new Error(`expected search to find pkg:express in ingested memory, got:\n${searchOut}`);
  }

  // Step 5: Test idempotency (re-running init --full must succeed cleanly)
  const rerunOut = execFileSync(
    'node',
    [cli, 'init', '--full', '--solo', '--root', tmp],
    { encoding: 'utf8' },
  );
  const rerunAgents = readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8');
  const startMatches = rerunAgents.match(/<!-- lore:memory-protocol:start -->/g) || [];
  if (startMatches.length !== 1) {
    throw new Error(`expected exactly 1 protocol marker block, found ${startMatches.length}`);
  }

  console.log('[OK] init-existing-repo-smoke passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
