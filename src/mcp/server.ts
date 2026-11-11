// MCP server over stdio — SPEC §10.2.
// stdout = JSON-RPC only; every log goes to stderr.
// Minimal JSON-RPC 2.0 loop: initialize, notifications/initialized, tools/list,
// tools/call, ping. Unknown methods and malformed JSON answer with JSON-RPC
// error objects and never crash the process.
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { openDb, requireRoot, type DB } from '../db.js';
import { hashFile } from '../extract/index.js';
import {
  activeAt,
  evidenceFor,
  head,
  inBranch,
  makeCommit,
  upsertClaim,
  type ClaimRow,
  type EvidenceKind,
} from '../model.js';
import { claimsFor } from '../model.js';
import { isStale } from '../merge.js';
import { searchClaims } from '../retrieval.js';
import { parseRange, resolveRevision } from '../revision.js';
import { branchFor, currentSession } from '../session.js';

const SERVER_VERSION = '0.0.1';
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';
const EVIDENCE_KINDS: EvidenceKind[] = ['test', 'file', 'command', 'human', 'agent'];

const log = (...args: unknown[]): void => {
  console.error('[lore-mcp]', ...args);
};

// --- JSON-RPC framing ---------------------------------------------------------

type JsonId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonId;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function send(response: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function ok(id: JsonId, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id: JsonId, code: number, message: string, data?: unknown): void {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

// --- helpers -------------------------------------------------------------------

function objectOf(row: ClaimRow): string {
  try {
    return String(JSON.parse(row.object_json));
  } catch {
    return row.object_json;
  }
}

interface Context {
  db: DB;
  root: string;
  session: string;
  branch: string;
  branchActive: Map<string, string>;
}

/** Resolves the repo + opens the store; throws with a human message when missing. */
function context(): Context {
  const root = requireRoot();
  const db = openDb(root);
  const session = currentSession(root);
  const branch = branchFor(session);
  const branchActive = activeAt(db, head(db, branch) ?? head(db, 'main'));
  return { db, root, session, branch, branchActive };
}

// --- tool implementations --------------------------------------------------------

interface SearchArgs {
  query?: string;
  files?: string[];
  symbols?: string[];
  budget_tokens?: number;
  include_stale?: boolean;
}

function toolSearch(args: SearchArgs): ToolResult {
  const ctx = context();
  try {
    const hits = searchClaims(ctx.db, ctx.root, {
      query: args.query,
      files: args.files,
      symbols: args.symbols,
      budgetTokens: args.budget_tokens,
      includeStale: args.include_stale,
    });

    const structured = hits.map((h) => ({
      id: h.claim.id,
      subject: h.claim.subject_id,
      predicate: h.claim.predicate,
      object: objectOf(h.claim),
      score: Number(h.score.toFixed(3)),
      stale: h.stale,
      authority: h.claim.authority,
      author: h.claim.author,
      reasons: h.reasons,
      evidence: evidenceFor(ctx.db, h.claim.id),
    }));

    const text = hits.length
      ? `${hits.length} hit(s):\n${structured
          .map(
            (h) =>
              `[${h.score}] ${h.subject} — ${h.predicate}: ${h.object}${h.stale ? ' (STALE)' : ''}\n` +
              `  ${h.id} T${h.authority} ${h.author}\n` +
              h.evidence.map((e) => `  evidence: ${e.kind}:${e.ref} (${e.status})`).join('\n'),
          )
          .join('\n')}`
      : 'no hits — run `lore ingest` or widen the scope';

    return {
      content: [{ type: 'text', text }],
      structuredContent: { hits: structured, count: structured.length },
    };
  } finally {
    ctx.db.close();
  }
}

interface WriteArgs {
  subject?: string;
  predicate?: string;
  object?: string;
  kind?: string;
  ref?: string;
  confidence?: number;
}

function toolWrite(args: WriteArgs): ToolResult {
  if (!args.subject || !args.predicate || typeof args.object !== 'string') {
    throw new Error('memory_write requires subject, predicate and object');
  }
  if (!args.kind || !EVIDENCE_KINDS.includes(args.kind as EvidenceKind)) {
    throw new Error(`kind must be one of: ${EVIDENCE_KINDS.join(', ')}`);
  }
  if (
    args.confidence !== undefined &&
    (typeof args.confidence !== 'number' || args.confidence < 0 || args.confidence > 1)
  ) {
    throw new Error('confidence must be a number in [0, 1]');
  }

  const ctx = context();
  try {
    const kind = args.kind as EvidenceKind;
    const evidenceRef = args.ref ?? args.subject;
    // Guarded: rejects absolute paths, traversal, non-regular files and > 4 MB.
    const hash = kind === 'file' || kind === 'test' ? hashFile(ctx.root, evidenceRef) : null;

    const author = 'agent:mcp';
    const result = upsertClaim(ctx.db, {
      subject: args.subject,
      predicate: args.predicate,
      object: args.object,
      confidence: args.confidence,
      author,
      // Never writes to `main` — the commit always lands on agent/<session>.
      evidence: [{ kind, ref: evidenceRef, hash }],
    });

    // Drafts never enter the active set; a claim missing from this branch still needs an entry.
    if (result.state === 'active' && !inBranch(ctx.db, ctx.branch, result.id)) {
      makeCommit(ctx.db, {
        ref: ctx.branch,
        entries: [{ claim_id: result.id, op: 'add' }],
        message: `mcp write: ${args.predicate} ${args.subject}`,
        author,
        kind: 'write',
      });
    }

    const text =
      `wrote ${result.id} (${result.state}) to ${ctx.branch}\n` +
      `  ${args.subject} — ${args.predicate}: ${args.object}\n` +
      `  evidence: ${kind}:${evidenceRef}` +
      (hash ? ` @ ${hash.slice(0, 15)}…` : '') +
      (result.state === 'draft' ? '\n  draft — not in retrieval until approved (lore approve)' : '');

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        id: result.id,
        state: result.state,
        authority: result.authority,
        inserted: result.inserted,
        branch: ctx.branch,
      },
    };
  } finally {
    ctx.db.close();
  }
}

interface BlameArgs {
  subject?: string;
  predicate?: string;
}

function toolBlame(args: BlameArgs): ToolResult {
  if (!args.subject) throw new Error('memory_blame requires subject');
  const ctx = context();
  try {
    const rows = claimsFor(ctx.db, args.subject).filter(
      (c) => !args.predicate || c.predicate === args.predicate,
    );
    if (!rows.length) throw new Error(`no claims for ${args.subject}`);

    const structured = rows.map((c) => ({
      id: c.id,
      subject: c.subject_id,
      predicate: c.predicate,
      object: objectOf(c),
      state: c.state,
      in_branch: ctx.branchActive.has(c.id),
      authority: c.authority,
      confidence: c.confidence,
      author: c.author,
      tx_from: c.tx_from,
      evidence: evidenceFor(ctx.db, c.id),
    }));
    const text = structured
      .map(
        (c) =>
          `${c.subject} — ${c.predicate}: ${c.object}\n` +
          `  ${c.id} ${c.state}${c.in_branch ? '' : ' (out-of-branch)'} T${c.authority} conf ${c.confidence.toFixed(2)} ${c.author}\n` +
          c.evidence.map((e) => `  ↳ ${e.kind}:${e.ref} ${e.status}`).join('\n'),
      )
      .join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: { claims: structured },
    };
  } finally {
    ctx.db.close();
  }
}

function toolStatus(_args: Record<string, never>): ToolResult {
  const ctx = context();
  try {
    let drafts = 0;
    let stale = 0;
    for (const id of ctx.branchActive.keys()) {
      const row = ctx.db.prepare('SELECT state FROM claim WHERE id = ?').get(id) as
        | { state: string }
        | undefined;
      if (row?.state === 'draft') drafts++;
      if (isStale(ctx.db, ctx.root, id)) stale++;
    }
    const summary = {
      branch: ctx.branch,
      session: ctx.session,
      active_set: ctx.branchActive.size,
      drafts,
      stale,
    };
    return {
      content: [
        {
          type: 'text',
          text: `branch ${summary.branch} — ${summary.active_set} active, ${drafts} draft, ${stale} stale`,
        },
      ],
      structuredContent: summary,
    };
  } finally {
    ctx.db.close();
  }
}

interface DiffArgs {
  from?: string;
  to?: string;
}

function toolDiff(args: DiffArgs): ToolResult {
  if (!args.from || !args.to) throw new Error('memory_diff requires from and to');
  const ctx = context();
  try {
    const from = resolveRevision(ctx.db, args.from, ctx.root);
    const to = resolveRevision(ctx.db, args.to, ctx.root);
    if (!from.id) throw new Error(`unknown revision: ${args.from}`);
    if (!to.id) throw new Error(`unknown revision: ${args.to}`);

    const a = activeAt(ctx.db, from.id);
    const b = activeAt(ctx.db, to.id);
    const stmt = ctx.db.prepare('SELECT * FROM claim WHERE id = ?');
    const load = (id: string): ClaimRow | undefined => stmt.get(id) as ClaimRow | undefined;

    const side = (ids: string[]) =>
      ids
        .map((id) => load(id))
        .filter((row): row is ClaimRow => Boolean(row))
        .sort((x, y) => `${x.subject_id}|${x.predicate}`.localeCompare(`${y.subject_id}|${y.predicate}`))
        .map((row) => ({
          id: row.id,
          subject: row.subject_id,
          predicate: row.predicate,
          object: objectOf(row),
        }));

    const added = side([...b.keys()].filter((id) => !a.has(id)));
    const removed = side([...a.keys()].filter((id) => !b.has(id)));
    const text =
      `${from.label} .. ${to.label}\n` +
      added.map((c) => `+ ${c.subject} — ${c.predicate}: ${c.object}`).join('\n') +
      (added.length && removed.length ? '\n' : '') +
      removed.map((c) => `- ${c.subject} — ${c.predicate}: ${c.object}`).join('\n') +
      (added.length || removed.length ? '' : 'no claim changes');
    return {
      content: [{ type: 'text', text }],
      structuredContent: { from: from.label, to: to.label, added, removed },
    };
  } finally {
    ctx.db.close();
  }
}

interface ApproveArgs {
  claim?: string;
}

function toolApprove(args: ApproveArgs): ToolResult {
  const ctx = context();
  try {
    const targets = (
      args.claim
        ? ctx.db.prepare("SELECT id FROM claim WHERE id = ? AND state = 'draft'").all(args.claim)
        : ctx.db.prepare("SELECT id FROM claim WHERE state = 'draft'").all()
    ) as Array<{ id: string }>;

    if (!targets.length) {
      return { content: [{ type: 'text', text: 'no draft claims to approve' }], structuredContent: { approved: [] } };
    }

    ctx.db.transaction(() => {
      const update = ctx.db.prepare("UPDATE claim SET state = 'active', authority = MIN(authority, 2) WHERE id = ?");
      for (const t of targets) update.run(t.id);
      makeCommit(ctx.db, {
        ref: ctx.branch,
        entries: targets.map((t) => ({ claim_id: t.id, op: 'add' as const })),
        message: `mcp approve: ${targets.length} claim(s)`,
        author: 'agent:mcp',
        kind: 'write',
      });
    })();

    return {
      content: [{ type: 'text', text: `approved ${targets.length} claim(s) on ${ctx.branch}` }],
      structuredContent: { approved: targets.map((t) => t.id) },
    };
  } finally {
    ctx.db.close();
  }
}

interface CommitArgs {
  message?: string;
}

function toolCommit(args: CommitArgs): ToolResult {
  if (!args.message) throw new Error('memory_commit requires a message');
  const ctx = context();
  try {
    const id = makeCommit(ctx.db, {
      ref: ctx.branch,
      entries: [],
      message: args.message,
      author: 'agent:mcp',
      kind: 'write',
    });
    return {
      content: [{ type: 'text', text: `commit ${id} on ${ctx.branch}` }],
      structuredContent: { commit: id, branch: ctx.branch },
    };
  } finally {
    ctx.db.close();
  }
}

// --- tool registry -----------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => ToolResult;
}

const ARGS = (args: Record<string, unknown> | undefined): Record<string, unknown> => args ?? {};

const TOOLS: ToolDef[] = [
  {
    name: 'memory_search',
    description:
      'Score the active set of your Lore memory branch against the task scope (SPEC §9). Stale claims are excluded by default.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'free text' },
        files: { type: 'array', items: { type: 'string' }, description: 'paths in scope' },
        symbols: { type: 'array', items: { type: 'string' }, description: 'entity ids in scope' },
        budget_tokens: { type: 'number', description: 'context budget, default 2000' },
        include_stale: { type: 'boolean', description: 'keep stale claims in the result' },
      },
    },
    run: (args) => toolSearch(ARGS(args) as unknown as SearchArgs),
  },
  {
    name: 'memory_write',
    description:
      'Write one claim to the agent/<session> branch. kind test/file auto-promotes; kind agent/human stays draft until approved. Never writes to main.',
    inputSchema: {
      type: 'object',
      required: ['subject', 'predicate', 'object', 'kind'],
      properties: {
        subject: { type: 'string', description: 'entity id, e.g. file:src/a.ts, sym:src/a.ts#fn, env:DATABASE_URL' },
        predicate: { type: 'string' },
        object: { type: 'string' },
        kind: { type: 'string', enum: EVIDENCE_KINDS },
        ref: { type: 'string', description: 'evidence source (default: subject)' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    run: (args) => toolWrite(ARGS(args) as unknown as WriteArgs),
  },
  {
    name: 'memory_blame',
    description: 'Find out where a claim came from: evidence, author and whether it is in your branch.',
    inputSchema: {
      type: 'object',
      required: ['subject'],
      properties: {
        subject: { type: 'string' },
        predicate: { type: 'string' },
      },
    },
    run: (args) => toolBlame(ARGS(args) as unknown as BlameArgs),
  },
  {
    name: 'memory_status',
    description: 'Memory health for your branch: active set size, drafts, stale count.',
    inputSchema: { type: 'object', properties: {} },
    run: (args) => toolStatus(ARGS(args) as unknown as Record<string, never>),
  },
  {
    name: 'memory_diff',
    description: 'Claims added/removed between two Lore revisions (refs or commit ids).',
    inputSchema: {
      type: 'object',
      required: ['from', 'to'],
      properties: {
        from: { type: 'string', description: 'ref name or commit id' },
        to: { type: 'string', description: 'ref name or commit id' },
      },
    },
    run: (args) => toolDiff(ARGS(args) as unknown as DiffArgs),
  },
  {
    name: 'memory_approve',
    description:
      'Promote draft claims to active on your branch. Without this, agent-inferred memory written over MCP stays invisible forever.',
    inputSchema: {
      type: 'object',
      properties: {
        claim: { type: 'string', description: 'claim id; omit to approve every draft' },
      },
    },
    run: (args) => toolApprove(ARGS(args) as unknown as ApproveArgs),
  },
  {
    name: 'memory_commit',
    description: 'Record a named checkpoint commit on the current agent branch.',
    inputSchema: {
      type: 'object',
      required: ['message'],
      properties: { message: { type: 'string' } },
    },
    run: (args) => toolCommit(ARGS(args) as unknown as CommitArgs),
  },
];

// --- method dispatch -----------------------------------------------------------------

function dispatchToolCall(id: JsonId, params: Record<string, unknown> | undefined): void {
  const name = params?.name;
  const tool = TOOLS.find((t) => t.name === name);
  if (typeof name !== 'string' || !tool) {
    fail(id, -32602, `unknown tool: ${String(name)}`);
    return;
  }
  const args = params?.arguments;
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    fail(id, -32602, 'arguments must be an object');
    return;
  }
  try {
    ok(id, tool.run(args as Record<string, unknown>));
  } catch (error) {
    // Tool execution failure: MCP wants this inside the result, not as a protocol error.
    const message = error instanceof Error ? error.message : String(error);
    log(`tool ${name} failed: ${message}`);
    ok(id, {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    });
  }
}

function handleRequest(id: JsonId, method: string, params: Record<string, unknown> | undefined): void {
  switch (method) {
    case 'initialize': {
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : null;
      const protocolVersion = requested ?? FALLBACK_PROTOCOL_VERSION;
      ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'lore', version: SERVER_VERSION },
        instructions: 'Versioned, verifiable memory. Read docs/mcp.md; each session writes to agent/<session>.',
      });
      return;
    }
    case 'tools/list':
      ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      return;
    case 'tools/call':
      dispatchToolCall(id, params);
      return;
    case 'ping':
      ok(id, {});
      return;
    default:
      fail(id, -32601, `method not found: ${method}`);
  }
}

function handleLine(line: string): void {
  const raw = line.trim();
  if (!raw) return;

  let message: JsonRpcRequest;
  try {
    message = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    fail(null, -32700, 'parse error: request is not valid JSON');
    return;
  }

  if (typeof message !== 'object' || message === null || typeof message.method !== 'string') {
    fail(null, -32600, 'invalid request: missing method');
    return;
  }

  const id = message.id ?? null;
  const isNotification = !('id' in message) || message.id === undefined;
  const params = typeof message.params === 'object' && message.params !== null ? message.params : undefined;

  try {
    // Notifications never get a response, including the handshake ack.
    if (isNotification) {
      if (message.method.startsWith('notifications/')) return;
      fail(id, -32601, `method not found: ${message.method}`);
      return;
    }
    handleRequest(id, message.method, params);
  } catch (error) {
    // Last-resort guard: the loop must survive anything.
    const msg = error instanceof Error ? error.message : String(error);
    log(`internal error handling ${message.method}: ${msg}`);
    fail(id, -32603, `internal error: ${msg}`);
  }
}

export function runMcpServer(): void {
  log(`lore mcp v${SERVER_VERSION} — ${TOOLS.length} tools — protocol on stdout, logs on stderr`);
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => handleLine(line));
  rl.on('close', () => process.exit(0));
}
