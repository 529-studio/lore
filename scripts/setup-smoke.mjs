import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  // Test setup command for codex with pre-existing sections, legacy broken block, [[array]] table, and idempotent re-run
  const codexFile = path.join(tmp, '.codex', 'config.toml');
  mkdirSync(path.dirname(codexFile), { recursive: true });
  writeFileSync(
    codexFile,
    `# existing config\n[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "server-github"]\n\n[mcp_servers.github.env]\nGITHUB_TOKEN = "placeholder"\n\n[mcp_servers.lore]\ncommand = "lore"\nargs = ["mcp"]\nenv = {\n  LORE_SESSION = "old"\n}\n\n[projects."/tmp/example"]\ntrust_level = "trusted"\n\n[[custom_entries]]\nname = "keep-me"\n`,
    'utf8',
  );
  execFileSync('node', [cli, 'setup', 'codex', '--scope', 'project', '--root', tmp]);
  if (!existsSync(codexFile)) throw new Error('codex config file not created');
  const toml1 = readFileSync(codexFile, 'utf8');
  if (!toml1.includes('[mcp_servers.lore]') || !toml1.includes('[mcp_servers.lore.env]')) {
    throw new Error('codex toml missing [mcp_servers.lore] or [mcp_servers.lore.env]');
  }
  if (/env\s*=\s*\{\s*\n/.test(toml1) || toml1.includes('LORE_SESSION = "old"')) {
    throw new Error('codex toml still contains legacy multiline inline env block');
  }
  if (!toml1.includes('[mcp_servers.github]') || !toml1.includes('[mcp_servers.github.env]')) {
    throw new Error('codex toml did not preserve unrelated mcp_servers.github sections');
  }
  if (!toml1.includes('[projects."/tmp/example"]') || !toml1.includes('[[custom_entries]]')) {
    throw new Error('codex toml did not preserve [projects] or [[custom_entries]] sections');
  }
  // Re-run must be byte-identical and not duplicate sections
  execFileSync('node', [cli, 'setup', 'codex', '--scope', 'project', '--root', tmp]);
  const toml2 = readFileSync(codexFile, 'utf8');
  if (toml2 !== toml1) throw new Error('lore setup codex was not idempotent on .codex/config.toml');
  // Parse TOML with Python tomllib when available
  try {
    execFileSync(
      'python3',
      [
        '-c',
        'import sys, tomllib; d = tomllib.load(open(sys.argv[1], "rb")); assert d["mcp_servers"]["lore"]["env"]["LORE_SESSION"] == "codex"; assert d["mcp_servers"]["github"]["command"] == "npx"; assert len(d["custom_entries"]) == 1',
        codexFile,
      ],
      { stdio: 'pipe' },
    );
  } catch (err) {
    if (err && typeof err === 'object' && 'status' in err && err.status !== 0 && !String(err).includes('No module named')) {
      throw new Error(`codex toml failed tomllib validation: ${String(err)}`);
    }
  }
  // Validate with real codex CLI if installed (isolated CODEX_HOME so project config is actually parsed)
  let hasCodex = false;
  try {
    execFileSync('which', ['codex'], { stdio: 'ignore' });
    hasCodex = true;
  } catch {
    hasCodex = false;
  }
  if (hasCodex) {
    const codexOut = execFileSync('codex', ['mcp', 'list'], {
      cwd: tmp,
      env: { ...process.env, CODEX_HOME: path.join(tmp, '.codex') },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!codexOut.includes('lore') || !codexOut.includes('github')) {
      throw new Error(`codex mcp list did not load lore and github from CODEX_HOME: ${codexOut}`);
    }
  }
  // Verify lore write --help uses English (no Vietnamese 'vd')
  const writeHelp = execFileSync('node', [cli, 'write', '--help'], { encoding: 'utf8' });
  if (/\bvd\b/.test(writeHelp) || writeHelp.includes('declares_dependency')) {
    throw new Error(`lore write --help contains invalid help text: ${writeHelp}`);
  }

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

  // Test lore onboard --yes on a repo with .cursor/
  const tmpOnboard = mkdtempSync(path.join(tmpdir(), 'lore-onboard-smoke-'));
  try {
    writeFileSync(path.join(tmpOnboard, 'package.json'), JSON.stringify({ name: 'onboard-test' }), 'utf8');
    mkdirSync(path.join(tmpOnboard, '.cursor'), { recursive: true });
    execFileSync('node', [cli, 'onboard', '--yes', '--path', tmpOnboard]);
    const cursorFile = path.join(tmpOnboard, '.cursor', 'mcp.json');
    if (!existsSync(cursorFile)) throw new Error('onboard did not configure cursor mcp');
    const cursorJson = JSON.parse(readFileSync(cursorFile, 'utf8'));
    if (!cursorJson.mcpServers?.lore) throw new Error('onboard cursor mcp missing lore entry');
  } finally {
    rmSync(tmpOnboard, { recursive: true, force: true });
  }

  console.log('[OK] setup-smoke: config get/set/unset, setup agy/claude/cursor/codex/gemini/opencode, and agent rules injection passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
