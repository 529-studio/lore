import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';

export interface AliasOptions {
  action?: string;
  alias?: string;
  entity?: string;
  author?: string;
}

export function aliasCommand(opts: AliasOptions): void {
  const root = requireRoot();
  const db = openDb(root);

  if (opts.action === 'add') {
    if (!opts.alias || !opts.entity) throw new Error('alias add needs <alias> <entity-id>');
    db.prepare(
      `INSERT INTO alias(alias, entity_id, created_at, author) VALUES (?, ?, ?, ?)
       ON CONFLICT(alias) DO UPDATE SET entity_id = excluded.entity_id`,
    ).run(opts.alias, opts.entity, new Date().toISOString(), opts.author ?? 'human:cli');
    console.log(`${pc.green('✓')} alias "${opts.alias}" -> ${opts.entity}`);
    db.close();
    return;
  }

  if (opts.action === 'remove') {
    if (!opts.alias) throw new Error('alias remove needs <alias>');
    const info = db.prepare('DELETE FROM alias WHERE alias = ?').run(opts.alias);
    console.log(info.changes ? `${pc.green('✓')} removed "${opts.alias}"` : pc.yellow('no such alias'));
    db.close();
    return;
  }

  const rows = db.prepare('SELECT alias, entity_id, created_at FROM alias ORDER BY alias').all() as Array<{
    alias: string;
    entity_id: string;
    created_at: string;
  }>;
  if (!rows.length) {
    console.log(pc.dim('no aliases'));
    console.log(pc.dim('  lore alias add "refund flow" doc:docs/payments.md#refund-flow'));
    db.close();
    return;
  }
  for (const row of rows) {
    console.log(`${pc.bold(row.alias)} ${pc.dim('->')} ${row.entity_id} ${pc.dim(row.created_at.slice(0, 10))}`);
  }
  db.close();
}
