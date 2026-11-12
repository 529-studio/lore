import path from 'node:path';
import pc from 'picocolors';
import { requireRoot } from '../db.js';
import { ensureConfig, readConfig, writeConfig, type RemoteConfig } from '../config.js';

export interface RemoteOptions {
  path?: string;
  show?: boolean;
  postgres?: boolean;
  env?: string;
}

function describe(remote: RemoteConfig): string {
  if (remote.type === 'dir') return `dir  ${remote.path}`;
  if (remote.url_env) return `postgres  (url from $${remote.url_env})`;
  return 'postgres';
}

export function remoteCommand(opts: RemoteOptions): void {
  const root = requireRoot();
  const config = ensureConfig(root);

  if (opts.show || (!opts.path && !opts.postgres)) {
    if (!config.remote) {
      console.log(pc.yellow('no remote configured'));
      console.log(pc.dim('  lore remote <shared-directory>'));
      console.log(pc.dim('  lore remote --postgres --env LORE_REMOTE_URL'));
      return;
    }
    console.log(`remote  ${pc.bold(describe(config.remote))}`);
    console.log(pc.dim(`  repo_id ${config.repo_id}`));
    if (config.remote_main) console.log(pc.dim(`  last seen main ${config.remote_main}`));
    return;
  }

  let remote: RemoteConfig;
  if (opts.postgres) {
    if (opts.env) {
      if (!process.env[opts.env]) {
        console.log(pc.yellow(`[WARN] $${opts.env} is not set in this shell; fetch/push will fail until it is`));
      }
      remote = { type: 'postgres', url_env: opts.env };
    } else {
      if (!opts.path) throw new Error('lore remote --postgres needs a connection string or --env <NAME>');
      if (/:\/\/[^/@]+:[^/@]+@/.test(opts.path)) {
        console.log(pc.yellow('[WARN] the connection string contains a password and is stored in .lore/config.json'));
        console.log(pc.dim('  prefer: lore remote --postgres --env LORE_REMOTE_URL'));
      }
      remote = { type: 'postgres', url: opts.path };
    }
  } else {
    remote = { type: 'dir', path: path.resolve(opts.path!) };
  }

  writeConfig(root, { ...readConfig(root), repo_id: config.repo_id, remote });
  console.log(`${pc.green('✓')} remote set to ${describe(remote)}`);
  console.log(pc.dim('  table lore_bundles is created on first push'));
}
