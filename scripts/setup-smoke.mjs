import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');

const tmp = mkdtempSync(path.join(tmpdir(), 'lore-setup-smoke-'));

try {
  // Test config command
  execFileSync('node', [cli, 'init', '--root', tmp]);
  execFileSync('node', [cli, 'config', 'set', 'test_key', 'test_val', '--root', tmp]);
  const val = execFileSync('node', [cli, 'config', 'get', 'test_key', '--root', tmp], { encoding: 'utf8' }).trim();
  if (val !== 'test_val') throw new Error(`expected test_val, got ${val}`);

  execFileSync('node', [cli, 'config', 'unset', 'test_key', '--root', tmp]);
  const empty = execFileSync('node', [cli, 'config', 'get', 'test_key', '--root', tmp], { encoding: 'utf8' }).trim();
  if (empty !== '') throw new Error(`expected empty, got ${empty}`);

  // Test setup command for agy
  execFileSync('node', [cli, 'setup', 'agy', '--scope', 'project', '--root', tmp]);
  const agyFile = path.join(tmp, '.agents', 'mcp_config.json');
  if (!existsSync(agyFile)) throw new Error('agy config file not created');
  const agyJson = JSON.parse(readFileSync(agyFile, 'utf8'));
  if (agyJson.mcpServers?.lore?.env?.LORE_SESSION !== 'antigravity') {
    throw new Error('invalid agy config payload');
  }

  // Test setup command for claude
  execFileSync('node', [cli, 'setup', 'claude', '--scope', 'project', '--root', tmp]);
  const claudeFile = path.join(tmp, '.mcp.json');
  if (!existsSync(claudeFile)) throw new Error('claude config file not created');
  const claudeJson = JSON.parse(readFileSync(claudeFile, 'utf8'));
  if (claudeJson.mcpServers?.lore?.env?.LORE_SESSION !== 'claude') {
    throw new Error('invalid claude config payload');
  }

  // Test setup command for cursor
  execFileSync('node', [cli, 'setup', 'cursor', '--scope', 'project', '--root', tmp]);
  const cursorFile = path.join(tmp, '.cursor', 'mcp.json');
  if (!existsSync(cursorFile)) throw new Error('cursor config file not created');

  // Test setup command for codex
  execFileSync('node', [cli, 'setup', 'codex', '--scope', 'project', '--root', tmp]);
  const codexFile = path.join(tmp, '.codex', 'config.toml');
  if (!existsSync(codexFile)) throw new Error('codex config file not created');
  const toml = readFileSync(codexFile, 'utf8');
  if (!toml.includes('[mcp_servers.lore]')) throw new Error('codex toml missing lore section');

  // Test setup command for gemini
  execFileSync('node', [cli, 'setup', 'gemini', '--scope', 'project', '--root', tmp]);
  const geminiFile = path.join(tmp, '.gemini', 'settings.json');
  if (!existsSync(geminiFile)) throw new Error('gemini config file not created');

  // Test setup command for opencode
  execFileSync('node', [cli, 'setup', 'opencode', '--scope', 'project', '--root', tmp]);
  const opencodeFile = path.join(tmp, 'opencode.json');
  if (!existsSync(opencodeFile)) throw new Error('opencode config file not created');
  const opencodeJson = JSON.parse(readFileSync(opencodeFile, 'utf8'));
  if (opencodeJson.mcp?.servers?.lore?.environment?.LORE_SESSION !== 'opencode') {
    throw new Error('invalid opencode config payload');
  }

  // Test autonomous rules injection
  const agentsFile = path.join(tmp, 'AGENTS.md');
  if (!existsSync(agentsFile)) throw new Error('AGENTS.md rule file not created by setup');
  const agentsContent = readFileSync(agentsFile, 'utf8');
  if (!agentsContent.includes('lore:memory-protocol:start') || !agentsContent.includes('memory_search')) {
    throw new Error('AGENTS.md missing memory protocol');
  }

  // Test lore rules command idempotency
  execFileSync('node', [cli, 'rules', '--root', tmp]);
  const agentsContent2 = readFileSync(agentsFile, 'utf8');
  if (agentsContent2 !== agentsContent) {
    throw new Error('lore rules was not idempotent on AGENTS.md');
  }

  // Test lore rules --print
  const printed = execFileSync('node', [cli, 'rules', '--print'], { encoding: 'utf8' });
  if (!printed.includes('memory_search')) throw new Error('rules --print failed');

  // Test detectWorkspaceAgents
  const { detectWorkspaceAgents } = await import('../dist/commands/setup.js');
  const detected = detectWorkspaceAgents(tmp);
  if (!detected.ruleFiles.includes('AGENTS.md')) throw new Error('detectWorkspaceAgents failed to detect AGENTS.md');
  if (!detected.configuredAgents.includes('cursor')) throw new Error('detectWorkspaceAgents failed to detect cursor');
  if (!detected.configuredAgents.includes('claude')) throw new Error('detectWorkspaceAgents failed to detect claude');

  console.log('[OK] setup-smoke: config get/set/unset, setup agy/claude/cursor/codex/gemini/opencode, and agent rules injection passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
