import pc from 'picocolors';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { requireRoot } from '../db.js';
import { ensureConfig, readConfig, writeConfig } from '../config.js';
import {
  checkLitestreamInstalled,
  defaultLitestreamConfigPath,
  generateLitestreamConfig,
  listReplicaGenerations,
  restoreFromReplica,
  spawnLitestreamReplicate,
  writeLitestreamConfig,
} from '../sync/litestream.js';

export interface ReplicateCommandOptions {
  replica?: string;
  config?: string;
  out?: string;
  retention?: string;
  syncInterval?: string;
  timestamp?: string;
}

export async function replicateCommand(
  action: string | undefined,
  opts: ReplicateCommandOptions,
): Promise<void> {
  const root = requireRoot();
  const subAction = action ?? 'status';
  if (subAction !== 'check') {
    console.log(
      pc.yellow(
        '[WARN] Litestream replicates one SQLite writer: use it for an explicit single-writer backup, never as multi-writer team sync. Team sync: lore remote + fetch/push or lore sync.',
      ),
    );
  }

  if (subAction === 'check') {
    const res = checkLitestreamInstalled();
    if (res.installed) {
      console.log(`${pc.green('[OK]')} litestream binary found: ${pc.bold(res.binary!)}`);
      if (res.version) console.log(pc.dim(`  version: ${res.version}`));
    } else {
      console.log(`${pc.red('[ERR]')} litestream executable not found in PATH.`);
      console.log(pc.dim('  Install Litestream to enable streaming replication:'));
      console.log(pc.dim('    macOS:  brew install litestream'));
      console.log(pc.dim('    Linux:  https://litestream.io/install'));
      console.log(pc.dim('    Or set: export LORE_LITESTREAM_PATH=/path/to/litestream'));
      process.exitCode = 1;
    }
    return;
  }

  if (subAction === 'config') {
    const config = ensureConfig(root);
    const replicaUrl = opts.replica ?? config.litestream?.replica_url;
    if (!replicaUrl) {
      throw new Error(
        'replica URL is required (specify --replica <url>, e.g. s3://bucket/lore.db or file:///backup/lore.db)',
      );
    }

    const outPath = opts.out ? path.resolve(opts.out) : defaultLitestreamConfigPath(root);
    writeLitestreamConfig(
      root,
      {
        replicaUrl,
        retention: opts.retention ?? config.litestream?.retention,
        syncInterval: opts.syncInterval ?? config.litestream?.sync_interval,
      },
      outPath,
    );

    // Save in .lore/config.json
    writeConfig(root, {
      ...readConfig(root),
      repo_id: config.repo_id,
      litestream: {
        replica_url: replicaUrl,
        config_path: outPath,
        retention: opts.retention,
        sync_interval: opts.syncInterval,
      },
    });

    console.log(`${pc.green('[OK]')} wrote Litestream configuration to ${pc.bold(outPath)}`);
    console.log(pc.dim(`  replica target: ${replicaUrl}`));
    return;
  }

  if (subAction === 'start') {
    const check = checkLitestreamInstalled();
    if (!check.installed) {
      console.log(`${pc.red('[ERR]')} cannot start replication daemon: litestream not installed.`);
      console.log(pc.dim('  Run: lore replicate check for setup instructions.'));
      process.exitCode = 1;
      return;
    }

    const config = readConfig(root);
    const replicaUrl = opts.replica ?? config?.litestream?.replica_url;
    const configPath = opts.config ?? config?.litestream?.config_path;

    if (!configPath && !replicaUrl && !existsSync(defaultLitestreamConfigPath(root))) {
      throw new Error(
        'No litestream configuration found. Run: lore replicate config --replica <url>',
      );
    }

    console.log(`${pc.green('[OK]')} starting Litestream streaming replication daemon...`);
    if (replicaUrl) console.log(pc.dim(`  replica: ${replicaUrl}`));

    const child = spawnLitestreamReplicate(root, {
      configPath,
      replicaUrl,
      onLog: (line) => process.stdout.write(line),
      onError: (err) => console.error(pc.red(`[ERR] ${err.message}`)),
    });

    const cleanup = (): void => {
      console.log(pc.dim('\nshutting down replication daemon...'));
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    await new Promise<void>((resolve) => {
      child.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          console.error(pc.red(`[ERR] replication daemon exited with code ${code}`));
          process.exitCode = code;
        } else {
          console.log(pc.dim('replication daemon exited cleanly.'));
        }
        resolve();
      });
    });
    return;
  }

  if (subAction === 'restore') {
    const config = readConfig(root);
    const replicaUrl = opts.replica ?? config?.litestream?.replica_url;
    if (!replicaUrl) {
      throw new Error(
        'replica URL is required for restore (specify --replica <url>, e.g. s3://bucket/lore.db)',
      );
    }

    console.log(`${pc.dim('restoring SQLite database from replica:')} ${replicaUrl}`);
    const restoredPath = await restoreFromReplica(root, replicaUrl, {
      timestamp: opts.timestamp,
      outputPath: opts.out,
      configPath: opts.config,
    });
    console.log(`${pc.green('[OK]')} restored database to ${pc.bold(restoredPath)}`);
    return;
  }

  if (subAction === 'status') {
    const check = checkLitestreamInstalled();
    const config = readConfig(root);
    const defaultCfg = defaultLitestreamConfigPath(root);
    const cfgExists = existsSync(defaultCfg);

    console.log(pc.bold('Litestream Streaming Replication Status:'));
    console.log(`  installed:   ${check.installed ? pc.green(`yes (${check.version ?? check.binary})`) : pc.yellow('no (run: lore replicate check)')}`);
    console.log(`  config file: ${cfgExists ? pc.green(defaultCfg) : pc.dim('none configured')}`);
    if (config?.litestream?.replica_url) {
      console.log(`  replica URL: ${pc.bold(config.litestream.replica_url)}`);
    }

    if (check.installed && (config?.litestream?.replica_url || cfgExists)) {
      try {
        const generations = await listReplicaGenerations(
          root,
          opts.replica ?? config?.litestream?.replica_url,
          { configPath: cfgExists ? defaultCfg : undefined },
        );
        if (generations.length) {
          console.log(`  generations: ${pc.green(String(generations.length))}`);
          for (const g of generations) {
            console.log(pc.dim(`    • ${g.generation} (created ${g.created})`));
          }
        } else {
          console.log(pc.dim('  generations: none recorded yet on replica'));
        }
      } catch {
        // ignore status check network errors
      }
    }
    return;
  }

  throw new Error(
    `Unknown action: ${subAction}. Supported actions: check, config, start, restore, status`,
  );
}
