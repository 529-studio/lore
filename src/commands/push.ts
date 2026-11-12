import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { ensureConfig, readConfig, writeConfig } from '../config.js';
import { head } from '../model.js';
import { pushToDir } from '../sync.js';

export interface PushOptions {
  path?: string;
  author?: string;
}

export function pushCommand(opts: PushOptions): void {
  const root = requireRoot();
  const db = openDb(root);
  const config = ensureConfig(root);
  const dir = opts.path ? opts.path : config.remote?.path;

  if (!dir) throw new Error('no remote configured; run: lore remote <shared-directory>');
  if (!head(db, 'main')) throw new Error('main has no commits yet; run lore ingest and lore promote');

  const imported = pushToDir(db, root, dir, config.repo_id, opts.author ?? 'human:push');
  const main = head(db, 'main');
  writeConfig(root, { ...readConfig(root), repo_id: config.repo_id, remote_main: main });

  console.log(
    `${pc.green('✓')} pushed main ${main?.slice(0, 12)} (imported ${imported.claims} remote row(s), merge ${imported.merge})`,
  );
  db.close();
}
