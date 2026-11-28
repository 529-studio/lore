import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import pc from 'picocolors';
import { readConfig } from '../config.js';
import { readManifest } from '../manifest.js';
import { findWorkspaceRoot } from '../scope.js';
import {
  credentialsPath,
  maskToken,
  readCredentials,
  removeHubCredential,
  saveHubCredential,
} from '../credentials.js';

export interface AuthLoginOptions {
  hub?: string;
  token?: string;
  tokenStdin?: boolean;
  repo?: string;
}

export interface AuthLogoutOptions {
  hub?: string;
  repo?: string;
}

export interface AuthStatusOptions {
  json?: boolean;
}

function inferHubUrl(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  try {
    const root = findWorkspaceRoot();
    const remote = readConfig(root)?.remote ?? readManifest(root)?.remote;
    if (remote && (remote.type === 'http' || remote.type === 'hub')) return remote.url;
  } catch {
    // Not inside a Lore workspace; fall through to LORE_HUB_URL.
  }
  if (process.env.LORE_HUB_URL?.trim()) return process.env.LORE_HUB_URL.trim();
  throw new Error('pass --hub <url> or run inside a repository with an http hub remote');
}

async function readTokenFromStdin(): Promise<string> {
  return readFileSync(0, 'utf8').trim();
}

async function promptToken(hub: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(`pass --token <token> or --token-stdin to authenticate with ${hub}`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`Paste hub token for ${hub}: `);
    return answer.trim();
  } finally {
    rl.close();
  }
}

export async function authLoginCommand(opts: AuthLoginOptions = {}): Promise<void> {
  const hub = inferHubUrl(opts.hub);
  const token = opts.tokenStdin
    ? await readTokenFromStdin()
    : opts.token?.trim()
      ? opts.token.trim()
      : await promptToken(hub);

  const saved = saveHubCredential(hub, token, { repoId: opts.repo ?? null });
  const scope = saved.repoId ? `repo ${saved.repoId}` : 'all repositories on hub';
  console.log(`${pc.green('[OK]')} saved credentials for ${pc.bold(saved.hub)} (${scope}) in ${saved.file}`);
}

export function authStatusCommand(opts: AuthStatusOptions = {}): void {
  const file = credentialsPath();
  const data = readCredentials(file);
  const hubs = Object.entries(data.hubs).map(([url, entry]) => ({
    url,
    token: entry.token ? maskToken(entry.token) : null,
    updated_at: entry.updated_at,
    repos: Object.entries(entry.repos ?? {}).map(([repo_id, repoEntry]) => ({
      repo_id,
      token: maskToken(repoEntry.token),
      updated_at: repoEntry.updated_at,
    })),
  }));

  if (opts.json) {
    console.log(JSON.stringify({ file, hubs }, null, 2));
    return;
  }

  console.log(pc.bold(`credentials store: ${file}`));
  if (!hubs.length) {
    console.log(pc.dim('  no stored hub credentials; run: lore auth login --hub <url>'));
    return;
  }
  for (const hub of hubs) {
    console.log(`  ${pc.cyan(hub.url)}  ${hub.token ? `token=${hub.token}` : 'repo-scoped only'}`);
    for (const repo of hub.repos) {
      console.log(`    repo ${repo.repo_id}: ${repo.token}`);
    }
  }
}

export function authLogoutCommand(opts: AuthLogoutOptions = {}): void {
  const hub = inferHubUrl(opts.hub);
  const result = removeHubCredential(hub, { repoId: opts.repo ?? null });
  if (!result.removed) {
    console.log(pc.dim(`no stored credentials for ${result.hub}`));
    return;
  }
  console.log(`${pc.green('[OK]')} removed credentials for ${result.hub}`);
}
