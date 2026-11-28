import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import pc from 'picocolors';
import { startHubServer } from '../hub/server.js';
import { connect, ensureSchema, issueToken } from '../hub/store.js';

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
  throw new Error('usage: lore hub serve | lore hub init | lore hub token <issue|revoke>');
}

export interface HubInitOptions {
  dir?: string;
  domain?: string;
  databaseUrl?: string;
  maintainer?: string;
  writeEnv?: boolean;
  force?: boolean;
  json?: boolean;
}

export async function hubInitCommand(opts: HubInitOptions = {}): Promise<void> {
  const dir = path.resolve(opts.dir ?? '.');
  const domain = (opts.domain ?? 'lore-hub.example.com').trim();
  const adminToken = randomBytes(32).toString('base64url');
  const postgresPassword = randomBytes(24).toString('hex');
  const dbUrl = opts.databaseUrl?.trim() || process.env.LORE_HUB_DATABASE_URL?.trim() || null;

  let envFile: string | null = null;
  if (opts.writeEnv) {
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, '.env');
    if (existsSync(target) && !opts.force) {
      throw new Error(`${target} already exists (pass --force to overwrite)`);
    }
    const body = [
      `LORE_HUB_DOMAIN=${domain}`,
      `LORE_POSTGRES_PASSWORD=${postgresPassword}`,
      `LORE_HUB_ADMIN_TOKEN=${adminToken}`,
      '',
    ].join('\n');
    writeFileSync(target, body, { mode: 0o600 });
    try {
      chmodSync(target, 0o600);
    } catch {
      // Best effort on platforms that ignore POSIX modes.
    }
    envFile = target;
  }

  let schemaInitialized = false;
  let maintainerToken: { token: string; jti: string; sub: string; role: string } | null = null;
  if (dbUrl) {
    process.env.LORE_HUB_DATABASE_URL = dbUrl;
    await ensureSchema();
    schemaInitialized = true;
    if (opts.maintainer?.trim()) {
      const client = await connect();
      try {
        maintainerToken = await issueToken(client, {
          sub: opts.maintainer.trim(),
          role: 'maintainer',
          repoId: null,
        });
      } finally {
        await client.end();
      }
    }
  } else if (opts.maintainer?.trim()) {
    throw new Error('--maintainer requires --database-url (or LORE_HUB_DATABASE_URL) to mint the initial token');
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          domain,
          admin_token: adminToken,
          postgres_password: postgresPassword,
          env_file: envFile,
          schema_initialized: schemaInitialized,
          maintainer_token: maintainerToken,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`${pc.green('[OK]')} lore-hub bootstrap ready (${domain})`);
  if (envFile) {
    console.log(`  wrote ${envFile} (mode 0600)`);
  } else {
    console.log(pc.dim('  export these secrets on your hub host (pass --write-env to save .env):'));
    console.log(`  LORE_HUB_DOMAIN=${domain}`);
    console.log(`  LORE_POSTGRES_PASSWORD=${postgresPassword}`);
    console.log(`  LORE_HUB_ADMIN_TOKEN=${adminToken}`);
  }
  if (schemaInitialized) {
    console.log(`${pc.green('[OK]')} Postgres hub schema initialized`);
  }
  if (maintainerToken) {
    console.log(`${pc.green('[OK]')} issued initial maintainer token for ${maintainerToken.sub} (jti ${maintainerToken.jti}):`);
    console.log(`  ${maintainerToken.token}`);
  }
  console.log(pc.dim('  next steps:'));
  console.log(pc.dim('    1. docker compose -f deploy/docker-compose.yml up -d'));
  console.log(pc.dim(`    2. export LORE_HUB_URL="https://${domain}" && export LORE_HUB_ADMIN_TOKEN="<admin-token>"`));
  console.log(pc.dim('    3. lore hub token issue --sub alice@company --role maintainer'));
}
