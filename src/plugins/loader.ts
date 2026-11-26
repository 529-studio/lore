import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { readManifest } from '../manifest.js';
import type { AgentHostAdapter, LorePlugin, PluginContext, PluginExtractor, PluginExtractorCandidate, PluginHooks } from './types.js';

export type PluginSource = 'personal' | 'repo';

export interface LoadedPlugin {
  file: string;
  source: PluginSource;
  plugin: LorePlugin;
  warnings: string[];
}

const PERSONAL_KEYS = ['name', 'resolveContext', 'agentHosts', 'hooks'] as const;
const REPO_KEYS = ['name', 'extractors'] as const;

export function personalConfigPath(): string {
  const override = process.env.LORE_PERSONAL_CONFIG?.trim();
  if (override) return path.resolve(override);
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), '.config');
  return path.join(base, 'lore', 'config.yml');
}

function pluginListFrom(file: string): string[] {
  if (!existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot parse ${file}: ${(error as Error).message}`);
  }
  if (raw === null || raw === undefined) return [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file} must be a mapping with a plugins list`);
  }
  const unknown = Object.keys(raw as Record<string, unknown>).filter((key) => key !== 'plugins');
  if (unknown.length) throw new Error(`${file} has unknown key ${unknown[0]}`);
  const plugins = 'plugins' in raw ? raw.plugins : undefined;
  if (plugins === undefined) return [];
  if (!Array.isArray(plugins) || !plugins.every((entry) => typeof entry === 'string' && entry.trim())) {
    throw new Error(`${file}: plugins must be a list of file paths`);
  }
  return (plugins as string[]).map((entry) => entry.trim());
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validatePlugin(value: unknown, file: string): LorePlugin {
  const mod = isObject(value) && 'default' in value ? value.default : value;
  if (!isObject(mod)) throw new Error(`${file}: plugin must export a default object`);
  const plugin = mod as unknown as LorePlugin;
  if (plugin.name !== undefined && typeof plugin.name !== 'string') {
    throw new Error(`${file}: plugin name must be a string`);
  }
  if (plugin.resolveContext !== undefined && typeof plugin.resolveContext !== 'function') {
    throw new Error(`${file}: resolveContext must be a function`);
  }
  if (plugin.agentHosts !== undefined && !Array.isArray(plugin.agentHosts)) {
    throw new Error(`${file}: agentHosts must be a list`);
  }
  for (const host of plugin.agentHosts ?? []) {
    if (
      !isObject(host) ||
      typeof host.name !== 'string' ||
      typeof host.displayName !== 'string' ||
      typeof host.defaultSession !== 'string' ||
      typeof host.getConfigFile !== 'function' ||
      typeof host.isInstalled !== 'function' ||
      typeof host.applyConfig !== 'function'
    ) {
      throw new Error(`${file}: agent host adapters need name, displayName, defaultSession, getConfigFile, isInstalled and applyConfig`);
    }
  }
  if (plugin.hooks !== undefined && !isObject(plugin.hooks)) throw new Error(`${file}: hooks must be an object`);
  if (plugin.extractors !== undefined && !Array.isArray(plugin.extractors)) {
    throw new Error(`${file}: extractors must be a list`);
  }
  for (const extractor of plugin.extractors ?? []) {
    if (!isObject(extractor) || typeof extractor.name !== 'string' || typeof extractor.extract !== 'function') {
      throw new Error(`${file}: extractors need a name and an extract(root) function`);
    }
  }
  return { ...plugin };
}

async function loadFile(file: string, source: PluginSource): Promise<LoadedPlugin> {
  // Plugin module specifiers are runtime-selected from user/repo configuration,
  // so they cannot be static imports.
  const mod = await import(pathToFileURL(file).href);
  const plugin = validatePlugin({ ...mod }, file);
  return { file, source, plugin, warnings: [] };
}

/**
 * Enforce the scope contract: a personal plugin cannot mutate ingest output,
 * and a repository plugin cannot rewire the host or execution context.
 */
function enforceScope(loaded: LoadedPlugin, dropped: string[]): void {
  const allowed = loaded.source === 'personal' ? PERSONAL_KEYS : REPO_KEYS;
  for (const [recorded, capability] of Object.entries(loaded.plugin)) {
    if (capability === undefined || capability === null) continue;
    if ((allowed as readonly string[]).includes(recorded)) continue;
    delete (loaded.plugin as unknown as Record<string, unknown>)[recorded];
    const warning =
      loaded.source === 'personal'
        ? `personal plugin ${path.basename(loaded.file)} cannot register ${recorded}; only repository plugins may do that`
        : `repository plugin ${path.basename(loaded.file)} cannot register ${recorded}; only personal plugins may do that`;
    loaded.warnings.push(warning);
    dropped.push(warning);
  }
}

export interface LoadPluginsOptions {
  /** Called with non-fatal warnings (scope violations, missing files). */
  warn?: (message: string) => void;
}

export async function loadPersonalPlugins(opts: LoadPluginsOptions = {}): Promise<LoadedPlugin[]> {
  const config = personalConfigPath();
  let entries: string[];
  try {
    entries = pluginListFrom(config);
  } catch (error) {
    opts.warn?.(`cannot read personal plugin config: ${(error as Error).message}`);
    return [];
  }
  const loaded: LoadedPlugin[] = [];
  for (const entry of entries) {
    const file = path.resolve(path.dirname(config), entry.replace(/^~(?=$|\/)/, homedir()));
    if (!existsSync(file)) {
      opts.warn?.(`personal plugin not found: ${file}`);
      continue;
    }
    try {
      const plugin = await loadFile(file, 'personal');
      const dropped: string[] = [];
      enforceScope(plugin, dropped);
      for (const message of plugin.warnings) opts.warn?.(message);
      loaded.push(plugin);
    } catch (error) {
      opts.warn?.(`cannot load personal plugin ${file}: ${(error as Error).message}`);
    }
  }
  return loaded;
}

export async function loadRepoPlugins(root: string, opts: LoadPluginsOptions = {}): Promise<LoadedPlugin[]> {
  const manifest = readManifest(root);
  const entries = manifest?.plugins ?? [];
  const loaded: LoadedPlugin[] = [];
  for (const entry of entries) {
    const file = path.resolve(root, entry);
    if (!existsSync(file)) {
      opts.warn?.(`repository plugin not found: ${entry}`);
      continue;
    }
    let target: string;
    try {
      target = realpathSync(file);
    } catch (error) {
      opts.warn?.(`cannot resolve repository plugin ${entry}: ${(error as Error).message}`);
      continue;
    }
    const realRoot = realpathSync(root);
    if (target !== realRoot && !target.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`repository plugin must stay inside the checkout: ${entry}`);
    }
    try {
      const plugin = await loadFile(target, 'repo');
      const dropped: string[] = [];
      enforceScope(plugin, dropped);
      for (const message of plugin.warnings) opts.warn?.(message);
      loaded.push(plugin);
    } catch (error) {
      opts.warn?.(`cannot load repository plugin ${entry}: ${(error as Error).message}`);
    }
  }
  return loaded;
}

/**
 * Personal plugins loaded at CLI startup. `lore setup` uses this cache so its
 * command stays synchronous; context overrides are applied through the same
 * environment contract as LORE_WORKSPACE_ROOT / LORE_STATE_DIR / LORE_SESSION.
 */
let personalCache: LoadedPlugin[] = [];

export function cachedPersonalPlugins(): LoadedPlugin[] {
  return personalCache;
}

export interface AppliedContext extends PluginContext {
  warnings: string[];
}

/**
 * Load personal plugins once per process, apply resolveContext overrides to the
 * environment when the caller has not already set them, and return the merged
 * context. Async because plugins are ESM.
 */
export async function applyPersonalContext(cwd = process.cwd()): Promise<AppliedContext> {
  const warnings: string[] = [];
  personalCache = await loadPersonalPlugins({ warn: (message) => warnings.push(message) });
  const merged: PluginContext = {};
  for (const loaded of personalCache) {
    if (!loaded.plugin.resolveContext) continue;
    try {
      const ctx = loaded.plugin.resolveContext(cwd) ?? {};
      merged.workspaceRoot ??= ctx.workspaceRoot;
      merged.stateDir ??= ctx.stateDir;
      merged.session ??= ctx.session;
    } catch (error) {
      warnings.push(`resolveContext failed in ${path.basename(loaded.file)}: ${(error as Error).message}`);
    }
  }
  if (merged.workspaceRoot && !process.env.LORE_WORKSPACE_ROOT) {
    process.env.LORE_WORKSPACE_ROOT = path.resolve(cwd, merged.workspaceRoot);
  }
  if (merged.stateDir && !process.env.LORE_STATE_DIR) {
    process.env.LORE_STATE_DIR = merged.stateDir;
  }
  if (merged.session && !process.env.LORE_SESSION) {
    process.env.LORE_SESSION = merged.session;
  }
  return { ...merged, warnings };
}

/** Plugin hooks run in load order; a broken hook never blocks a command. */
export function runSessionHook(
  hook: keyof PluginHooks,
  ctx: Parameters<NonNullable<PluginHooks[keyof PluginHooks]>>[0],
  warn: (message: string) => void = () => {},
): void {
  for (const loaded of personalCache) {
    const fn = loaded.plugin.hooks?.[hook] as ((arg: typeof ctx) => void | Promise<void>) | undefined;
    if (!fn) continue;
    try {
      const result = fn(ctx);
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch((error: unknown) => {
          warn(`hook ${hook} failed in ${path.basename(loaded.file)}: ${(error as Error).message}`);
        });
      }
    } catch (error) {
      warn(`hook ${hook} failed in ${path.basename(loaded.file)}: ${(error as Error).message}`);
    }
  }
}

export interface ExtractResult {
  candidates: PluginExtractorCandidate[];
  warnings: string[];
  extractors: PluginExtractor[];
}

/**
 * Run repository extractors in declaration order. Determinism requires a pure
 * `extract(root)`; the loader does not inject time, network, or env.
 */
export async function collectRepoExtractors(root: string): Promise<ExtractResult> {
  const warnings: string[] = [];
  const loaded = await loadRepoPlugins(root, { warn: (message) => warnings.push(message) });
  const extractors = loaded.flatMap((entry) => entry.plugin.extractors ?? []);
  const candidates: PluginExtractorCandidate[] = [];
  for (const extractor of extractors) {
    try {
      candidates.push(...extractor.extract(root));
    } catch (error) {
      warnings.push(`extractor ${extractor.name} failed: ${(error as Error).message}`);
    }
  }
  return { candidates, warnings, extractors };
}

export function pluginHosts(): AgentHostAdapter[] {
  return personalCache.flatMap((loaded) => loaded.plugin.agentHosts ?? []);
}

export interface PluginSummary {
  file: string;
  source: PluginSource;
  name: string;
  capabilities: string[];
  warnings: string[];
}

export async function listPlugins(root: string, opts: LoadPluginsOptions = {}): Promise<PluginSummary[]> {
  const warnings: string[] = [];
  const personal = await loadPersonalPlugins({ warn: (message) => { warnings.push(message); opts.warn?.(message); } });
  const repo = await loadRepoPlugins(root, { warn: (message) => { warnings.push(message); opts.warn?.(message); } });
  return [...personal, ...repo].map((loaded) => ({
    file: loaded.file,
    source: loaded.source,
    name: loaded.plugin.name ?? path.basename(loaded.file, path.extname(loaded.file)),
    capabilities: Object.entries(loaded.plugin)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key]) => key),
    warnings: loaded.warnings,
  }));
}
