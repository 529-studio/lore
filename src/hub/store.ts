import { createHash, randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { parse } from 'yaml';
import type { Bundle } from '../sync.js';
import { isMember, matchSubject, type GranularPolicyFile } from '../policy/auth.js';

export interface HubPrincipal {
  sub: string;
  role: string;
  jti: string | null;
  repoId?: string | null;
}

export interface HubRepoState {
  main: string | null;
  policy: GranularPolicyFile | null;
}

export class HubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HubError';
  }
}

const SCHEMA = `
CREATE SEQUENCE IF NOT EXISTS hub_seq;
CREATE TABLE IF NOT EXISTS repos (
  repo_id text PRIMARY KEY,
  main_commit text,
  policy jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS repo_commits (
  repo_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL,
  seq bigint NOT NULL DEFAULT nextval('hub_seq'), PRIMARY KEY (repo_id, id)
);
CREATE TABLE IF NOT EXISTS repo_refs (
  repo_id text NOT NULL, name text NOT NULL, commit_id text NOT NULL,
  seq bigint NOT NULL DEFAULT nextval('hub_seq'), PRIMARY KEY (repo_id, name)
);
CREATE TABLE IF NOT EXISTS repo_entities (
  repo_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL,
  seq bigint NOT NULL DEFAULT nextval('hub_seq'), PRIMARY KEY (repo_id, id)
);
CREATE TABLE IF NOT EXISTS repo_claims (
  repo_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL,
  seq bigint NOT NULL DEFAULT nextval('hub_seq'), PRIMARY KEY (repo_id, id)
);
CREATE TABLE IF NOT EXISTS repo_evidence (
  repo_id text NOT NULL, claim_id text NOT NULL, kind text NOT NULL, ref text NOT NULL, payload jsonb NOT NULL,
  seq bigint NOT NULL DEFAULT nextval('hub_seq'), PRIMARY KEY (repo_id, claim_id, kind, ref)
);
CREATE TABLE IF NOT EXISTS repo_commit_entries (
  repo_id text NOT NULL, commit_id text NOT NULL, claim_id text NOT NULL, op text NOT NULL, payload jsonb NOT NULL,
  seq bigint NOT NULL DEFAULT nextval('hub_seq'), PRIMARY KEY (repo_id, commit_id, claim_id, op)
);
CREATE TABLE IF NOT EXISTS repo_conflicts (
  repo_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL,
  seq bigint NOT NULL DEFAULT nextval('hub_seq'), PRIMARY KEY (repo_id, id)
);
CREATE TABLE IF NOT EXISTS repo_tombstones (
  repo_id text NOT NULL, kind text NOT NULL, claim_id text NOT NULL, payload jsonb NOT NULL,
  seq bigint NOT NULL DEFAULT nextval('hub_seq'), PRIMARY KEY (repo_id, kind, claim_id)
);
CREATE TABLE IF NOT EXISTS auth_revocations (
  jti text PRIMARY KEY, sub text, reason text, revoked_by text, revoked_at timestamptz NOT NULL DEFAULT now(),
  seq bigint NOT NULL DEFAULT nextval('hub_seq')
);
CREATE TABLE IF NOT EXISTS hub_tokens (
  token_hash text PRIMARY KEY, sub text NOT NULL, role text NOT NULL, repo_id text,
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
`;

let schemaReady: Promise<void> | null = null;

export function databaseUrl(): string {
  const url = process.env.LORE_HUB_DATABASE_URL?.trim();
  if (!url) throw new HubError(500, 'LORE_HUB_DATABASE_URL is not set');
  return url;
}

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 10_000 });
  await client.connect();
  return client;
}

/** Schema creation is idempotent and shared per process. */
export async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const client = await connect();
      try {
        await client.query(SCHEMA);
      } finally {
        await client.end();
      }
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function authenticate(client: Client, token: string): Promise<HubPrincipal> {
  const admin = process.env.LORE_HUB_ADMIN_TOKEN;
  if (admin && token === admin) return { sub: 'admin', role: 'maintainer', jti: null, repoId: null };
  const hash = hashToken(token);
  const { rows } = await client.query(
    'SELECT sub, role, repo_id, revoked_at FROM hub_tokens WHERE token_hash = $1',
    [hash],
  );
  const row = rows[0] as { sub: string; role: string; repo_id: string | null; revoked_at: Date | null } | undefined;
  if (!row || row.revoked_at) throw new HubError(401, 'invalid or revoked token');
  const revoked = await client.query('SELECT 1 FROM auth_revocations WHERE jti = $1', [hash]);
  if (revoked.rows[0]) throw new HubError(401, 'token has been revoked');
  return { sub: row.sub, role: row.role, jti: hash, repoId: row.repo_id };
}

export function tokenRepoAllowed(principal: HubPrincipal, repoId: string): void {
  if (!principal.repoId) return;
  if (principal.repoId !== repoId) throw new HubError(403, `token is scoped to repository ${principal.repoId}`);
}

export async function issueToken(
  client: Client,
  input: { sub: string; role: string; repoId?: string | null },
): Promise<{ token: string; jti: string; sub: string; role: string; repoId: string | null }> {
  const token = `lore_${randomBytes(24).toString('base64url')}`;
  const jti = hashToken(token);
  await client.query('INSERT INTO hub_tokens(token_hash, sub, role, repo_id) VALUES ($1, $2, $3, $4)', [
    jti,
    input.sub,
    input.role,
    input.repoId ?? null,
  ]);
  return { token, jti, sub: input.sub, role: input.role, repoId: input.repoId ?? null };
}

export async function revokeToken(client: Client, input: { jti: string; reason?: string; by?: string }): Promise<void> {
  await client.query(
    `INSERT INTO auth_revocations(jti, sub, reason, revoked_by)
     VALUES ($1, (SELECT sub FROM hub_tokens WHERE token_hash = $1), $2, $3)
     ON CONFLICT (jti) DO UPDATE SET reason = excluded.reason, revoked_by = excluded.revoked_by, revoked_at = now()`,
    [input.jti, input.reason ?? 'administrative revocation', input.by ?? 'admin'],
  );
  await client.query('UPDATE hub_tokens SET revoked_at = now() WHERE token_hash = $1', [input.jti]);
}

async function repoState(client: Client, repoId: string): Promise<HubRepoState> {
  const { rows } = await client.query('SELECT main_commit, policy FROM repos WHERE repo_id = $1', [repoId]);
  return {
    main: (rows[0]?.main_commit as string | null) ?? null,
    policy: (rows[0]?.policy as GranularPolicyFile | null) ?? null,
  };
}

/**
 * Repository rows and global revocations need separate cursors: a revocation
 * committed in another repository can otherwise advance the single cursor past
 * this repository's still-uncommitted rows. Each cursor is derived from
 * MVCC-visible rows only, never from the sequence's last_value.
 */
async function repoCursor(client: Client, repoId: string): Promise<number> {
  const { rows } = await client.query(
    `SELECT GREATEST(
       COALESCE((SELECT max(seq) FROM repo_commits WHERE repo_id = $1), 0),
       COALESCE((SELECT max(seq) FROM repo_refs WHERE repo_id = $1), 0),
       COALESCE((SELECT max(seq) FROM repo_entities WHERE repo_id = $1), 0),
       COALESCE((SELECT max(seq) FROM repo_claims WHERE repo_id = $1), 0),
       COALESCE((SELECT max(seq) FROM repo_evidence WHERE repo_id = $1), 0),
       COALESCE((SELECT max(seq) FROM repo_commit_entries WHERE repo_id = $1), 0),
       COALESCE((SELECT max(seq) FROM repo_conflicts WHERE repo_id = $1), 0),
       COALESCE((SELECT max(seq) FROM repo_tombstones WHERE repo_id = $1), 0)
     ) AS seq`,
    [repoId],
  );
  return Number(rows[0]?.seq ?? 0);
}

async function authCursor(client: Client): Promise<number> {
  const { rows } = await client.query('SELECT COALESCE(max(seq), 0) AS seq FROM auth_revocations');
  return Number(rows[0]?.seq ?? 0);
}

function rowsToBundle(repoId: string, rows: Record<string, Array<Record<string, unknown>>>, main: string | null): Bundle {
  return {
    format: 'lore-bundle/1',
    repo_id: repoId,
    created_at: new Date().toISOString(),
    refs: main ? [{ name: 'main', commit_id: main }] : [],
    entities: rows.entities,
    claims: rows.claims,
    evidence: rows.evidence,
    commits: rows.commits,
    entries: rows.entries,
    conflicts: rows.conflicts,
    redactions: rows.redactions,
    purge_audits: rows.purges,
    token_revocations: rows.revocations,
    attestations: [],
  };
}

/**
 * Delta pull: only rows with seq beyond the caller's cursor, plus the current
 * main and cursor. A first pull (since 0) returns the full normalized state.
 */
export async function pull(
  client: Client,
  repoId: string,
  sinceSeq: number,
  sinceAuthSeq = 0,
): Promise<{ bundle: Bundle; main: string | null; seq: number; auth_seq: number }> {
  const state = await repoState(client, repoId);
  const since = Number.isFinite(sinceSeq) && sinceSeq > 0 ? sinceSeq : 0;
  const sinceAuth = Number.isFinite(sinceAuthSeq) && sinceAuthSeq > 0 ? sinceAuthSeq : 0;
  await client.query('BEGIN');
  try {
    // Writers hold this lock from before allocating a revocation seq until
    // commit, so max(seq) here sees every row below the cursor.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('lore_hub_auth'))");
    const cursor = await repoCursor(client, repoId);
    const auth = await authCursor(client);
    const q = async (sql: string): Promise<Array<Record<string, unknown>>> =>
      (await client.query(sql, [repoId, since])).rows.map((row) => row.payload as Record<string, unknown>);
    const rows = {
      commits: await q('SELECT payload FROM repo_commits WHERE repo_id = $1 AND seq > $2 ORDER BY seq'),
      claims: await q('SELECT payload FROM repo_claims WHERE repo_id = $1 AND seq > $2 ORDER BY seq'),
      evidence: await q('SELECT payload FROM repo_evidence WHERE repo_id = $1 AND seq > $2 ORDER BY seq'),
      entities: await q('SELECT payload FROM repo_entities WHERE repo_id = $1 AND seq > $2 ORDER BY seq'),
      entries: await q('SELECT payload FROM repo_commit_entries WHERE repo_id = $1 AND seq > $2 ORDER BY seq'),
      conflicts: await q('SELECT payload FROM repo_conflicts WHERE repo_id = $1 AND seq > $2 ORDER BY seq'),
      redactions: await q("SELECT payload FROM repo_tombstones WHERE repo_id = $1 AND kind = 'redaction' AND seq > $2 ORDER BY seq"),
      purges: await q("SELECT payload FROM repo_tombstones WHERE repo_id = $1 AND kind = 'purge' AND seq > $2 ORDER BY seq"),
      revocations: [] as Array<Record<string, unknown>>,
    };
    // auth_revocations stores columns, not a JSON payload; map explicitly.
    const revocations = (
      await client.query(
        'SELECT jti, sub, reason, revoked_by, revoked_at FROM auth_revocations WHERE seq > $1 ORDER BY seq',
        [sinceAuth],
      )
    ).rows.map((row) => ({
      jti: row.jti,
      sub: row.sub,
      reason: row.reason,
      revoked_by: row.revoked_by,
      revoked_at: new Date(row.revoked_at).toISOString(),
    }));
    rows.revocations = revocations;
    await client.query('COMMIT');
    return { bundle: rowsToBundle(repoId, rows, state.main), main: state.main, seq: cursor, auth_seq: auth };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* transaction already closed */
    }
    throw error;
  }
}

function principalIdentity(principal: HubPrincipal): {
  id: string;
  role: 'maintainer' | 'contributor' | 'machine' | 'auditor';
  source: 'token';
} {
  return {
    id: principal.sub,
    role: principal.role as 'maintainer' | 'contributor' | 'machine' | 'auditor',
    source: 'token',
  };
}

function rolesAllow(
  policy: GranularPolicyFile | null,
  roles: string[],
  principal: HubPrincipal,
): boolean {
  const identity = principalIdentity(principal);
  return roles.some((role) => isMember(policy, role, identity));
}

function assertPolicyAllows(
  policy: GranularPolicyFile | null,
  principal: HubPrincipal,
  bundle: Bundle,
  storedSubjects: Map<string, string>,
): void {
  if (!policy || principal.role === 'maintainer') return;
  for (const claim of bundle.claims) {
    const id = String(claim.id ?? '');
    const stored = storedSubjects.get(id);
    const incoming = typeof claim.subject_id === 'string' ? claim.subject_id : undefined;
    if (stored && incoming && stored !== incoming) {
      throw new HubError(403, `claim ${id} cannot change its subject`);
    }
    const subject = stored ?? incoming;
    if (!subject) continue;
    for (const [pattern, roles] of Object.entries(policy.write ?? {})) {
      if (matchSubject(pattern, subject) && !rolesAllow(policy, roles, principal)) {
        throw new HubError(403, `write to ${subject} requires role ${roles.join(' or ')}`);
      }
    }
    for (const [pattern, roles] of Object.entries(policy.protected ?? {})) {
      if (matchSubject(pattern, subject) && !rolesAllow(policy, roles, principal)) {
        throw new HubError(403, `subject ${subject} is protected; requires role ${roles.join(' or ')}`);
      }
    }
  }
}

export interface PushResult {
  main: string | null;
  seq: number;
  auth_seq: number;
}

export interface PushInput {
  repoId: string;
  bundle: Bundle;
  expectedMain: string | null;
  principal: HubPrincipal;
  /** lore.policy.yml text from the checkout; honoured only for maintainers. */
  policy?: string | null;
}

function parsePolicy(text: string): GranularPolicyFile {
  const parsed = parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HubError(400, 'policy must be a YAML mapping');
  }
  return parsed as GranularPolicyFile;
}

/**
 * Optimistic CAS push under a short row lock. Row upserts only bump seq when the
 * payload actually changed, so a peer pulling by cursor receives deltas.
 */
export async function push(client: Client, input: PushInput): Promise<PushResult> {
  const { repoId, principal } = input;
  let bundle = input.bundle;
  await client.query('BEGIN');
  try {
    await client.query('INSERT INTO repos(repo_id) VALUES ($1) ON CONFLICT (repo_id) DO NOTHING', [repoId]);
    const { rows } = await client.query('SELECT main_commit, policy FROM repos WHERE repo_id = $1 FOR UPDATE', [repoId]);
    const currentMain = (rows[0]?.main_commit as string | null) ?? null;
    const currentPolicy = (rows[0]?.policy as GranularPolicyFile | null) ?? null;
    const mainRef = bundle.refs.find((ref) => ref.name === 'main')?.commit_id ?? null;

    if (input.expectedMain !== currentMain) {
      await client.query('ROLLBACK');
      throw new HubError(409, 'remote main moved; pull and retry');
    }
    if (mainRef && mainRef !== currentMain && principal.role !== 'maintainer') {
      await client.query('ROLLBACK');
      throw new HubError(403, 'only a maintainer may advance main');
    }

    let policy = currentPolicy;
    if (input.policy && principal.role === 'maintainer') {
      policy = parsePolicy(input.policy);
      await client.query('UPDATE repos SET policy = $2 WHERE repo_id = $1', [repoId, policy]);
    }

    if (principal.role !== 'maintainer' && (bundle.token_revocations?.length ?? 0) > 0) {
      // Revocations are global security state; a contributor cannot revoke a
      // peer. Drop the rows instead of failing the whole sync.
      bundle = { ...bundle, token_revocations: [] };
    }

    const claimIds = [
      ...(bundle.claims ?? []).map((row) => String(row.id ?? '')),
      ...(bundle.redactions ?? []).map((row) => String(row.claim_id ?? '')),
      ...(bundle.purge_audits ?? []).map((row) => String(row.claim_id ?? '')),
    ].filter(Boolean);
    const storedSubjects = new Map<string, string>();
    if (claimIds.length) {
      const { rows: stored } = await client.query(
        'SELECT id, payload FROM repo_claims WHERE repo_id = $1 AND id = ANY($2::text[])',
        [repoId, claimIds],
      );
      for (const row of stored as Array<{ id: string; payload: Record<string, unknown> }>) {
        if (typeof row.payload.subject_id === 'string') storedSubjects.set(row.id, row.payload.subject_id);
      }
    }
    assertPolicyAllows(policy, principal, bundle, storedSubjects);

    if (principal.role !== 'maintainer') {
      // A contributor may echo tombstones it already knows, but cannot create
      // new ones: a purge/redact would otherwise destroy a peer's claim.
      const known = new Set(
        (
          await client.query('SELECT kind, claim_id FROM repo_tombstones WHERE repo_id = $1', [repoId])
        ).rows.map((row) => `${row.kind}:${row.claim_id}`),
      );
      bundle = {
        ...bundle,
        redactions: (bundle.redactions ?? []).filter((row) => known.has(`redaction:${row.claim_id}`)),
        purge_audits: (bundle.purge_audits ?? []).filter((row) => known.has(`purge:${row.claim_id}`)),
      };
    }

    const upsert = async (
      table: string,
      keys: string[],
      conflict: string,
      values: unknown[],
    ): Promise<void> => {
      // table/column names are fixed by this module, never caller input.
      await client.query(
        `INSERT INTO ${table} AS target (${keys.join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT (${conflict}) DO UPDATE
         SET payload = excluded.payload, seq = nextval('hub_seq')
         WHERE target.payload IS DISTINCT FROM excluded.payload`,
        values,
      );
    };

    for (const row of bundle.commits ?? []) {
      await upsert('repo_commits', ['repo_id', 'id', 'payload'], 'repo_id, id', [repoId, row.id, row]);
    }
    for (const row of bundle.entities ?? []) {
      await upsert('repo_entities', ['repo_id', 'id', 'payload'], 'repo_id, id', [repoId, row.id, row]);
    }
    for (const row of bundle.claims ?? []) {
      await upsert('repo_claims', ['repo_id', 'id', 'payload'], 'repo_id, id', [repoId, row.id, row]);
    }
    for (const row of bundle.evidence ?? []) {
      const key = [repoId, row.claim_id, row.kind, row.ref];
      await upsert(
        'repo_evidence',
        ['repo_id', 'claim_id', 'kind', 'ref', 'payload'],
        'repo_id, claim_id, kind, ref',
        [...key, row],
      );
    }
    for (const row of bundle.entries ?? []) {
      await upsert(
        'repo_commit_entries',
        ['repo_id', 'commit_id', 'claim_id', 'op', 'payload'],
        'repo_id, commit_id, claim_id, op',
        [repoId, row.commit_id, row.claim_id, row.op, row],
      );
    }
    for (const row of bundle.conflicts ?? []) {
      const id = String(row.id ?? `${row.left_claim}:${row.right_claim}`);
      await upsert('repo_conflicts', ['repo_id', 'id', 'payload'], 'repo_id, id', [repoId, id, row]);
    }
    for (const row of bundle.redactions ?? []) {
      await upsert(
        'repo_tombstones',
        ['repo_id', 'kind', 'claim_id', 'payload'],
        'repo_id, kind, claim_id',
        [repoId, 'redaction', row.claim_id, row],
      );
    }
    for (const row of bundle.purge_audits ?? []) {
      await upsert(
        'repo_tombstones',
        ['repo_id', 'kind', 'claim_id', 'payload'],
        'repo_id, kind, claim_id',
        [repoId, 'purge', row.claim_id, row],
      );
    }
    if ((bundle.token_revocations?.length ?? 0) > 0) {
      // Global revocation cursors rely on allocation order matching commit
      // order; hold this lock until commit so no lower seq commits later.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('lore_hub_auth'))");
    }
    for (const row of bundle.token_revocations ?? []) {
      if (!row.jti) continue;
      await client.query(
        `INSERT INTO auth_revocations(jti, sub, reason, revoked_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (jti) DO UPDATE
         SET reason = excluded.reason, seq = nextval('hub_seq')
         WHERE auth_revocations.reason IS DISTINCT FROM excluded.reason`,
        [row.jti, row.sub ?? null, row.reason ?? null, row.revoked_by ?? 'sync'],
      );
    }
    for (const ref of bundle.refs ?? []) {
      await client.query(
        `INSERT INTO repo_refs(repo_id, name, commit_id) VALUES ($1, $2, $3)
         ON CONFLICT (repo_id, name) DO UPDATE SET commit_id = excluded.commit_id, seq = nextval('hub_seq')
         WHERE repo_refs.commit_id IS DISTINCT FROM excluded.commit_id`,
        [repoId, ref.name, ref.commit_id],
      );
    }
    const nextMain = mainRef ?? currentMain;
    await client.query('UPDATE repos SET main_commit = $2, updated_at = now() WHERE repo_id = $1', [repoId, nextMain]);
    // Compute under the transaction so the returned cursors cover exactly the
    // rows the client is about to have after a pull.
    const seq = await repoCursor(client, repoId);
    const authSeq = await authCursor(client);
    await client.query('COMMIT');
    return { main: nextMain, seq, auth_seq: authSeq };
  } catch (error) {
    if (!(error instanceof HubError) || error.status !== 409) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* transaction already closed */
      }
    }
    throw error;
  }
}
