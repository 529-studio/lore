import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { ensureConfig, readConfig, writeConfig } from '../config.js';
import { head } from '../model.js';
import { existsSync, readFileSync } from 'node:fs';
import { policyPath } from '../policy.js';
import { buildBundle, buildDeltaBundle, fastForwardSession, importBundle, pushToDir } from '../sync.js';
import { pgPush } from '../remotes/postgres.js';
import { httpPull, httpPush, HubConflictError } from '../remotes/http.js';

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
  } else if (config.remote!.type === 'hub') {
    throw new Error('hub remotes need lore-hub sync (#194); this build supports dir, postgres and http');
  } else if (config.remote!.type === 'http') {
    const remote = config.remote!;
    const pull = async (sinceSeq: number, sinceAuthSeq: number, knownMain: string | null) => {
      const pulled = await httpPull(remote, config.repo_id, { sinceSeq, sinceAuthSeq, knownMain });
      const importedBundle = importBundle(db, root, pulled.bundle, { author });
      writeConfig(root, {
        ...readConfig(root),
        repo_id: config.repo_id,
        hub_seq: pulled.seq,
        hub_auth_seq: pulled.auth_seq,
        hub_main: pulled.main,
      });
      return { pulled, importedBundle };
    };

    const first = await pull(config.hub_seq ?? 0, config.hub_auth_seq ?? 0, config.hub_main ?? null);
    imported = first.importedBundle;
    let hubMain = first.pulled.main;
    const policyFile = policyPath(root);
    const policy = existsSync(policyFile) ? readFileSync(policyFile, 'utf8') : null;

    for (let attempt = 0; ; attempt += 1) {
      const delta = buildDeltaBundle(db, config.repo_id, hubMain);
      try {
        const result = await httpPush(remote, config.repo_id, delta, hubMain, policy);
        hubMain = result.main;
        writeConfig(root, {
          ...readConfig(root),
          repo_id: config.repo_id,
          hub_main: result.main,
          hub_seq: result.seq,
          hub_auth_seq: result.auth_seq,
        });
        break;
      } catch (error) {
        if (!(error instanceof HubConflictError) || attempt > 0) throw error;
        // CAS lost: import the peer's commits, then retry once from the new main.
        const retry = await pull(0, 0, hubMain);
        imported = retry.importedBundle;
        hubMain = retry.pulled.main;
      }
    }
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
    `${pc.green('✓')} pushed main ${main?.slice(0, 12)} (imported ${imported.claims} remote row(s), merge ${imported.merge})`,
  );
  db.close();
}
