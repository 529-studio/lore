import pc from 'picocolors';
import { openDb, requireRoot, type DB } from '../db.js';
import { ensureConfig, readConfig, writeConfig, type LoreConfig } from '../config.js';
import { head } from '../model.js';
import { existsSync, readFileSync } from 'node:fs';
import { policyPath } from '../policy.js';
import { buildBundle, fastForwardSession, importBundle, pushToDir, type ImportResult } from '../sync.js';
import { pgPush } from '../remotes/postgres.js';
import { httpPropose, type HttpRemote } from '../remotes/http.js';
import { pullHub, pushHub } from '../remotes/hub.js';
import { branchFor, ensureSession } from '../session.js';

export interface PushOptions {
  path?: string;
  author?: string;
  propose?: boolean;
  session?: string;
  note?: string;
}

function policyText(root: string): string | null {
  const file = policyPath(root);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

function hubRemote(config: LoreConfig): HttpRemote {
  if (!config.remote) throw new Error('no remote configured; run: lore remote --hub <url>');
  if (config.remote.type !== 'http') {
    throw new Error('--propose needs a lore-hub (http) remote; directory, postgres and bundle remotes carry no proposals');
  }
  return config.remote;
}

/**
 * Publish the session branch and its staged T3/T4 drafts as a proposal. The
 * contributor never needs permission on main: the hub stores the bundle under
 * refs/proposals/<user>/<session> until a maintainer reviews it.
 */
async function proposeCommand(
  root: string,
  db: DB,
  config: LoreConfig,
  opts: PushOptions,
): Promise<void> {
  const remote = hubRemote(config);
  const session = ensureSession(db, root, opts.session);
  const ref = branchFor(session);
  // Pull first so the proposal records the main it was built on and the
  // maintainer's merge has a common base.
  const baseMain = (await pullHub(db, root, remote, readConfig(root) ?? config, opts.author ?? 'human:propose')).main;

  const branchTip = head(db, ref);
  const drafts = db.prepare("SELECT id FROM claim WHERE state = 'draft'").all() as Array<{ id: string }>;
  if (!branchTip && !drafts.length) {
    throw new Error(`nothing to propose: ${ref} has no commits and the store has no drafts`);
  }

  const bundle = buildBundle(db, config.repo_id, branchTip ? [ref] : []);
  const proposal = await httpPropose(remote, config.repo_id, {
    session,
    baseMain,
    bundle,
    note: opts.note ?? null,
  });

  console.log(
    `${pc.green('[OK]')} proposal ${proposal.ref} (${proposal.status}) base ${baseMain?.slice(0, 12) ?? 'none'}`,
  );
  console.log(
    pc.dim(
      `  tip ${branchTip ? branchTip.slice(0, 12) : 'none'}  drafts ${drafts.length}  claims ${proposal.claims}  commits ${proposal.commits}`,
    ),
  );
  console.log(pc.dim('  a maintainer reviews it with: lore proposals list'));
}

export async function pushCommand(opts: PushOptions): Promise<void> {
  const root = requireRoot();
  const db = openDb(root);
  const config = ensureConfig(root);
  const author = opts.author ?? 'human:push';

  if (!config.remote && !opts.path) throw new Error('no remote configured; run: lore remote <shared-directory>');

  if (opts.propose) {
    if (opts.path) throw new Error('--propose publishes to lore-hub; drop --path');
    await proposeCommand(root, db, config, opts);
    db.close();
    return;
  }

  if (!head(db, 'main')) throw new Error('main has no commits yet; run lore ingest and lore promote');

  let imported: ImportResult;
  if (opts.path) {
    imported = pushToDir(db, root, opts.path, config.repo_id, author);
  } else if (config.remote!.type === 'dir') {
    imported = pushToDir(db, root, config.remote!.path, config.repo_id, author);
  } else if (config.remote!.type === 'hub') {
    throw new Error('hub remotes need lore-hub sync (#194); this build supports dir, postgres and http');
  } else if (config.remote!.type === 'http') {
    const pushed = await pushHub(db, root, config.remote!, config, author, policyText(root));
    imported = pushed.imported;
  } else if (config.remote!.type === 'postgres') {
    const url = config.remote!.url ?? (config.remote!.url_env ? process.env[config.remote!.url_env] : undefined);
    if (!url) throw new Error(`remote url is not set (env ${config.remote!.url_env ?? 'LORE_REMOTE_URL'})`);
    imported = await pgPush(
      url,
      config.repo_id,
      (bundle) => importBundle(db, root, bundle, { author }),
      () => buildBundle(db, config.repo_id),
    );
  } else {
    throw new Error('unsupported remote type');
  }

  fastForwardSession(db, root);
  const main = head(db, 'main');
  writeConfig(root, { ...readConfig(root), repo_id: config.repo_id, remote_main: main });
  console.log(
    `${pc.green('[OK]')} pushed main ${main?.slice(0, 12)} (imported ${imported.claims} remote row(s), merge ${imported.merge})`,
  );
  db.close();
}
