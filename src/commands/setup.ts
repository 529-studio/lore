import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import pc from 'picocolors';
import { installAgentRules } from './rules.js';

export type AgentName = 'agy' | 'claude' | 'cursor' | 'codex' | 'gemini' | 'opencode';
export const SUPPORTED_AGENTS: AgentName[] = ['agy', 'claude', 'cursor', 'codex', 'gemini', 'opencode'];

export interface SetupOptions {
  agent?: string;
  scope?: 'project' | 'global';
  session?: string;
  bin?: string;
  root?: string;
  all?: boolean;
  rules?: boolean;
}

function isBinaryOnPath(name: string): boolean {
  try {
    const out = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return Boolean(out);
  } catch {
    return false;
  }
}

function resolveLoreCommand(customBin?: string): { command: string; args: string[] } {
  if (customBin) {
    return { command: customBin, args: ['mcp'] };
  }
  if (isBinaryOnPath('lore')) {
    return { command: 'lore', args: ['mcp'] };
  }
  const cli = process.argv[1] ? path.resolve(process.argv[1]) : 'lore';
  if (cli.endsWith('.js') || cli.endsWith('.ts')) {
    return { command: 'node', args: [cli, 'mcp'] };
  }
  return { command: cli, args: ['mcp'] };
}

function updateJsonMcpConfig(filePath: string, serverName: string, config: Record<string, unknown>): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  let content: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      content = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      content = {};
    }
  }
  if (!content.mcpServers || typeof content.mcpServers !== 'object') {
    content.mcpServers = {};
  }
  (content.mcpServers as Record<string, unknown>)[serverName] = config;
  writeFileSync(filePath, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

function stripTomlServerSections(content: string, serverName: string): string {
  const prefix = `mcp_servers.${serverName}`;
  const kept: string[] = [];
  let skipping = false;
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:\[\[([^\]]+)\]\]|\[([^\[\]]+)\])\s*(?:#.*)?$/.exec(line);
    if (match) {
      const tableName = (match[1] ?? match[2] ?? '').trim();
      skipping = !match[1] && (tableName === prefix || tableName.startsWith(`${prefix}.`));
      if (skipping) continue;
    }
    if (!skipping) kept.push(line);
  }
  return kept.join('\n').replace(/\n+$/, '');
}

function updateTomlMcpConfig(
  filePath: string,
  serverName: string,
  command: string,
  args: string[],
  env: Record<string, string>,
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const base = stripTomlServerSections(existing, serverName);
  const envEntries = Object.entries(env);
  const envBlock = envEntries.length
    ? `\n[mcp_servers.${serverName}.env]\n${envEntries.map(([k, v]) => `${k} = ${tomlString(v)}`).join('\n')}\n`
    : '';
  const sectionBlock = `[mcp_servers.${serverName}]\ncommand = ${tomlString(command)}\nargs = [${args.map(tomlString).join(', ')}]\n${envBlock}`;
  const next = base ? `${base}\n\n${sectionBlock}` : sectionBlock;
  writeFileSync(filePath, next, 'utf8');
}

function updateOpencodeMcpConfig(
  filePath: string,
  serverName: string,
  commandArray: string[],
  environment: Record<string, string>,
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  let content: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const cleaned = raw.replace(/^\s*\/\/.*$/gm, '');
      content = JSON.parse(cleaned);
    } catch {
      content = {};
    }
  }
  if (!content.mcp || typeof content.mcp !== 'object') {
    content.mcp = {};
  }
  const mcp = content.mcp as Record<string, unknown>;
  if (!mcp.servers || typeof mcp.servers !== 'object') {
    mcp.servers = {};
  }
  const servers = mcp.servers as Record<string, unknown>;
  servers[serverName] = {
    type: 'local',
    command: commandArray,
    environment,
    enabled: true,
  };
  writeFileSync(filePath, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
}

interface AgentDefinition {
  name: AgentName;
  displayName: string;
  defaultSession: string;
  getConfigFile: (root: string, scope: 'project' | 'global') => string;
  isInstalled: (root: string) => boolean;
  applyConfig: (filePath: string, cmd: { command: string; args: string[] }, session: string) => void;
}

const AGENTS: Record<AgentName, AgentDefinition> = {
  agy: {
    name: 'agy',
    displayName: 'Antigravity CLI (agy)',
    defaultSession: 'antigravity',
    getConfigFile: (root, scope) =>
      scope === 'global'
        ? path.join(homedir(), '.gemini', 'config', 'mcp_config.json')
        : path.join(root, '.agents', 'mcp_config.json'),
    isInstalled: (root) =>
      existsSync(path.join(homedir(), '.gemini')) ||
      existsSync(path.join(root, '.agents')) ||
      isBinaryOnPath('agy'),
    applyConfig: (filePath, cmd, session) => {
      updateJsonMcpConfig(filePath, 'lore', {
        command: cmd.command,
        args: cmd.args,
        env: { LORE_SESSION: session },
      });
    },
  },
  claude: {
    name: 'claude',
    displayName: 'Claude Code',
    defaultSession: 'claude',
    getConfigFile: (root, scope) =>
      scope === 'global' ? path.join(homedir(), '.claude', 'settings.json') : path.join(root, '.mcp.json'),
    isInstalled: (root) =>
      existsSync(path.join(homedir(), '.claude')) ||
      existsSync(path.join(root, '.mcp.json')) ||
      existsSync(path.join(root, 'CLAUDE.md')) ||
      isBinaryOnPath('claude'),
    applyConfig: (filePath, cmd, session) => {
      updateJsonMcpConfig(filePath, 'lore', {
        command: cmd.command,
        args: cmd.args,
        env: { LORE_SESSION: session },
      });
    },
  },
  cursor: {
    name: 'cursor',
    displayName: 'Cursor',
    defaultSession: 'cursor',
    getConfigFile: (root, scope) =>
      scope === 'global' ? path.join(homedir(), '.cursor', 'mcp.json') : path.join(root, '.cursor', 'mcp.json'),
    isInstalled: (root) =>
      existsSync(path.join(homedir(), '.cursor')) ||
      existsSync(path.join(root, '.cursor')) ||
      existsSync(path.join(root, '.cursorrules')) ||
      existsSync('/Applications/Cursor.app'),
    applyConfig: (filePath, cmd, session) => {
      updateJsonMcpConfig(filePath, 'lore', {
        command: cmd.command,
        args: cmd.args,
        env: { LORE_SESSION: session },
      });
    },
  },
  codex: {
    name: 'codex',
    displayName: 'Codex CLI',
    defaultSession: 'codex',
    getConfigFile: (root, scope) =>
      scope === 'global' ? path.join(homedir(), '.codex', 'config.toml') : path.join(root, '.codex', 'config.toml'),
    isInstalled: (root) =>
      existsSync(path.join(homedir(), '.codex')) ||
      existsSync(path.join(root, '.codex')) ||
      isBinaryOnPath('codex'),
    applyConfig: (filePath, cmd, session) => {
      updateTomlMcpConfig(filePath, 'lore', cmd.command, cmd.args, { LORE_SESSION: session });
    },
  },
  gemini: {
    name: 'gemini',
    displayName: 'Gemini CLI',
    defaultSession: 'gemini',
    getConfigFile: (root, scope) =>
      scope === 'global' ? path.join(homedir(), '.gemini', 'settings.json') : path.join(root, '.gemini', 'settings.json'),
    isInstalled: (root) =>
      existsSync(path.join(homedir(), '.gemini')) ||
      existsSync(path.join(root, '.gemini')) ||
      isBinaryOnPath('gemini'),
    applyConfig: (filePath, cmd, session) => {
      updateJsonMcpConfig(filePath, 'lore', {
        command: cmd.command,
        args: cmd.args,
        env: { LORE_SESSION: session },
      });
    },
  },
  opencode: {
    name: 'opencode',
    displayName: 'OpenCode',
    defaultSession: 'opencode',
    getConfigFile: (root, scope) =>
      scope === 'global'
        ? (existsSync(path.join(homedir(), '.config', 'opencode', 'opencode.jsonc'))
            ? path.join(homedir(), '.config', 'opencode', 'opencode.jsonc')
            : path.join(homedir(), '.config', 'opencode', 'opencode.json'))
        : (existsSync(path.join(root, 'opencode.jsonc')) ? path.join(root, 'opencode.jsonc') : path.join(root, 'opencode.json')),
    isInstalled: (root) =>
      existsSync(path.join(homedir(), '.config', 'opencode')) ||
      existsSync(path.join(root, 'opencode.json')) ||
      existsSync(path.join(root, 'opencode.jsonc')) ||
      isBinaryOnPath('opencode'),
    applyConfig: (filePath, cmd, session) => {
      updateOpencodeMcpConfig(filePath, 'lore', [cmd.command, ...cmd.args], { LORE_SESSION: session });
    },
  },
};

export interface WorkspaceAgentDetection {
  installedAgents: AgentName[];
  configuredAgents: AgentName[];
  ruleFiles: string[];
  hasCode: boolean;
  codeSignals: string[];
}

export function detectWorkspaceAgents(root: string): WorkspaceAgentDetection {
  const has = (rel: string) => existsSync(path.join(root, rel));

  const ruleCandidates = [
    'AGENTS.md',
    'CLAUDE.md',
    '.cursorrules',
    '.cursor/rules',
    '.github/copilot-instructions.md',
    '.windsurfrules',
  ];
  const ruleFiles = ruleCandidates.filter(has);

  const configuredAgents: AgentName[] = [];
  if (has('.cursor/mcp.json') || has('.cursorrules') || has('.cursor')) configuredAgents.push('cursor');
  if (has('.mcp.json') || has('CLAUDE.md') || has('.claude')) configuredAgents.push('claude');
  if (has('.agents/mcp_config.json') || has('.agents')) configuredAgents.push('agy');
  if (has('.codex/config.toml') || has('.codex')) configuredAgents.push('codex');
  if (has('.gemini/settings.json') || has('.gemini')) configuredAgents.push('gemini');
  if (has('opencode.json') || has('opencode.jsonc')) configuredAgents.push('opencode');

  const installedAgents: AgentName[] = [];
  for (const name of SUPPORTED_AGENTS) {
    if (AGENTS[name].isInstalled(root)) {
      installedAgents.push(name);
    }
  }

  const codeFiles = [
    'package.json',
    'pyproject.toml',
    'go.mod',
    'Cargo.toml',
    'pom.xml',
    'build.gradle',
    'composer.json',
  ];
  const codeHits = codeFiles.filter(has);
  const dirHits = ['src', 'app', 'lib'].filter(has);
  const codeSignals = [...codeHits, ...dirHits.map((d) => `${d}/`)];
  const hasCode = codeSignals.length > 0;

  return {
    installedAgents: [...new Set(installedAgents)],
    configuredAgents: [...new Set(configuredAgents)],
    ruleFiles,
    hasCode,
    codeSignals,
  };
}

export function setupCommand(target?: string, opts: SetupOptions = {}): void {
  const root = path.resolve(opts.root ?? process.cwd());
  const scope: 'project' | 'global' = opts.scope ?? 'project';
  const cmd = resolveLoreCommand(opts.bin);

  const targets: AgentName[] = [];

  if (opts.all || target === 'all') {
    for (const name of SUPPORTED_AGENTS) {
      if (AGENTS[name].isInstalled(root)) {
        targets.push(name);
      }
    }
    if (!targets.length) {
      // If none explicitly detected, configure all standard ones
      targets.push(...SUPPORTED_AGENTS);
    }
  } else if (target) {
    const normalized = target.toLowerCase() as AgentName;
    if (!SUPPORTED_AGENTS.includes(normalized)) {
      throw new Error(`unknown agent "${target}"; supported: ${SUPPORTED_AGENTS.join(', ')}, all`);
    }
    targets.push(normalized);
  } else {
    // If no agent specified, detect installed agents or show list
    for (const name of SUPPORTED_AGENTS) {
      if (AGENTS[name].isInstalled(root)) {
        targets.push(name);
      }
    }
    if (!targets.length) {
      console.log(`[WARN] No supported coding agents automatically detected.`);
      console.log(`Specify an agent to configure: lore setup <${SUPPORTED_AGENTS.join('|')}>`);
      return;
    }
  }

  console.log(`Configuring Lore MCP for ${targets.length} agent(s) (scope: ${scope})...`);

  for (const agentName of targets) {
    const def = AGENTS[agentName];
    const session = opts.session ?? def.defaultSession;
    const configFile = def.getConfigFile(root, scope);

    try {
      def.applyConfig(configFile, cmd, session);
      console.log(`  ${pc.green('[OK]')} ${pc.bold(def.displayName)}: wrote ${configFile} (session: ${session})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ${pc.red('[ERR]')} ${def.displayName}: failed to write ${configFile}: ${msg}`);
    }
  }

  if (opts.rules !== false) {
    console.log(`\n${pc.bold('Agent memory directives:')}`);
    const rulesResults = installAgentRules(root, { targets });
    for (const r of rulesResults) {
      if (r.action === 'created') {
        console.log(`  ${pc.green('[OK]')} Created ${pc.bold(r.file)} with autonomous memory protocol`);
      } else if (r.action === 'appended') {
        console.log(`  ${pc.green('[OK]')} Injected autonomous memory protocol into ${pc.bold(r.file)}`);
      } else if (r.action === 'updated') {
        console.log(`  ${pc.green('[OK]')} Updated autonomous memory protocol in ${pc.bold(r.file)}`);
      } else {
        console.log(`  ${pc.dim('[OK]')} ${pc.dim(r.file)}: memory protocol already present`);
      }
    }
  }

  console.log(`\n${pc.bold('Next steps:')}`);
  console.log(`  1. Restart your coding agent or reload MCP servers.`);
  console.log(`  2. Start a session: your agent will access Lore memory on branch agent/<session>.`);
}
