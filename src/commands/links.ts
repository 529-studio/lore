import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { readConfig } from '../config.js';
import { syncLinkedRepos } from '../remotes/hub.js';

export interface LinksOptions {
  action?: string;
}

/**
 * `lore links sync` — refresh read-only cross-repo memory from the `links:`
 * subscriptions in lore.policy.yml. Nothing is written upstream.
 */
export async function linksCommand(opts: LinksOptions = {}): Promise<void> {
  if (opts.action && opts.action !== 'sync') {
    throw new Error('usage: lore links [sync]');
  }
  const root = requireRoot();
  const config = readConfig(root);
  if (!config?.remote || config.remote.type !== 'http') {
    throw new Error('links sync needs an http hub remote; run: lore remote --hub <url> --token-env LORE_HUB_TOKEN');
  }
  const db = openDb(root);
  try {
    const results = await syncLinkedRepos(db, root, config.remote);
    if (!results.length) {
      console.log(pc.yellow('no linked repositories — add a links: block to lore.policy.yml'));
      return;
    }
    for (const result of results) {
      console.log(
        `${pc.green('[OK]')} ext:${result.origin}: ${result.claims} claim(s), ${result.evidence} evidence row(s), ${result.entities} entities`,
      );
    }
  } finally {
    db.close();
  }
}
