import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { ensureConfig, readConfig, writeConfig } from '../config.js';
import { head } from '../model.js';
import { buildBundle, fastForwardSession, importBundle, pushToDir } from '../sync.js';
import { pgPush } from '../remotes/postgres.js';

export interface PushOptions {
  path?: string;
  author?: string;
}

export async function pushCommand(opts: PushOptions): Promise<void> {
  const root = requireRoot();
  const db = openDb(root);
  const config = ensureConfig(root);
  const author = opts.author ?? 'human:push';

  if (!config.remote && !opts.path) throw new Error('no remote configured; run: lore remote <shared-directory>');
  if (!head(db, 'main')) throw new Error('main has no commits yet; run lore ingest and lore promote');

  let imported;
  if (opts.path) {
    imported = pushToDir(db, root, opts.path, config.repo_id, author);
  } else if (config.remote!.type === 'dir') {
    imported = pushToDir(db, root, config.remote!.path, config.repo_id, author);
  } else {
    const url = config.remote!.url ?? (config.remote!.url_env ? process.env[config.remote!.url_env] : undefined);
    if (!url) throw new Error(`remote url is not set (env ${config.remote!.url_env ?? 'LORE_REMOTE_URL'})`);
    imported = await pgPush(
      url,
      config.repo_id,
      (bundle) => importBundle(db, root, bundle, { author }),
      () => buildBundle(db, config.repo_id),
    );
  }

  fastForwardSession(db, root);
  const main = head(db, 'main');
  writeConfig(root, { ...readConfig(root), repo_id: config.repo_id, remote_main: main });
  console.log(
    `${pc.green('✓')} pushed main ${main?.slice(0, 12)} (imported ${imported.claims} remote row(s), merge ${imported.merge})`,
  );
  db.close();
}
