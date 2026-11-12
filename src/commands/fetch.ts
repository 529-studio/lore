import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { ensureConfig, readConfig, writeConfig } from '../config.js';
import { head } from '../model.js';
import { fastForwardSession, fetchFromDir, importBundle } from '../sync.js';
import { pgFetch } from '../remotes/postgres.js';

export interface FetchOptions {
  path?: string;
  author?: string;
}

export async function fetchCommand(opts: FetchOptions): Promise<void> {
  const root = requireRoot();
  const db = openDb(root);
  const config = ensureConfig(root);
  const author = opts.author ?? 'human:fetch';

  if (!config.remote && !opts.path) throw new Error('no remote configured; run: lore remote <shared-directory>');
  if (!config.remote && opts.path) throw new Error('no remote configured; set one with lore remote');

  let result;
  if (opts.path) {
    result = fetchFromDir(db, root, opts.path, config.repo_id, author);
  } else if (config.remote!.type === 'dir') {
    result = fetchFromDir(db, root, config.remote!.path, config.repo_id, author);
  } else {
    const url = config.remote!.url ?? (config.remote!.url_env ? process.env[config.remote!.url_env] : undefined);
    if (!url) throw new Error(`remote url is not set (env ${config.remote!.url_env ?? 'LORE_REMOTE_URL'})`);
    result = await pgFetch(url, config.repo_id, (bundle) => importBundle(db, root, bundle, { author }));
  }

  fastForwardSession(db, root);
  writeConfig(root, { ...readConfig(root), repo_id: config.repo_id, remote_main: head(db, 'main') });
  console.log(
    `${pc.green('✓')} fetched: ${result.claims} claim row(s), ${result.commits} commit row(s), merge ${result.merge}`,
  );
  db.close();
}
