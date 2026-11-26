import pc from 'picocolors';
import { createDb, findWorkspaceRoot } from '../db.js';
import { ensureConfig, readConfig, writeConfig } from '../config.js';
import { applyManifest, readManifest } from '../manifest.js';
import { fetchCommand } from './fetch.js';

export interface JoinOptions {
  noFetch?: boolean;
}

/**
 * Attach a fresh clone to the shared store declared in the committed `.lore.yml`:
 * adopt its repo id and remote, then fetch the team baseline in one step.
 */
export async function joinCommand(opts: JoinOptions = {}): Promise<void> {
  const root = findWorkspaceRoot();
  const manifest = readManifest(root);
  if (!manifest) {
    throw new Error(`no .lore.yml in ${root}; add the committed manifest or run lore init`);
  }

  const existing = readConfig(root);
  if (existing?.repo_id && existing.repo_id !== manifest.repo_id) {
    throw new Error(
      `.lore/config.json already belongs to ${existing.repo_id}, but .lore.yml declares ${manifest.repo_id}; ` +
        'use a fresh clone or remove .lore/',
    );
  }

  const db = createDb(root);
  db.close();
  writeConfig(root, applyManifest(ensureConfig(root), manifest));

  console.log(`${pc.green('[OK]')} joined ${pc.bold(root)} ${pc.dim(`(repo_id ${manifest.repo_id})`)}`);
  if (manifest.team_mode && !process.env.LORE_TEAM_SECRET) {
    console.log(pc.yellow('[WARN] team_mode is enabled; set LORE_TEAM_SECRET before writing'));
  }
  if (!manifest.remote) {
    console.log(pc.dim('no remote in .lore.yml; nothing to fetch'));
    return;
  }
  if (opts.noFetch) {
    console.log(pc.dim('--no-fetch: run `lore fetch` when ready'));
    return;
  }
  await fetchCommand({});
}
