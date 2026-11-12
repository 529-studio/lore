import { existsSync } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { ensureConfig } from '../config.js';
import { buildBundle, importBundle, readBundle, writeBundle } from '../sync.js';

export interface BundleOptions {
  action?: string;
  file?: string;
  force?: boolean;
  author?: string;
}

export function bundleCommand(opts: BundleOptions): void {
  const root = requireRoot();
  const db = openDb(root);
  const config = ensureConfig(root);

  if (opts.action === 'export') {
    if (!opts.file) throw new Error('bundle export requires --out <file>');
    const out = path.resolve(opts.file);
    writeBundle(out, buildBundle(db, config.repo_id));
    console.log(`${pc.green('✓')} wrote ${out} ${pc.dim(`(repo ${config.repo_id})`)}`);
    db.close();
    return;
  }

  if (opts.action === 'import') {
    if (!opts.file) throw new Error('bundle import requires a file');
    const file = path.resolve(opts.file);
    if (!existsSync(file)) throw new Error(`no bundle at ${file}`);
    const result = importBundle(db, root, readBundle(file), {
      force: opts.force,
      author: opts.author ?? 'human:bundle',
    });
    console.log(
      `${pc.green('✓')} imported ${result.claims} claim row(s), ${result.commits} commit row(s), merge ${result.merge}`,
    );
    db.close();
    return;
  }

  throw new Error('usage: lore bundle export --out <file> | lore bundle import <file> [--force]');
}
