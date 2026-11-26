import type { RemoteConfig } from '../config.js';
import type { Bundle } from '../sync.js';

export interface HttpRemote extends Extract<RemoteConfig, { type: 'http' }> {}

export class HubConflictError extends Error {
  constructor(
    message: string,
    readonly main: string | null,
    readonly seq: number,
  ) {
    super(message);
    this.name = 'HubConflictError';
  }
}

export function hubToken(remote: HttpRemote): string {
  const env = remote.token_env ?? 'LORE_HUB_TOKEN';
  const token = process.env[env];
  if (!token) throw new Error(`hub token is not set; export ${env}`);
  return token;
}

function allowedUrl(raw: string): string {
  const parsed = new URL(raw);
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(loopback && process.env.LORE_HUB_ALLOW_INSECURE === '1')) {
    throw new Error('hub url must use https (set LORE_HUB_ALLOW_INSECURE=1 only for a local smoke test)');
  }
  return parsed.toString().replace(/\/$/, '');
}

async function call<T>(
  remote: HttpRemote,
  path: string,
  body: unknown,
): Promise<{ status: number; json: T }> {
  const response = await fetch(`${allowedUrl(remote.url)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hubToken(remote)}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }
  if (response.status === 409) {
    const detail = json as { error?: string; main?: string | null; seq?: number };
    throw new HubConflictError(detail.error ?? 'remote main moved', detail.main ?? null, detail.seq ?? 0);
  }
  if (!response.ok) {
    const detail = json as { error?: string };
    throw new Error(`hub ${response.status}: ${detail.error ?? text}`);
  }
  return { status: response.status, json: json as T };
}

export async function httpPull(
  remote: HttpRemote,
  repoId: string,
  opts: { sinceSeq: number; sinceAuthSeq: number; knownMain: string | null },
): Promise<{ bundle: Bundle; main: string | null; seq: number; auth_seq: number }> {
  const { json } = await call<{ bundle: Bundle; main: string | null; seq: number; auth_seq: number }>(
    remote,
    `/v1/repos/${encodeURIComponent(repoId)}/pull`,
    { since_seq: opts.sinceSeq, since_auth_seq: opts.sinceAuthSeq, known_main: opts.knownMain },
  );
  return json;
}

export async function httpPush(
  remote: HttpRemote,
  repoId: string,
  bundle: Bundle,
  expectedMain: string | null,
  policy: string | null,
): Promise<{ main: string | null; seq: number; auth_seq: number }> {
  const { json } = await call<{ main: string | null; seq: number; auth_seq: number }>(
    remote,
    `/v1/repos/${encodeURIComponent(repoId)}/push`,
    { expected_main: expectedMain, bundle, policy },
  );
  return json;
}
