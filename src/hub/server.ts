import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import {
  authenticate,
  connect,
  ensureSchema,
  getProposal,
  HubError,
  issueToken,
  listProposals,
  promoteProposal,
  pull,
  pullExternal,
  push,
  reviewProposal,
  revokeToken,
  saveProposal,
  tokenRepoAllowed,
  type HubPrincipal,
} from './store.js';
import type { Bundle } from '../sync.js';

const MAX_BODY = 64 * 1024 * 1024;

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) throw new HubError(401, 'missing bearer token');
  return match[1];
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HubError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new HubError(400, 'invalid JSON body');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function assertSyncPrincipal(principal: HubPrincipal): void {
  if (principal.sub === 'admin' && principal.jti === null) {
    throw new HubError(403, 'the admin token may only issue or revoke tokens; use a repository token');
  }
}

const TOOLS = [
  {
    name: 'repo_pull',
    description: 'Pull commits and tombstones newer than a cursor for one repository',
    inputSchema: {
      type: 'object',
      properties: { repo_id: { type: 'string' }, since_seq: { type: 'number' }, since_auth_seq: { type: 'number' } },
      required: ['repo_id'],
    },
  },
  {
    name: 'repo_push',
    description: 'Push a delta bundle with optimistic CAS against the current main',
    inputSchema: {
      type: 'object',
      properties: {
        repo_id: { type: 'string' },
        expected_main: { type: ['string', 'null'] },
        bundle: { type: 'object' },
      },
      required: ['repo_id', 'bundle'],
    },
  },
  {
    name: 'repo_propose',
    description: 'Publish a contributor proposal under refs/proposals/<user>/<session> without touching main',
    inputSchema: {
      type: 'object',
      properties: {
        repo_id: { type: 'string' },
        session: { type: 'string' },
        base_main: { type: ['string', 'null'] },
        note: { type: 'string' },
        bundle: { type: 'object' },
      },
      required: ['repo_id', 'session', 'bundle'],
    },
  },
  {
    name: 'repo_proposals',
    description: 'List proposals for a repository, optionally filtered by status',
    inputSchema: {
      type: 'object',
      properties: { repo_id: { type: 'string' }, status: { type: 'string' } },
      required: ['repo_id'],
    },
  },
];

async function handleRpc(
  principal: HubPrincipal,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  assertSyncPrincipal(principal);
  const method = String(payload.method ?? '');
  const id = payload.id ?? null;
  const params = (payload.params ?? {}) as Record<string, unknown>;
  if (method === 'notifications/initialized') return null;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'lore-hub', version: '0.5.0' },
      },
    };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method !== 'tools/call') throw new HubError(400, `unsupported method ${method}`);
  const name = String(params.name ?? '');
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const repoId = String(args.repo_id ?? '');
  if (!repoId) throw new HubError(400, 'repo_id is required');
  tokenRepoAllowed(principal, repoId);
  const client = await connect();
  try {
    if (name === 'repo_pull') {
      const result = await pull(client, repoId, Number(args.since_seq ?? 0), Number(args.since_auth_seq ?? 0));
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
    }
    if (name === 'repo_push') {
      const bundle = args.bundle as Bundle | undefined;
      if (!bundle || typeof bundle !== 'object') throw new HubError(400, 'bundle is required');
      const result = await push(client, {
        repoId,
        bundle,
        expectedMain: typeof args.expected_main === 'string' ? args.expected_main : null,
        principal,
        policy: typeof args.policy === 'string' ? args.policy : null,
      });
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
    }
    if (name === 'repo_propose') {
      const bundle = args.bundle as Bundle | undefined;
      const session = String(args.session ?? '');
      if (!bundle || typeof bundle !== 'object') throw new HubError(400, 'bundle is required');
      if (!session) throw new HubError(400, 'session is required');
      const result = await saveProposal(client, {
        repoId,
        principal,
        session,
        baseMain: typeof args.base_main === 'string' ? args.base_main : null,
        bundle,
        note: typeof args.note === 'string' ? args.note : null,
      });
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
    }
    if (name === 'repo_proposals') {
      const status = typeof args.status === 'string' ? args.status : null;
      const proposals = (await listProposals(client, repoId)).filter(
        (proposal) => !status || proposal.status === status,
      );
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ proposals }) }] } };
    }
    throw new HubError(404, `unknown tool ${name}`);
  } finally {
    await client.end();
  }
}

export interface HubServerHandle {
  url: string;
  close: () => Promise<void>;
}

/**
 * Stateless HTTP + minimal streamable MCP endpoint. Each request gets its own
 * Postgres client, so no connection is held while a client is idle.
 */
export async function startHubServer(opts: { port?: number; host?: string } = {}): Promise<HubServerHandle> {
  await ensureSchema();
  const port = opts.port ?? Number(process.env.LORE_HUB_PORT ?? 8787);
  const host = opts.host ?? process.env.LORE_HUB_HOST ?? '127.0.0.1';

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/healthz') {
        send(res, 200, { ok: true, service: 'lore-hub' });
        return;
      }
      if (req.method !== 'POST') throw new HubError(405, 'method not allowed');

      const client = await connect();
      try {
        const principal = await authenticate(client, bearer(req));

        if (url.pathname === '/v1/admin/tokens') {
          if (principal.sub !== 'admin' || principal.role !== 'maintainer') {
            throw new HubError(403, 'admin token required');
          }
          const body = await readJson(req);
          const sub = String(body.sub ?? '').trim();
          const role = String(body.role ?? 'contributor');
          if (!sub) throw new HubError(400, 'sub is required');
          if (!['maintainer', 'contributor', 'machine', 'auditor'].includes(role)) {
            throw new HubError(400, 'role must be maintainer, contributor, machine, or auditor');
          }
          const issued = await issueToken(client, {
            sub,
            role,
            repoId: typeof body.repo_id === 'string' ? body.repo_id : null,
          });
          send(res, 201, issued);
          return;
        }

        if (url.pathname === '/v1/admin/revoke') {
          if (principal.sub !== 'admin' || principal.role !== 'maintainer') {
            throw new HubError(403, 'admin token required');
          }
          const body = await readJson(req);
          const jti = String(body.jti ?? '').trim();
          if (!jti) throw new HubError(400, 'jti is required');
          await revokeToken(client, { jti, reason: typeof body.reason === 'string' ? body.reason : undefined });
          send(res, 200, { ok: true, jti });
          return;
        }

        if (url.pathname === '/mcp') {
          const payload = await readJson(req);
          const response = await handleRpc(principal, payload);
          if (response === null) {
            res.writeHead(202).end();
            return;
          }
          send(res, 200, response);
          return;
        }

        const match = /^\/v1\/repos\/([^/]+)\/(pull|push|external|proposals(?:\/(?:list|get|review|promote))?)$/.exec(
          url.pathname,
        );
        if (!match) throw new HubError(404, 'not found');
        const repoId = decodeURIComponent(match[1]);
        assertSyncPrincipal(principal);

        if (match[2] === 'external') {
          // Subscriber-scoped read: authorization is the source repository's
          // publish.to_repos list, not the caller's own repository scope.
          if (!principal.repoId) {
            throw new HubError(403, 'external pull requires a repository-scoped token');
          }
          await readJson(req);
          const result = await pullExternal(client, repoId, principal.repoId);
          send(res, 200, result);
          return;
        }

        tokenRepoAllowed(principal, repoId);
        const body = await readJson(req);

        if (match[2] === 'pull') {
          const since = Number(body.since_seq ?? 0);
          const sinceAuth = Number(body.since_auth_seq ?? 0);
          const result = await pull(client, repoId, since, sinceAuth);
          send(res, 200, result);
          return;
        }

        if (match[2].startsWith('proposals')) {
          const action = match[2] === 'proposals' ? 'publish' : match[2].slice('proposals/'.length);
          if (action === 'publish') {
            const bundle = body.bundle as Bundle | undefined;
            if (!bundle || typeof bundle !== 'object') throw new HubError(400, 'bundle is required');
            const session = String(body.session ?? '');
            if (!session) throw new HubError(400, 'session is required');
            const proposal = await saveProposal(client, {
              repoId,
              principal,
              session,
              baseMain: typeof body.base_main === 'string' ? body.base_main : null,
              bundle,
              note: typeof body.note === 'string' ? body.note : null,
            });
            send(res, 200, { proposal });
            return;
          }
          if (action === 'list') {
            const status = typeof body.status === 'string' ? body.status : null;
            const proposals = (await listProposals(client, repoId)).filter(
              (proposal) => !status || proposal.status === status,
            );
            send(res, 200, { proposals });
            return;
          }
          const user = String(body.user ?? '');
          const session = String(body.session ?? '');
          if (!user || !session) throw new HubError(400, 'user and session are required');
          if (action === 'get') {
            const result = await getProposal(client, repoId, user, session);
            send(res, 200, result);
            return;
          }
          if (action === 'review') {
            const decision = String(body.action ?? '');
            if (decision !== 'approve' && decision !== 'reject') {
              throw new HubError(400, 'action must be approve or reject');
            }
            const proposal = await reviewProposal(client, {
              repoId,
              principal,
              user,
              session,
              action: decision,
              note: typeof body.note === 'string' ? body.note : null,
            });
            send(res, 200, { proposal });
            return;
          }
          const bundle = body.bundle as Bundle | undefined;
          if (!bundle || typeof bundle !== 'object') throw new HubError(400, 'bundle is required');
          const result = await promoteProposal(client, {
            repoId,
            principal,
            user,
            session,
            expectedMain: typeof body.expected_main === 'string' ? body.expected_main : null,
            bundle,
            policy: typeof body.policy === 'string' ? body.policy : null,
          });
          send(res, 200, result);
          return;
        }

        const bundle = body.bundle as Bundle | undefined;
        if (!bundle || typeof bundle !== 'object') throw new HubError(400, 'bundle is required');
        const result = await push(client, {
          repoId,
          bundle,
          expectedMain: typeof body.expected_main === 'string' ? body.expected_main : null,
          principal,
          policy: typeof body.policy === 'string' ? body.policy : null,
        });
        send(res, 200, result);
      } finally {
        await client.end();
      }
    } catch (error) {
      const status = error instanceof HubError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      send(res, status, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    url: `http://${host}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Allow `node dist/hub/server.js` to run the server directly. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startHubServer()
    .then((handle) => console.log(`lore-hub listening on ${handle.url}`))
    .catch((error) => {
      console.error(`[ERR] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
