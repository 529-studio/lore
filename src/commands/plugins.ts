import pc from 'picocolors';
import path from 'node:path';
import { findWorkspaceRoot } from '../db.js';
import { listPlugins, personalConfigPath } from '../plugins/loader.js';

export interface PluginsOptions {
  root?: string;
  json?: boolean;
}

/**
 * Diagnose which extension points are active and from where. Warnings are part
 * of the output: a repo extractor declared in personal config is rejected, and
 * the user has to see why.
 */
export async function pluginsCommand(opts: PluginsOptions = {}): Promise<void> {
  const root = opts.root ? path.resolve(opts.root) : findWorkspaceRoot();
  const warnings: string[] = [];
  const plugins = await listPlugins(root, { warn: (message) => warnings.push(message) });

  if (opts.json) {
    console.log(JSON.stringify({ personalConfig: personalConfigPath(), root, plugins, warnings }, null, 2));
    return;
  }

  console.log(pc.bold('plugins'));
  console.log(`  personal config  ${pc.dim(personalConfigPath())}`);
  console.log(`  repository       ${pc.dim(root)}`);
  if (!plugins.length) {
    console.log(pc.dim('\nno plugins configured'));
  }
  for (const plugin of plugins) {
    console.log(
      `\n  ${pc.green('[OK]')} ${pc.bold(plugin.name)} ${pc.dim(`(${plugin.source})`)}`,
    );
    console.log(`    ${plugin.file}`);
    console.log(`    ${plugin.capabilities.join(', ') || 'no extension points'}`);
    for (const warning of plugin.warnings) console.log(`    ${pc.yellow('[WARN]')} ${warning}`);
  }
  for (const warning of warnings) console.log(`${pc.yellow('[WARN]')} ${warning}`);
  console.log(
    pc.dim(
      '\npersonal plugins may resolve context, add agent hosts and run hooks; repository plugins may add deterministic extractors',
    ),
  );
}
