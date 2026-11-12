import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { ensureConfig, readConfig, writeConfig } from '../config.js';
import { head } from '../model.js';
import { fetchFromDir } from '../sync.js';

export interface FetchOptions {
  path?: string;
  author?: string;
}

export function fetchCommand(opts: FetchOptions): void {
  const root = requireRoot();
  const db = openDb(root);
  const config = ensureConfig(root);
  const dir = opts.path ? opts.path : config.remote?.path;

  if (!dir) throw new Error('no remote configured; run: lore remote <shared-directory>');

  const result = fetchFromDir(db, root, dir, config.repo_id, opts.author ?? 'human:fetch');
  writeConfig(root, { ...readConfig(root), repo_id: config.repo_id, remote_main: head(db, 'main') });

  console.log(
    `${pc.green('✓')} fetched: ${result.claims} claim row(s), ${result.commits} commit row(s), merge ${result.merge}`,
  );
  db.close();
}
