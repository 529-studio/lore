// MCP server over stdio — SPEC §10.2.
// stdout = JSON-RPC only; every log goes to stderr.
// Minimal JSON-RPC 2.0 loop: initialize, notifications/initialized, tools/list,
// tools/call, ping. Unknown methods and malformed JSON answer with JSON-RPC
// error objects and never crash the process.
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { openDb, requireRoot, type DB } from '../db.js';
import { hashCache } from '../hash-cache.js';
import { gitHead } from '../util/git.js';
import { authorityOf } from '../model.js';
import { gateTier, isPermissiveTrust, requireAction } from '../policy.js';
import {
  activeAt,
  evidenceFor,
  head,
  inBranch,
  makeCommit,
  runClaimWriteHooks,
  upsertClaim,
  type ClaimRow,
  type EvidenceKind,
} from '../model.js';
import { claimsFor } from '../model.js';
import { claimFreshness, isStale } from '../merge.js';
import { contestedWarning, searchMemory } from '../retrieval.js';
import { parseRange, resolveRevision } from '../revision.js';
import { branchFor, currentSession, recordReads } from '../session.js';
import { installCanon } from '../canon/index.js';
import { loadOntology } from '../ontology.js';
import { oneLine } from '../util/text.js';
import { createSyncAdapter, probeRemote } from '../sync/adapter.js';
import { ensureConfig, readConfig, remoteLabel } from '../config.js';
import { buildBundle } from '../sync.js';
import { httpPropose, type HttpRemote } from '../remotes/http.js';

const SERVER_VERSION = '0.6.1';
// Newest first. A client asking for an unknown version is negotiated down to the
// newest one we implement, and told so in the initialize result.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const FALLBACK_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
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

// --- session-start team sync -------------------------------------------------------
// The handshake must answer first: a slow or unreachable remote never blocks
// initialize. A delta pull runs in the background and only logs a warning.
const autoSyncRoots = new Set<string>();

function autoSyncEnabled(config: { auto_sync?: boolean; remote?: unknown }): boolean {
  const env = (process.env.LORE_AUTO_SYNC ?? '').trim().toLowerCase();
  if (env === '0' || env === 'false' || env === 'off') return false;
  if (env === '1' || env === 'true' || env === 'on') return true;
  if (config.auto_sync === false) return false;
  return config.auto_sync === true || Boolean(config.remote);
}

async function autoSyncOnInitialize(): Promise<void> {
  let root: string;
  try {
    root = requireRoot();
  } catch {
    return; // not inside a lore repo: nothing to sync, handshake already answered
  }
  if (autoSyncRoots.has(root)) return;
  autoSyncRoots.add(root);
  try {
    const config = ensureConfig(root);
    if (!config.remote || !autoSyncEnabled(config)) return;
    const db = openDb(root);
    try {
      const adapter = await createSyncAdapter(db, root, { remote: config.remote });
      const pulled = await adapter.pull({ author: 'agent:mcp:auto' });
      log(
        `auto_sync: ${adapter.kind} pulled ${pulled.commits} commit(s), ${pulled.claims} claim(s) (merge: ${pulled.merge})`,
      );
    } finally {
      db.close();
    }
  } catch (error) {
    const cause = error instanceof Error && 'cause' in error ? error.cause : undefined;
    const message = error instanceof Error ? error.message : String(error);
    log(
      `auto_sync skipped, working offline: ${message}${cause instanceof Error && cause.message ? ` (${cause.message})` : ''}`,
    );
  } finally {
    autoSyncRoots.delete(root);
  }
}

// --- resource definitions and subscription protocol -------------------------------

const resourceSubscriptions = new Set<string>();

export function notifyResourceUpdated(uri: string): void {
  if (resourceSubscriptions.has(uri) || resourceSubscriptions.has('*')) {
    send({
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { uri },
    });
  }
}

export function broadcastResourceUpdates(subject?: string): void {
  notifyResourceUpdated('lore://memory/active');
  notifyResourceUpdated('lore://memory/status');
  if (subject) {
    notifyResourceUpdated(`lore://claims/${encodeURIComponent(subject)}`);
  }
}

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export const STATIC_RESOURCES: McpResource[] = [
  {
    uri: 'lore://memory/active',
    name: 'Active Memory Claims',
    description: 'Current active and canonical claims in the active branch set',
    mimeType: 'application/json',
  },
  {
    uri: 'lore://memory/status',
    name: 'Memory System Status',
    description: 'Overall memory store status, branch, active count, drafts, and health',
    mimeType: 'application/json',
  },
  {
    uri: 'lore://memory/rules',
    name: 'Memory Ontology Rules',
    description: 'Configured ontology rules, domains, and cardinality guidelines',
    mimeType: 'application/json',
  },
  {
    uri: 'lore://memory/conflicts',
    name: 'Open Memory Conflicts',
    description: 'List of currently unresolved tier-1 conflicts in the active branch',
    mimeType: 'application/json',
  },
];

export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'lore://claims/{subject}',
    name: 'Subject Claims',
    description: 'All claims associated with a specific entity subject ID',
    mimeType: 'application/json',
  },
];

export function readResource(ctx: Context, uri: string): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
  if (uri === 'lore://memory/active') {
    const claims = [...ctx.branchActive.keys()]
      .map((id) => ctx.db.prepare('SELECT * FROM claim WHERE id = ?').get(id) as ClaimRow | undefined)
      .filter((c): c is ClaimRow => Boolean(c && c.state === 'active'));
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(claims, null, 2),
        },
      ],
    };
  }
  if (uri === 'lore://memory/status') {
    const activeCount = ctx.branchActive.size;
    const drafts = (ctx.db.prepare("SELECT COUNT(*) as c FROM claim WHERE state = 'draft'").get() as { c: number }).c;
    const conflicts = (ctx.db.prepare('SELECT COUNT(*) as c FROM claim_conflict WHERE resolved = 0').get() as { c: number }).c;
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(
            { branch: ctx.branch, activeClaims: activeCount, drafts, conflicts, session: ctx.session },
            null,
            2,
          ),
        },
      ],
    };
  }
  if (uri === 'lore://memory/rules') {
    const ontology = loadOntology(ctx.root);
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(ontology, null, 2),
        },
      ],
    };
  }
  if (uri === 'lore://memory/conflicts') {
    const rows = ctx.db.prepare('SELECT * FROM claim_conflict WHERE resolved = 0').all();
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(rows, null, 2),
        },
      ],
    };
  }
  if (uri.startsWith('lore://claims/')) {
    const rawSubject = decodeURIComponent(uri.slice('lore://claims/'.length));
    const claims = claimsFor(ctx.db, rawSubject);
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(claims, null, 2),
        },
      ],
    };
  }
  throw new Error(`unknown resource URI: ${uri}`);
}

// --- tool implementations --------------------------------------------------------

interface SearchArgs {
  query?: string;
  files?: string[];
  symbols?: string[];
  budget_tokens?: number;
  include_stale?: boolean;
  as_of?: string;
  valid_at?: string;
  tx_at?: string;
  trust_remote?: boolean;
  semantic?: boolean;
  vector_weight?: number;
  include_external?: boolean;
}

function toolSearch(args: SearchArgs): ToolResult {
  const ctx = context();
  try {
    const { hits, contested } = searchMemory(ctx.db, ctx.root, {
      query: args.query,
      files: args.files,
      symbols: args.symbols,
      budgetTokens: args.budget_tokens,
      includeStale: args.include_stale,
      asOf: args.as_of,
      validAt: args.valid_at,
      txAt: args.tx_at,
      trustRemote: args.trust_remote,
      semantic: args.semantic,
      vectorWeight: args.vector_weight,
      includeExternal: args.include_external,
    });
    const warnings = contested.map(contestedWarning);

    const structured = hits.map((h) => ({
      id: h.claim.id,
      subject: h.claim.subject_id,
      predicate: h.claim.predicate,
      object: objectOf(h.claim),
      score: Number(h.score.toFixed(3)),
      stale: h.stale,
      ahead: h.ahead,
      external: h.external,
      origin_repo_id: h.originRepo,
      trust: h.claim.trust,
      authority: h.claim.authority,
      author: h.claim.author,
      reasons: h.reasons,
      evidence: evidenceFor(ctx.db, h.claim.id),
    }));

    const text = [
      ...warnings,
      hits.length
        ? `${hits.length} hit(s):\n${structured
            .map(
              (h) =>
                `[${h.score}] ${oneLine(h.subject)} — ${oneLine(h.predicate)}: ${oneLine(h.object)}${h.external ? ' [EXT]' : ''}${h.stale ? ' (STALE)' : ''}\n` +
                `  ${h.id} T${h.authority} ${oneLine(h.author)}\n` +
                h.evidence.map((e) => `  evidence: ${oneLine(e.kind)}:${oneLine(e.ref)} (${e.status})`).join('\n'),
            )
            .join('\n')}`
        : 'no hits — run `lore ingest` or widen the scope',
    ].join('\n');

    return {
      content: [{ type: 'text', text }],
      structuredContent: { hits: structured, count: structured.length, warnings, contested },
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
  valid_from?: string;
  ttl_days?: number;
  scrub?: boolean;
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
  if (
    args.ttl_days !== undefined &&
    (typeof args.ttl_days !== 'number' || !Number.isFinite(args.ttl_days) || args.ttl_days < 0)
  ) {
    throw new Error('ttl_days must be a finite, non-negative number');
  }

  const ctx = context();
  try {
    const kind = args.kind as EvidenceKind;
    // Guarded: an agent must not bypass subject ACLs that the CLI enforces.
    requireAction(ctx.root, 'write', { subject: args.subject, tier: authorityOf(kind) });
    const subject = args.subject;
    const predicate = args.predicate;
    const object = args.object;
    const evidenceRef = args.ref ?? subject;
    // Guarded: rejects absolute paths, traversal, non-regular files and > 4 MB.
    const hash = kind === 'file' || kind === 'test' ? hashCache(ctx.db, ctx.root).hash(evidenceRef) : null;

    const author = 'agent:mcp';
    const write = ctx.db.transaction(() => {
      const result = upsertClaim(ctx.db, {
        subject,
        predicate,
        object,
        confidence: args.confidence,
        validFrom: args.valid_from,
        author,
        // Never writes to `main` — the commit always lands on agent/<session>.
        evidence: [{ kind, ref: evidenceRef, hash, commit: gitHead(ctx.root) }],
        forceDraft: gateTier(ctx.root, authorityOf(kind)),
        forceActive: isPermissiveTrust(ctx.root),
        writtenBy: 'agent',
        agentId: 'mcp',
        sessionId: ctx.session,
        scrubSecrets: args.scrub ?? true,
        ttlDays: args.ttl_days ?? loadOntology(ctx.root).ttlDays(predicate),
      });

      // Drafts never enter the active set; a claim missing from this branch still needs an entry.
      if (result.state === 'active' && !inBranch(ctx.db, ctx.branch, result.id)) {
        makeCommit(ctx.db, {
          ref: ctx.branch,
          entries: [{ claim_id: result.id, op: 'add' }],
          message: `mcp write: ${predicate} ${subject}`,
          author,
          kind: 'write',
        });
      }
      return result;
    });
    const result = write();
    broadcastResourceUpdates(subject);

    const text =
      `wrote ${result.id} (${result.state}) to ${ctx.branch}\n` +
      `  ${oneLine(subject)} — ${oneLine(predicate)}: ${oneLine(object)}\n` +
      `  evidence: ${oneLine(kind)}:${oneLine(evidenceRef)}` +
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
    // Reviewing a draft over MCP counts as "used" for GC, same as the CLI.
    recordReads(ctx.db, ctx.session, rows.map((c) => c.id));

    const structured = rows.map((c) => ({
      id: c.id,
      subject: c.subject_id,
      predicate: c.predicate,
      object: objectOf(c),
      state: c.state,
      in_branch: ctx.branchActive.has(c.id),
      external: Boolean(c.origin_repo_id),
      origin_repo_id: c.origin_repo_id,
      authority: c.authority,
      confidence: c.confidence,
      author: c.author,
      tx_from: c.tx_from,
      evidence: evidenceFor(ctx.db, c.id),
    }));
    const text = structured
      .map(
        (c) =>
          `${oneLine(c.subject)} — ${oneLine(c.predicate)}: ${oneLine(c.object)}${c.external ? ' [EXT]' : ''}\n` +
          `  ${c.id} ${c.state}${c.external ? ` (external origin ${c.origin_repo_id})` : c.in_branch ? '' : ' (out-of-branch)'} T${c.authority} conf ${c.confidence.toFixed(2)} ${c.author}\n` +
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

async function toolStatus(_args: Record<string, never>): Promise<ToolResult> {
  const ctx = context();
  try {
    // Drafts are never committed, so they cannot be counted from the branch fold.
    const drafts = (ctx.db.prepare("SELECT COUNT(*) AS n FROM claim WHERE state = 'draft'").get() as {
      n: number;
    }).n;
    let stale = 0;
    let ahead = 0;
    for (const id of ctx.branchActive.keys()) {
      const freshness = claimFreshness(ctx.db, ctx.root, id);
      if (freshness === 'stale') stale++;
      if (freshness === 'ahead') ahead++;
    }
    const permissive = isPermissiveTrust(ctx.root);
    // Read-only probe with a short timeout; an offline session still answers.
    const remote = await probeRemote(ctx.db, ctx.root);
    const remoteState = !remote.configured
      ? 'not-configured'
      : remote.reachable === null
        ? 'unknown'
        : remote.reachable
          ? remote.behind
            ? 'behind'
            : 'synced'
          : 'unreachable';
    const summary = {
      branch: ctx.branch,
      session: ctx.session,
      active_set: ctx.branchActive.size,
      drafts,
      stale,
      ahead,
      trust_mode: permissive ? 'permissive' : 'strict',
      remote_behind: remote.behind,
      remote_rows_behind: remote.behind_rows,
      remote_state: remoteState,
      remote: remote.configured
        ? {
            reachable: remote.reachable,
            behind: remote.behind,
            rows_behind: remote.behind_rows,
            main: remote.main,
            checked_at: remote.checked_at,
            error: remote.error,
          }
        : null,
    };
    const remoteLine = remote.configured
      ? `\nremote ${remoteState}` +
        (remote.behind !== null ? ` (${remote.behind} commit(s), ${remote.behind_rows ?? 0} row(s) behind)` : '') +
        (remote.error ? `: ${oneLine(remote.error)}` : '')
      : '';
    return {
      content: [
        {
          type: 'text',
          text:
            `branch ${summary.branch} — ${summary.active_set} active, ${drafts} draft, ${stale} stale, ${ahead} ahead of checkout (trust mode: ${summary.trust_mode})` +
            remoteLine,
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
      added.map((c) => `+ ${oneLine(c.subject)} — ${oneLine(c.predicate)}: ${oneLine(c.object)}`).join('\n') +
      (added.length && removed.length ? '\n' : '') +
      removed.map((c) => `- ${oneLine(c.subject)} — ${oneLine(c.predicate)}: ${oneLine(c.object)}`).join('\n') +
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
        ? ctx.db
            .prepare("SELECT id, subject_id, authority FROM claim WHERE id = ? AND state = 'draft'")
            .all(args.claim)
        : ctx.db.prepare("SELECT id, subject_id, authority FROM claim WHERE state = 'draft'").all()
    ) as Array<{ id: string; subject_id: string; authority: number }>;

    if (!targets.length) {
      return { content: [{ type: 'text', text: 'no draft claims to approve' }], structuredContent: { approved: [] } };
    }

    // Every target is checked before any row changes; a protected or
    // higher-tier draft fails the whole batch instead of half-applying.
    const principals = targets.map((target) =>
      requireAction(ctx.root, 'approve', { tier: target.authority, subject: target.subject_id, claimId: target.id }),
    );
    const principal = principals[0]!;

    ctx.db.transaction(() => {
      const now = new Date().toISOString();
      const update = ctx.db.prepare(
        `UPDATE claim SET state = 'active', authority = MIN(authority, 2),
                          trust = 'canonical', last_verified_at = ? WHERE id = ?`,
      );
      for (const t of targets) update.run(now, t.id);
      for (const t of targets) runClaimWriteHooks(ctx.db, t.id);
      makeCommit(ctx.db, {
        ref: ctx.branch,
        entries: targets.map((t) => ({ claim_id: t.id, op: 'add' as const })),
        message: `mcp approve: ${targets.length} claim(s)`,
        author: `human:${principal.id}`,
        kind: 'write',
      });
    })();
    broadcastResourceUpdates();

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
    broadcastResourceUpdates();
    return {
      content: [{ type: 'text', text: `commit ${id} on ${ctx.branch}` }],
      structuredContent: { commit: id, branch: ctx.branch },
    };
  } finally {
    ctx.db.close();
  }
}

interface SyncArgs {
  replica?: string;
  replica_url?: string;
  author?: string;
}

async function toolSync(args: SyncArgs): Promise<ToolResult> {
  const ctx = context();
  try {
    const config = ensureConfig(ctx.root);
    // An explicit replica is the single-writer Litestream backup path. Team
    // remotes dispatch through the adapter (http, postgres, dir).
    const replicaUrl = args.replica ?? args.replica_url;
    const remote = replicaUrl ? undefined : config.remote;

    if (!replicaUrl && !remote) {
      throw new Error(
        'no remote configured; run `lore remote --hub <url>` / `--postgres` / `<dir>`, or pass replica_url for a single-writer Litestream backup',
      );
    }
    const target = replicaUrl ?? remoteLabel(remote!);
    const adapter = await createSyncAdapter(ctx.db, ctx.root, {
      replicaUrl,
      configPath: config.litestream?.config_path,
      remote,
    });
    const author = args.author ?? 'agent:mcp';
    const pullRes = await adapter.pull({ author });
    const pushRes = await adapter.push({ author });
    broadcastResourceUpdates();

    return {
      content: [
        {
          type: 'text',
          text: `synced ${adapter.kind} ${target}: pulled ${pullRes.commits} commit(s), ${pullRes.claims} claim(s) (merge: ${pullRes.merge}); pushed tip ${pushRes.tip ? pushRes.tip.slice(0, 7) : 'empty'} (checkpointed: ${pushRes.walCheckpointed})`,
        },
      ],
      structuredContent: {
        kind: adapter.kind,
        replica_url: target,
        pull: pullRes,
        push: pushRes,
      },
    };
  } finally {
    ctx.db.close();
  }
}

interface ProposeArgs {
  note?: string;
  session?: string;
}

/**
 * Publish the current session branch and its staged drafts as a hub proposal.
 * Contributors need no permission on main; the hub holds the bundle until a
 * maintainer approves and promotes it.
 */
async function toolPropose(args: ProposeArgs): Promise<ToolResult> {
  const ctx = context();
  try {
    const config = ensureConfig(ctx.root);
    if (!config.remote) throw new Error('no remote configured; run lore remote --hub <url>');
    if (config.remote.type !== 'http') {
      throw new Error('memory_propose needs a lore-hub (http) remote');
    }
    const remote: HttpRemote = config.remote;
    const session = args.session ?? ctx.session;
    const ref = branchFor(session);
    const tip = head(ctx.db, ref);
    const drafts = ctx.db.prepare("SELECT id FROM claim WHERE state = 'draft'").all() as Array<{ id: string }>;
    if (!tip && !drafts.length) throw new Error(`nothing to propose: ${ref} has no commits and no drafts exist`);

    const bundle = buildBundle(ctx.db, config.repo_id, tip ? [ref] : []);
    const proposal = await httpPropose(remote, config.repo_id, {
      session,
      baseMain: readConfig(ctx.root)?.hub_main ?? null,
      bundle,
      note: args.note ?? null,
    });
    return {
      content: [
        {
          type: 'text',
          text: `proposal ${proposal.ref} (${proposal.status}): ${proposal.claims} claim(s), ${proposal.commits} commit(s), ${drafts.length} draft(s) awaiting review`,
        },
      ],
      structuredContent: {
        ref: proposal.ref,
        status: proposal.status,
        user: proposal.user,
        session: proposal.session,
        tip: proposal.tip,
        claims: proposal.claims,
        commits: proposal.commits,
        drafts: drafts.length,
      },
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
  outputSchema?: Record<string, unknown>;
  run: (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;
}

const ARGS = (args: Record<string, unknown> | undefined): Record<string, unknown> => args ?? {};

const TOOLS: ToolDef[] = [
  {
    name: 'memory_search',
    description:
      'Score the active set of your Lore memory branch against the task scope (SPEC §9). Only active+canonical claims are injected; contested facts are withheld and returned as warnings. Stale claims are excluded by default.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'free text' },
        files: { type: 'array', items: { type: 'string' }, description: 'paths in scope' },
        symbols: { type: 'array', items: { type: 'string' }, description: 'entity ids in scope' },
        budget_tokens: { type: 'number', description: 'context budget, default 2000' },
        include_stale: { type: 'boolean', description: 'keep stale claims in the result' },
        as_of: { type: 'string', description: 'ISO instant: read memory as it was known and valid then (shorthand for valid_at + tx_at)' },
        valid_at: { type: 'string', description: 'ISO instant: read memory valid in the world at this instant' },
        tx_at: { type: 'string', description: 'ISO instant: read memory recorded by the system at this instant' },
        trust_remote: { type: 'boolean', description: 'include claims observed on newer code than this checkout' },
        include_external: { type: 'boolean', description: 'include read-only [EXT] claims cached from linked repositories (ext: namespace)' },
        semantic: { type: 'boolean', description: 'enable vector embeddings and semantic hybrid search' },
        vector_weight: { type: 'number', minimum: 0, maximum: 1, description: 'weight of vector similarity in hybrid search (default 0.5)' },
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
        valid_from: { type: 'string', description: 'ISO date when the claim became true' },
        ttl_days: { type: 'number', minimum: 0, description: 'decay after N days without re-verification (default: ontology)' },
        scrub: { type: 'boolean', description: 'auto-redact detected secrets before persistence (default: true)' },
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
  {
    name: 'memory_sync',
    description:
      'Bi-directionally synchronize memory with a remote replica or storage target (pulls remote changes and pushes local tip).',
    inputSchema: {
      type: 'object',
      properties: {
        replica: { type: 'string', description: 'override replica target URL' },
        replica_url: { type: 'string', description: 'override replica target URL (alias for replica)' },
        author: { type: 'string', description: 'author identity for sync operations' },
      },
    },
    run: (args) => toolSync(ARGS(args) as unknown as SyncArgs),
  },
  {
    name: 'memory_propose',
    description:
      'Publish this session branch and its staged drafts as a hub proposal (refs/proposals/<user>/<session>) for maintainer review. Never pushes main.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'review note stored with the proposal' },
        session: { type: 'string', description: 'session to propose (default: current session)' },
      },
    },
    run: (args) => toolPropose(ARGS(args) as unknown as ProposeArgs),
  },
];

// --- output schemas ------------------------------------------------------------------
// Each schema describes exactly the structuredContent the tool returns, so a client
// can validate results instead of guessing from the text block.

const CLAIM_SHAPE = {
  type: 'object',
  required: ['id', 'subject', 'predicate', 'object'],
  properties: {
    id: { type: 'string' },
    subject: { type: 'string' },
    predicate: { type: 'string' },
    object: { type: 'string' },
  },
} as const;

const OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  memory_search: {
    type: 'object',
    required: ['hits', 'count'],
    properties: {
      hits: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'subject', 'predicate', 'object', 'score', 'stale'],
          properties: {
            id: { type: 'string' },
            subject: { type: 'string' },
            predicate: { type: 'string' },
            object: { type: 'string' },
            score: { type: 'number' },
            stale: { type: 'boolean' },
            ahead: { type: 'boolean' },
            external: { type: 'boolean' },
            origin_repo_id: { type: ['string', 'null'] },
            trust: {
              type: 'string',
              enum: ['canonical', 'candidate', 'contested', 'stale', 'retracted'],
            },
            authority: { type: 'integer', minimum: 0, maximum: 4 },
            author: { type: 'string' },
            reasons: { type: 'array', items: { type: 'string' } },
            evidence: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string' },
                  ref: { type: 'string' },
                  hash: { type: ['string', 'null'] },
                  status: { type: 'string' },
                },
              },
            },
          },
        },
      },
      count: { type: 'integer', minimum: 0 },
      warnings: { type: 'array', items: { type: 'string' } },
      contested: {
        type: 'array',
        items: {
          type: 'object',
          required: ['subject', 'predicate', 'claim_ids', 'open'],
          properties: {
            subject: { type: 'string' },
            predicate: { type: 'string' },
            claim_ids: { type: 'array', items: { type: 'string' } },
            open: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
  },
  memory_write: {
    type: 'object',
    required: ['id', 'state', 'authority', 'inserted', 'branch'],
    properties: {
      id: { type: 'string' },
      state: { type: 'string', enum: ['draft', 'active', 'retracted'] },
      authority: { type: 'integer', minimum: 0, maximum: 4 },
      inserted: { type: 'boolean' },
      branch: { type: 'string' },
    },
  },
  memory_blame: {
    type: 'object',
    required: ['claims'],
    properties: {
      claims: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'subject', 'predicate', 'object', 'state', 'in_branch'],
          properties: {
            id: { type: 'string' },
            subject: { type: 'string' },
            predicate: { type: 'string' },
            object: { type: 'string' },
            state: { type: 'string' },
            in_branch: { type: 'boolean' },
            authority: { type: 'integer' },
            confidence: { type: 'number' },
            author: { type: 'string' },
            evidence: { type: 'array', items: { type: 'object' } },
          },
        },
      },
    },
  },
  memory_status: {
    type: 'object',
    required: ['branch', 'session', 'active_set', 'drafts', 'stale', 'ahead'],
    properties: {
      branch: { type: 'string' },
      session: { type: 'string' },
      active_set: { type: 'integer', minimum: 0 },
      drafts: { type: 'integer', minimum: 0 },
      stale: { type: 'integer', minimum: 0 },
      ahead: { type: 'integer', minimum: 0 },
      trust_mode: { type: 'string' },
      remote_behind: { type: ['integer', 'null'], minimum: 0 },
      remote_rows_behind: { type: ['integer', 'null'], minimum: 0 },
      remote_state: { type: 'string', enum: ['not-configured', 'unknown', 'synced', 'behind', 'unreachable'] },
      remote: {
        type: ['object', 'null'],
        properties: {
          reachable: { type: ['boolean', 'null'] },
          behind: { type: ['integer', 'null'] },
          rows_behind: { type: ['integer', 'null'] },
          main: { type: ['string', 'null'] },
          checked_at: { type: ['string', 'null'] },
          error: { type: ['string', 'null'] },
        },
      },
    },
  },
  memory_diff: {
    type: 'object',
    required: ['from', 'to', 'added', 'removed'],
    properties: {
      from: { type: 'string' },
      to: { type: 'string' },
      added: { type: 'array', items: CLAIM_SHAPE },
      removed: { type: 'array', items: CLAIM_SHAPE },
    },
  },
  memory_approve: {
    type: 'object',
    required: ['approved'],
    properties: { approved: { type: 'array', items: { type: 'string' } } },
  },
  memory_commit: {
    type: 'object',
    required: ['commit', 'branch'],
    properties: { commit: { type: 'string' }, branch: { type: 'string' } },
  },
  memory_sync: {
    type: 'object',
    required: ['kind', 'replica_url', 'pull', 'push'],
    properties: {
      kind: { type: 'string', enum: ['http', 'postgres', 'dir', 'litestream'] },
      replica_url: { type: 'string' },
      pull: {
        type: 'object',
        required: ['entities', 'claims', 'commits', 'merge'],
        properties: {
          entities: { type: 'integer' },
          claims: { type: 'integer' },
          commits: { type: 'integer' },
          merge: { type: 'string' },
        },
      },
      push: {
        type: 'object',
        required: ['walCheckpointed', 'actionId'],
        properties: {
          walCheckpointed: { type: 'boolean' },
          tip: { type: ['string', 'null'] },
          actionId: { type: 'integer' },
        },
      },
    },
  },
  memory_propose: {
    type: 'object',
    required: ['ref', 'status', 'claims', 'commits', 'drafts'],
    properties: {
      ref: { type: 'string' },
      status: { type: 'string' },
      user: { type: 'string' },
      session: { type: 'string' },
      tip: { type: ['string', 'null'] },
      claims: { type: 'integer' },
      commits: { type: 'integer' },
      drafts: { type: 'integer' },
    },
  },
};

for (const tool of TOOLS) {
  tool.outputSchema = OUTPUT_SCHEMAS[tool.name] ?? { type: 'object', additionalProperties: true };
}

// --- method dispatch -----------------------------------------------------------------

async function dispatchToolCall(id: JsonId, params: Record<string, unknown> | undefined): Promise<void> {
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
    const result = await tool.run(args as Record<string, unknown>);
    ok(id, result);
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

async function handleRequest(id: JsonId, method: string, params: Record<string, unknown> | undefined): Promise<void> {
  switch (method) {
    case 'initialize': {
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : null;
      const supported = requested ? SUPPORTED_PROTOCOL_VERSIONS.includes(requested) : false;
      if (requested && !supported) {
        console.error(`[lore] unsupported MCP protocol version ${requested}; negotiating ${FALLBACK_PROTOCOL_VERSION}`);
      }
      const protocolVersion = requested && supported ? requested : FALLBACK_PROTOCOL_VERSION;
      ok(id, {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: true, listChanged: true },
        },
        serverInfo: { name: 'lore', version: SERVER_VERSION },
        instructions: 'Versioned, verifiable memory. Read docs/mcp.md; each session writes to agent/<session>.',
      });
      // Answer the handshake first, then pull the team delta without blocking.
      void autoSyncOnInitialize();
      return;
    }
    case 'resources/list':
      ok(id, { resources: STATIC_RESOURCES });
      return;
    case 'resources/templates/list':
      ok(id, { resourceTemplates: RESOURCE_TEMPLATES });
      return;
    case 'resources/read': {
      const uri = typeof params?.uri === 'string' ? params.uri : null;
      if (!uri) {
        fail(id, -32602, 'missing or invalid uri');
        return;
      }
      const ctx = context();
      try {
        const result = readResource(ctx, uri);
        ok(id, result);
      } catch (err) {
        fail(id, -32602, err instanceof Error ? err.message : String(err));
      } finally {
        ctx.db.close();
      }
      return;
    }
    case 'resources/subscribe': {
      const uri = typeof params?.uri === 'string' ? params.uri : null;
      if (!uri) {
        fail(id, -32602, 'missing or invalid uri');
        return;
      }
      resourceSubscriptions.add(uri);
      ok(id, {});
      return;
    }
    case 'resources/unsubscribe': {
      const uri = typeof params?.uri === 'string' ? params.uri : null;
      if (uri) {
        resourceSubscriptions.delete(uri);
      }
      ok(id, {});
      return;
    }
    case 'tools/list':
      ok(id, {
        tools: TOOLS.map(({ name, description, inputSchema, outputSchema }) => ({
          name,
          description,
          inputSchema,
          ...(outputSchema ? { outputSchema } : {}),
        })),
      });
      return;
    case 'tools/call':
      await dispatchToolCall(id, params);
      return;
    case 'ping':
      ok(id, {});
      return;
    default:
      fail(id, -32601, `method not found: ${method}`);
  }
}

async function handleLine(line: string): Promise<void> {
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
    await handleRequest(id, message.method, params);
  } catch (error) {
    // Last-resort guard: the loop must survive anything.
    const msg = error instanceof Error ? error.message : String(error);
    log(`internal error handling ${message.method}: ${msg}`);
    fail(id, -32603, `internal error: ${msg}`);
  }
}

export function runMcpServer(): void {
  installCanon();
  log(`lore mcp v${SERVER_VERSION} — ${TOOLS.length} tools — protocol on stdout, logs on stderr`);
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    void handleLine(line);
  });
  rl.on('close', () => process.exit(0));
}
