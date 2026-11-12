import path from 'node:path';
import pc from 'picocolors';
import { requireRoot } from '../db.js';
import { ensureConfig, readConfig, writeConfig } from '../config.js';

export interface RemoteOptions {
  path?: string;
  show?: boolean;
}

export function remoteCommand(opts: RemoteOptions): void {
  const root = requireRoot();
  const config = ensureConfig(root);

  if (opts.show || !opts.path) {
    if (!config.remote) {
      console.log(pc.yellow('no remote configured'));
      console.log(pc.dim('  set one with: lore remote <shared-directory>'));
      return;
    }
    console.log(`remote  ${pc.bold('dir')}  ${config.remote.path}`);
    console.log(pc.dim(`  repo_id ${config.repo_id}`));
    if (config.remote_main) console.log(pc.dim(`  last seen main ${config.remote_main}`));
    return;
  }

  const target = path.resolve(opts.path);
  writeConfig(root, { ...readConfig(root), repo_id: config.repo_id, remote: { type: 'dir', path: target } });
  console.log(`${pc.green('✓')} remote set to ${target}`);
  console.log(pc.dim(`  bundles are stored as <remote>/${config.repo_id}.lorebundle`));
}
