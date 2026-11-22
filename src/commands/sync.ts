import pc from 'picocolors';
import { openDb, requireRoot, type DB } from '../db.js';
import { ensureConfig } from '../config.js';
import { createSyncAdapter } from '../sync/adapter.js';
import { fastForwardSession } from '../sync.js';

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
    const replicaUrl =
      opts.replica ??
      config.litestream?.replica_url ??
      (config.remote?.type === 'dir' ? config.remote.path : undefined);

    if (!replicaUrl) {
      throw new Error(
        'replica URL is required (specify --replica <url> or configure via lore replicate config --replica <url>)',
      );
    }

    db = openDb(root);
    const author = opts.author ?? 'human:sync';
    const adapter = await createSyncAdapter(db, root, {
      replicaUrl,
      configPath: opts.config ?? config.litestream?.config_path,
    });

    console.log(`${pc.dim('sync:pull')} from ${pc.bold(replicaUrl)}...`);
    const pullRes = await adapter.pull({ author });
    fastForwardSession(db, root);
    console.log(
      `${pc.green('[OK]')} pulled ${pullRes.commits} commits, ${pullRes.claims} claims (merge: ${pullRes.merge})`,
    );

    console.log(`${pc.dim('sync:push')} to ${pc.bold(replicaUrl)}...`);
    const pushRes = await adapter.push({ author });
    console.log(
      `${pc.green('[OK]')} pushed tip ${pushRes.tip ? pc.bold(pushRes.tip.slice(0, 7)) : 'empty'} (checkpointed: ${pushRes.walCheckpointed})`,
    );
  } catch (err: any) {
    console.error(`${pc.red('[ERR]')} ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
