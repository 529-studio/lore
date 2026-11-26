import pc from 'picocolors';
import { openDb, requireRoot, type DB } from '../db.js';
import { ensureConfig, remoteLabel } from '../config.js';
import { createSyncAdapter } from '../sync/adapter.js';

export interface SyncCommandOptions {
  replica?: string;
  author?: string;
  config?: string;
}

export async function syncCommand(opts: SyncCommandOptions): Promise<void> {
  let db: DB | undefined;
  try {
    const root = requireRoot();
    const config = ensureConfig(root);
    // A configured team remote wins. `--replica` (or a bare litestream config)
    // selects the single-writer backup adapter instead.
    const replicaUrl = opts.replica ?? (config.remote ? undefined : config.litestream?.replica_url);
    if (!config.remote && !replicaUrl) {
      throw new Error(
        'no remote configured; run lore remote --hub <url> / --postgres / <dir>, or pass --replica <url> for a single-writer Litestream backup',
      );
    }

    db = openDb(root);
    const author = opts.author ?? 'human:sync';
    const remote = opts.replica ? undefined : config.remote;
    const adapter = await createSyncAdapter(db, root, {
      replicaUrl,
      configPath: opts.config ?? config.litestream?.config_path,
      remote,
    });
    const target = replicaUrl ?? remoteLabel(remote!);

    if (adapter.kind === 'litestream') {
      console.log(
        pc.yellow(
          '[WARN] Litestream sync is a single-writer backup tool; use a team remote (http, postgres, dir) for multi-writer sync',
        ),
      );
    }

    console.log(`${pc.dim('sync:pull')} via ${pc.bold(adapter.kind)} ${target}...`);
    const pullRes = await adapter.pull({ author });
    console.log(
      `${pc.green('[OK]')} pulled ${pullRes.commits} commits, ${pullRes.claims} claims (merge: ${pullRes.merge})`,
    );

    console.log(`${pc.dim('sync:push')} via ${pc.bold(adapter.kind)} ${target}...`);
    const pushRes = await adapter.push({ author });
    console.log(
      `${pc.green('[OK]')} pushed tip ${pushRes.tip ? pc.bold(pushRes.tip.slice(0, 7)) : 'empty'} (checkpointed: ${pushRes.walCheckpointed})`,
    );
  } catch (err: unknown) {
    console.error(`${pc.red('[ERR]')} ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
