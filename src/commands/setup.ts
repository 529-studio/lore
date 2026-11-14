import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import pc from 'picocolors';

export type AgentName = 'agy' | 'claude' | 'cursor' | 'codex' | 'gemini';
export const SUPPORTED_AGENTS: AgentName[] = ['agy', 'claude', 'cursor', 'codex', 'gemini'];

export interface SetupOptions {
  agent?: string;
  scope?: 'project' | 'global';
  session?: string;
  bin?: string;
  root?: string;
  all?: boolean;
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

function updateTomlMcpConfig(
  filePath: string,
  serverName: string,
  command: string,
  args: string[],
  env: Record<string, string>,
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  let content = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const sectionHeader = `[mcp_servers.${serverName}]`;
  const envPairs = Object.entries(env)
    .map(([k, v]) => `  ${k} = "${v}"`)
    .join('\n');
  const sectionBlock = `${sectionHeader}\ncommand = "${command}"\nargs = [${args.map((a) => `"${a}"`).join(', ')}]\nenv = {\n${envPairs}\n}\n`;

  const regex = new RegExp(`\\[mcp_servers\\.${serverName}\\][\\s\\S]*?(?=\\n\\[|$)`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, sectionBlock.trim());
  } else {
    content = `${content.trim()}\n\n${sectionBlock}`.trim() + '\n';
  }
  writeFileSync(filePath, content, 'utf8');
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
    isInstalled: () => existsSync(path.join(homedir(), '.gemini')) || isBinaryOnPath('agy'),
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
    isInstalled: () => existsSync(path.join(homedir(), '.claude')) || isBinaryOnPath('claude'),
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
    isInstalled: () => existsSync(path.join(homedir(), '.codex')) || isBinaryOnPath('codex'),
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
    isInstalled: () => existsSync(path.join(homedir(), '.gemini')) || isBinaryOnPath('gemini'),
    applyConfig: (filePath, cmd, session) => {
      updateJsonMcpConfig(filePath, 'lore', {
        command: cmd.command,
        args: cmd.args,
        env: { LORE_SESSION: session },
      });
    },
  },
};

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

  console.log(`\n${pc.bold('Next steps:')}`);
  console.log(`  1. Restart your coding agent or reload MCP servers.`);
  console.log(`  2. Start a session: your agent will access Lore memory on branch agent/<session>.`);
}
