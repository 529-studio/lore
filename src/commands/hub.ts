import process from 'node:process';
import pc from 'picocolors';
import { startHubServer } from '../hub/server.js';

export interface HubServeOptions {
  port?: string;
  host?: string;
}

export interface HubTokenOptions {
  action?: string;
  sub?: string;
  role?: string;
  repo?: string;
  jti?: string;
  url?: string;
  adminTokenEnv?: string;
}

function hubUrl(value?: string): string {
  const url = value ?? process.env.LORE_HUB_URL;
  if (!url) throw new Error('set LORE_HUB_URL or pass --url <https://hub>');
  return url.replace(/\/$/, '');
}

async function adminPost(path: string, body: unknown, url?: string, envName = 'LORE_HUB_ADMIN_TOKEN'): Promise<unknown> {
  const token = process.env[envName];
  if (!token) throw new Error(`set ${envName} to issue or revoke hub tokens`);
  const hubBase = hubUrl(url);
  const parsedUrl = new URL(hubBase);
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsedUrl.hostname);
  if (parsedUrl.protocol !== 'https:' && !(loopback && process.env.LORE_HUB_ALLOW_INSECURE === '1')) {
    throw new Error('refusing to send the admin token over plain http; use https');
  }
  const response = await fetch(`${hubBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail = parsed as { error?: string };
    throw new Error(`hub ${response.status}: ${detail.error ?? text}`);
  }
  return parsed;
}

export async function hubCommand(opts: HubServeOptions = {}): Promise<void> {
  const handle = await startHubServer({
    port: opts.port ? Number(opts.port) : undefined,
    host: opts.host,
  });
  console.log(`${pc.green('[OK]')} lore-hub listening on ${handle.url}`);
  console.log(pc.dim('  endpoints: POST /v1/repos/:id/pull, /push, /proposals[/list|get|review|promote], /v1/admin/tokens, /mcp'));
  console.log(pc.dim('  press Ctrl+C to stop'));
}

export async function hubTokenCommand(opts: HubTokenOptions = {}): Promise<void> {
  if (opts.action === 'issue') {
    if (!opts.sub) throw new Error('hub token issue requires --sub <user>');
    const role = opts.role ?? 'contributor';
    const issued = (await adminPost(
      '/v1/admin/tokens',
      { sub: opts.sub, role, repo_id: opts.repo ?? null },
      opts.url,
      opts.adminTokenEnv,
    )) as { token: string; jti: string; sub: string; role: string };
    console.log(issued.token);
    console.error(pc.dim(`issued ${issued.role} token for ${issued.sub} (jti ${issued.jti})`));
    return;
  }
  if (opts.action === 'revoke') {
    if (!opts.jti) throw new Error('hub token revoke requires --jti <hash>');
    await adminPost('/v1/admin/revoke', { jti: opts.jti }, opts.url, opts.adminTokenEnv);
    console.log(`${pc.green('[OK]')} revoked hub token ${opts.jti}`);
    return;
  }
  throw new Error('usage: lore hub serve | lore hub token <issue|revoke>');
}
