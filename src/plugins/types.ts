/**
 * Extension surface for personal hosts and repository extractors.
 *
 * Two strict scopes:
 * - personal plugins (~/.config/lore/config.yml) may resolve the execution
 *   context, register agent hosts, and run lifecycle hooks; they may not change
 *   what `lore ingest` extracts.
 * - repository plugins (.lore.yml) may only register deterministic extractors,
 *   so every teammate produces the same ingest claim set.
 */
export interface PluginContext {
  workspaceRoot?: string;
  stateDir?: string;
  session?: string;
}

export interface PluginMcpCommand {
  command: string;
  args: string[];
}

export interface AgentHostAdapter {
  name: string;
  displayName: string;
  defaultSession: string;
  getConfigFile(root: string, scope: 'project' | 'global'): string;
  isInstalled(root: string): boolean;
  applyConfig(filePath: string, cmd: PluginMcpCommand, session: string): void;
}

export interface PluginHooks {
  beforeSession?(ctx: Required<Pick<PluginContext, 'workspaceRoot' | 'stateDir'>> & { session: string }): void | Promise<void>;
  afterWrapup?(ctx: Required<Pick<PluginContext, 'workspaceRoot'>> & { session: string; into: string }): void | Promise<void>;
}

export interface PluginExtractor {
  name: string;
  /** Deterministic: same checkout plus same root yields the same candidates. */
  extract(root: string): PluginExtractorCandidate[];
}

export interface PluginExtractorCandidate {
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
  evidenceRef?: string;
}

export interface LorePlugin {
  name?: string;
  resolveContext?(cwd: string): PluginContext;
  agentHosts?: AgentHostAdapter[];
  hooks?: PluginHooks;
  extractors?: PluginExtractor[];
}
