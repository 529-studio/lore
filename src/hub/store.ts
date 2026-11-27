import { createHash, randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { parse } from 'yaml';
import type { Bundle, ExternalBundle } from '../sync.js';
import { isMember, matchSubject, protectedRoles, quorumFor, type GranularPolicyFile } from '../policy/auth.js';
import { publishDecision, subscriberAllowed } from '../policy/publish.js';

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
ALTER TABLE repo_claims ADD COLUMN IF NOT EXISTS origin_repo_id text NOT NULL DEFAULT '';
ALTER TABLE repo_entities ADD COLUMN IF NOT EXISTS origin_repo_id text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS repo_attestations (
  repo_id text NOT NULL, claim_id text NOT NULL, attestation_claim_id text NOT NULL,
  pushed_by text NOT NULL DEFAULT '', pushed_role text NOT NULL DEFAULT '',
  payload jsonb NOT NULL,
  seq bigint NOT NULL DEFAULT nextval('hub_seq'), PRIMARY KEY (repo_id, claim_id, attestation_claim_id)
);
ALTER TABLE repo_attestations ADD COLUMN IF NOT EXISTS pushed_by text NOT NULL DEFAULT '';
ALTER TABLE repo_attestations ADD COLUMN IF NOT EXISTS pushed_role text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS repo_proposals (
  repo_id text NOT NULL, user_id text NOT NULL, session text NOT NULL, ref text NOT NULL,
  base_main text, tip_commit text, status text NOT NULL DEFAULT 'open',
  payload jsonb NOT NULL, note text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text, reviewed_at timestamptz, promoted_main text, promoted_at timestamptz,
  seq bigint NOT NULL DEFAULT nextval('hub_seq'),
  PRIMARY KEY (repo_id, user_id, session)
);
CREATE INDEX IF NOT EXISTS repo_proposals_status ON repo_proposals(repo_id, status);
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
  await client.query('BEGIN');
  try {
    // Same lock as push/pull: revocation allocation order must match commit
    // order for the auth cursor to be safe.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('lore_hub_auth'))");
    await client.query(
      `INSERT INTO auth_revocations(jti, sub, reason, revoked_by)
       VALUES ($1, (SELECT sub FROM hub_tokens WHERE token_hash = $1), $2, $3)
       ON CONFLICT (jti) DO UPDATE SET reason = excluded.reason, revoked_by = excluded.revoked_by, revoked_at = now()`,
      [input.jti, input.reason ?? 'administrative revocation', input.by ?? 'admin'],
    );
    await client.query('UPDATE hub_tokens SET revoked_at = now() WHERE token_hash = $1', [input.jti]);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* transaction already closed */
    }
    throw error;
  }
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
       COALESCE((SELECT max(seq) FROM repo_tombstones WHERE repo_id = $1), 0),
       COALESCE((SELECT max(seq) FROM repo_attestations WHERE repo_id = $1), 0)
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
    attestations: rows.attestations,
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
      attestations: await q('SELECT payload FROM repo_attestations WHERE repo_id = $1 AND seq > $2 ORDER BY seq'),
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

/**
 * Read-only cross-repository payload. The response is filtered on the server
 * with the same helper `lore export --filter publish` uses, so a subject that
 * is not publishable can never appear in an external payload. Only a token
 * scoped to a subscriber listed in `publish.to_repos` may call this.
 */
export async function pullExternal(
  client: Client,
  sourceRepoId: string,
  subscriberRepoId: string,
): Promise<{ bundle: ExternalBundle; cursor: number }> {
  const state = await repoState(client, sourceRepoId);
  if (!subscriberAllowed(state.policy, subscriberRepoId)) {
    throw new HubError(403, `repository ${sourceRepoId} does not publish to ${subscriberRepoId}`);
  }

  const { rows: claimRows } = await client.query(
    'SELECT payload FROM repo_claims WHERE repo_id = $1 ORDER BY seq',
    [sourceRepoId],
  );
  const claims = (claimRows as Array<{ payload: Record<string, unknown> }>)
    .map((row) => row.payload)
    .filter((claim) =>
      publishDecision(state.policy, {
        subject: String(claim.subject_id ?? ''),
        trust: typeof claim.trust === 'string' ? claim.trust : 'candidate',
        state: typeof claim.state === 'string' ? claim.state : 'active',
        valid_to: typeof claim.valid_to === 'string' ? claim.valid_to : null,
      }).publishable,
    );

  const claimIds = claims.map((claim) => String(claim.id ?? '')).filter(Boolean);
  const subjectIds = [...new Set(claims.map((claim) => String(claim.subject_id ?? '')).filter(Boolean))];
  const { rows: evidenceRows } = claimIds.length
    ? await client.query(
        'SELECT payload FROM repo_evidence WHERE repo_id = $1 AND claim_id = ANY($2::text[]) ORDER BY seq',
        [sourceRepoId, claimIds],
      )
    : { rows: [] as Array<{ payload: Record<string, unknown> }> };
  const { rows: entityRows } = subjectIds.length
    ? await client.query(
        'SELECT payload FROM repo_entities WHERE repo_id = $1 AND id = ANY($2::text[]) ORDER BY seq',
        [sourceRepoId, subjectIds],
      )
    : { rows: [] as Array<{ payload: Record<string, unknown> }> };

  return {
    bundle: {
      format: 'lore-external/1',
      origin_repo_id: sourceRepoId,
      subscriber_repo_id: subscriberRepoId,
      created_at: new Date().toISOString(),
      claims,
      evidence: (evidenceRows as Array<{ payload: Record<string, unknown> }>).map((row) => row.payload),
      entities: (entityRows as Array<{ payload: Record<string, unknown> }>).map((row) => row.payload),
    },
    cursor: await repoCursor(client, sourceRepoId),
  };
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
    for (const [pattern, rule] of Object.entries(policy.protected ?? {})) {
      if (matchSubject(pattern, subject) && !rolesAllow(policy, protectedRoles(rule), principal)) {
        throw new HubError(403, `subject ${subject} is protected; requires role ${protectedRoles(rule).join(' or ')}`);
      }
    }
  }
}

/**
 * A repository with a publish policy is not readable through the ordinary
 * team pull: a caller scoped elsewhere (or unscoped) could otherwise bypass
 * `to_repos` and receive denied subjects. Owners and maintainers keep full
 * access; everyone else must use the filtered external endpoint.
 */
export async function assertPullAuthorized(
  client: Client,
  repoId: string,
  principal: HubPrincipal,
): Promise<void> {
  if (principal.role === 'maintainer' || principal.repoId === repoId) return;
  const state = await repoState(client, repoId);
  if (!state.policy?.publish) return;
  throw new HubError(403, `repository ${repoId} publishes only through the external endpoint`);
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
    const purgedClaims = new Set(
      (bundle.purge_audits ?? []).map((row) => String(row.claim_id ?? '')).filter(Boolean),
    );
    // A purge is the strongest tombstone: the claim row and everything keyed to
    // it must disappear in this transaction, or a fresh pull would replay a
    // fact the owner deleted. Mirrors the SQLite importer's purge sweep.
    if (purgedClaims.size > 0) {
      const ids = [...purgedClaims];
      await client.query('DELETE FROM repo_evidence WHERE repo_id = $1 AND claim_id = ANY($2::text[])', [repoId, ids]);
      await client.query('DELETE FROM repo_commit_entries WHERE repo_id = $1 AND claim_id = ANY($2::text[])', [
        repoId,
        ids,
      ]);
      await client.query(
        'DELETE FROM repo_attestations WHERE repo_id = $1 AND (claim_id = ANY($2::text[]) OR attestation_claim_id = ANY($2::text[]))',
        [repoId, ids],
      );
      await client.query(
        "DELETE FROM repo_conflicts WHERE repo_id = $1 AND (payload->>'left_claim' = ANY($2::text[]) OR payload->>'right_claim' = ANY($2::text[]))",
        [repoId, ids],
      );
      await client.query('DELETE FROM repo_claims WHERE repo_id = $1 AND id = ANY($2::text[])', [repoId, ids]);
    }
    // Quorum counts reviewer tokens, not client-authored actor strings: only a
    // maintainer or auditor submission may create a row that counts, and the
    // row records which token submitted it.
    const submitsReview = principal.role === 'maintainer' || principal.role === 'auditor';
    for (const row of bundle.attestations ?? []) {
      if (!submitsReview) continue;
      const claimId = String(row.claim_id ?? '');
      const attestationClaimId = String(row.attestation_claim_id ?? '');
      if (!claimId || !attestationClaimId) continue;
      // A purged claim must not acquire new review records.
      if (purgedClaims.has(claimId) || purgedClaims.has(attestationClaimId)) continue;
      await upsert(
        'repo_attestations',
        ['repo_id', 'claim_id', 'attestation_claim_id', 'pushed_by', 'pushed_role', 'payload'],
        'repo_id, claim_id, attestation_claim_id',
        [repoId, claimId, attestationClaimId, principal.sub, principal.role, row],
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
    // Quorum is a second gate on protected subjects and applies to every role:
    // it is the control that makes N-of-M review independent of rank. Claims
    // arriving retracted or purged need no quorum; they remove rather than assert.
    if (policy?.protected) {
      const checked = new Set<string>();
      for (const claim of bundle.claims ?? []) {
        const id = String(claim.id ?? '');
        const subject = String(claim.subject_id ?? '');
        if (!id || !subject || claim.state === 'retracted' || checked.has(id)) continue;
        if (purgedClaims.has(id)) continue;
        checked.add(id);
        const required = quorumFor(policy, subject);
        if (required <= 0) continue;
        const { rows: tally } = await client.query(
          `SELECT COUNT(DISTINCT a.pushed_by) AS n
             FROM repo_attestations a
             JOIN repo_claims c ON c.repo_id = a.repo_id AND c.id = a.attestation_claim_id
            WHERE a.repo_id = $1 AND a.claim_id = $2
              AND a.payload->>'verdict' = 'agree'
              AND a.pushed_role IN ('maintainer', 'auditor')
              AND a.pushed_by <> ''
              AND a.pushed_by <> COALESCE($3, '')`,
          [repoId, id, String(claim.author ?? '')],
        );
        const found = Number(tally[0]?.n ?? 0);
        if (found < required) {
          throw new HubError(
            403,
            `claim ${id} on protected subject ${subject} needs ${required} independent attestation(s); found ${found}`,
          );
        }
      }
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

export type ProposalStatus = 'open' | 'approved' | 'rejected' | 'promoted';

export interface ProposalMeta {
  user: string;
  session: string;
  ref: string;
  base_main: string | null;
  tip: string | null;
  status: ProposalStatus;
  note: string | null;
  claims: number;
  commits: number;
  created_at: string;
  updated_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  promoted_main: string | null;
}

/** The remote ref a proposal publishes: `refs/proposals/<user>/<session>`. */
export function proposalRef(user: string, session: string): string {
  return `refs/proposals/${user}/${session}`;
}

function proposalMeta(row: Record<string, unknown>): ProposalMeta {
  return {
    user: String(row.user_id),
    session: String(row.session),
    ref: String(row.ref),
    base_main: (row.base_main as string | null) ?? null,
    tip: (row.tip_commit as string | null) ?? null,
    status: row.status as ProposalStatus,
    note: (row.note as string | null) ?? null,
    claims: Number(row.claims ?? 0),
    commits: Number(row.commits ?? 0),
    created_at: new Date(row.created_at as string | Date).toISOString(),
    updated_at: new Date(row.updated_at as string | Date).toISOString(),
    reviewed_by: (row.reviewed_by as string | null) ?? null,
    reviewed_at: row.reviewed_at ? new Date(row.reviewed_at as string | Date).toISOString() : null,
    promoted_main: (row.promoted_main as string | null) ?? null,
  };
}

const PROPOSAL_COLUMNS = `user_id, session, ref, base_main, tip_commit, status, note,
  created_at, updated_at, reviewed_by, reviewed_at, promoted_main,
  jsonb_array_length(COALESCE(payload->'claims', '[]'::jsonb)) AS claims,
  jsonb_array_length(COALESCE(payload->'commits', '[]'::jsonb)) AS commits`;

function assertMaintainer(principal: HubPrincipal, action: string): void {
  if (principal.role !== 'maintainer') throw new HubError(403, `${action} requires a maintainer token`);
}

/**
 * Publish a contributor proposal. Proposals live outside the shared commit
 * graph: they are not visible to pulls and cannot touch main until a maintainer
 * promotes one. `write:`/`protected:` are therefore not applied here; they are
 * enforced when the promoted bundle is pushed.
 */
export async function saveProposal(
  client: Client,
  input: {
    repoId: string;
    principal: HubPrincipal;
    session: string;
    baseMain: string | null;
    bundle: Bundle;
    note?: string | null;
  },
): Promise<ProposalMeta> {
  const { repoId, principal, session } = input;
  if (!session || !/^[A-Za-z0-9._@:-]{1,120}$/.test(session)) throw new HubError(400, 'session has invalid characters');
  const user = principal.sub;
  if (!input.bundle || typeof input.bundle !== 'object') throw new HubError(400, 'bundle is required');
  if (input.bundle.repo_id !== repoId) {
    throw new HubError(400, `bundle belongs to repository ${input.bundle.repo_id}`);
  }
  if ((input.bundle.refs ?? []).some((ref) => ref.name === 'main')) {
    throw new HubError(403, 'a proposal cannot contain main; use lore push for a direct promotion');
  }
  const bundle: Bundle = {
    ...input.bundle,
    // A proposal may propose memory; it may not delete or revoke shared state.
    redactions: [],
    purge_audits: [],
    token_revocations: [],
    conflicts: [],
  };
  const tip = bundle.refs[0]?.commit_id ?? null;
  const { rows } = await client.query(
    `INSERT INTO repo_proposals(repo_id, user_id, session, ref, base_main, tip_commit, status, payload, note)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8)
     ON CONFLICT (repo_id, user_id, session) DO UPDATE
       SET ref = excluded.ref, base_main = excluded.base_main, tip_commit = excluded.tip_commit,
           payload = excluded.payload, note = excluded.note, status = 'open',
           reviewed_by = NULL, reviewed_at = NULL, promoted_main = NULL, promoted_at = NULL,
           updated_at = now(), seq = nextval('hub_seq')
       WHERE repo_proposals.status <> 'promoted'
     RETURNING ${PROPOSAL_COLUMNS}`,
    [repoId, user, session, proposalRef(user, session), input.baseMain, tip, bundle, input.note ?? null],
  );
  if (!rows[0]) throw new HubError(409, 'this proposal was already promoted; use a new session to propose again');
  return proposalMeta(rows[0] as Record<string, unknown>);
}

export async function listProposals(client: Client, repoId: string): Promise<ProposalMeta[]> {
  const { rows } = await client.query(
    `SELECT ${PROPOSAL_COLUMNS} FROM repo_proposals WHERE repo_id = $1 ORDER BY updated_at DESC`,
    [repoId],
  );
  return (rows as Array<Record<string, unknown>>).map(proposalMeta);
}

export async function getProposal(
  client: Client,
  repoId: string,
  user: string,
  session: string,
): Promise<{ proposal: ProposalMeta; bundle: Bundle }> {
  const { rows } = await client.query(
    `SELECT ${PROPOSAL_COLUMNS}, payload FROM repo_proposals WHERE repo_id = $1 AND user_id = $2 AND session = $3`,
    [repoId, user, session],
  );
  if (!rows[0]) throw new HubError(404, `no proposal ${user}/${session}`);
  const row = rows[0] as Record<string, unknown>;
  return { proposal: proposalMeta(row), bundle: row.payload as Bundle };
}

/** Approve or reject a proposal. Approval is a review decision, not a merge. */
export async function reviewProposal(
  client: Client,
  input: {
    repoId: string;
    principal: HubPrincipal;
    user: string;
    session: string;
    action: 'approve' | 'reject';
    note?: string | null;
  },
): Promise<ProposalMeta> {
  assertMaintainer(input.principal, 'reviewing a proposal');
  const { rows } = await client.query(
    `SELECT ${PROPOSAL_COLUMNS}, payload FROM repo_proposals WHERE repo_id = $1 AND user_id = $2 AND session = $3`,
    [input.repoId, input.user, input.session],
  );
  if (!rows[0]) throw new HubError(404, `no proposal ${input.user}/${input.session}`);
  const current = proposalMeta(rows[0] as Record<string, unknown>);
  if (current.status === 'promoted') throw new HubError(409, 'proposal was already promoted');
  const target = input.action === 'approve' ? 'approved' : 'rejected';
  if (current.status === target) throw new HubError(409, `proposal is already ${target}`);
  // Optimistic concurrency: a republish replaces the payload and resets the
  // status. Without this guard a review could approve a version it never saw.
  const updated = await client.query(
    `UPDATE repo_proposals
        SET status = $4, reviewed_by = $5, reviewed_at = now(), note = COALESCE($6, note),
            updated_at = now(), seq = nextval('hub_seq')
      WHERE repo_id = $1 AND user_id = $2 AND session = $3
        AND status = $7 AND payload = $8
      RETURNING ${PROPOSAL_COLUMNS}`,
    [
      input.repoId,
      input.user,
      input.session,
      target,
      input.principal.sub,
      input.note ?? null,
      current.status,
      (rows[0] as Record<string, unknown>).payload,
    ],
  );
  if (!updated.rows[0]) {
    throw new HubError(409, 'proposal changed while it was being reviewed; list it and review again');
  }
  return proposalMeta(updated.rows[0] as Record<string, unknown>);
}

type CommitNode = { parent: string | null; merge: string | null };

/** Commit graph from the shared repository plus commits only the proposal carries. */
async function commitGraph(
  client: Client,
  repoId: string,
  extra: Array<Record<string, unknown>>,
): Promise<Map<string, CommitNode>> {
  const { rows } = await client.query('SELECT payload FROM repo_commits WHERE repo_id = $1', [repoId]);
  const graph = new Map<string, CommitNode>();
  for (const row of rows as Array<{ payload: Record<string, unknown> }>) {
    const payload = row.payload;
    graph.set(String(payload.id), {
      parent: (payload.parent_id as string | null) ?? null,
      merge: (payload.merge_parent_id as string | null) ?? null,
    });
  }
  for (const payload of extra) {
    const id = String(payload.id ?? '');
    if (!id) continue;
    graph.set(id, {
      parent: (payload.parent_id as string | null) ?? null,
      merge: (payload.merge_parent_id as string | null) ?? null,
    });
  }
  return graph;
}

function graphIsAncestor(graph: Map<string, CommitNode>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = graph.get(id);
    if (!node) continue;
    if (node.parent === ancestor || node.merge === ancestor) return true;
    if (node.parent) queue.push(node.parent);
    if (node.merge) queue.push(node.merge);
  }
  return false;
}

/**
 * Promote an approved proposal into main. The merge itself happened on the
 * maintainer's client, so this verifies the submitted main descends from both
 * the proposal tip and the current main, checks that every proposed draft was
 * approved, then reuses the normal CAS push path (policy and quorum included).
 */
export async function promoteProposal(
  client: Client,
  input: {
    repoId: string;
    principal: HubPrincipal;
    user: string;
    session: string;
    expectedMain: string | null;
    bundle: Bundle;
    policy?: string | null;
  },
): Promise<{ main: string | null; seq: number; auth_seq: number; proposal: ProposalMeta }> {
  assertMaintainer(input.principal, 'promoting a proposal');
  const { rows } = await client.query(
    `SELECT ${PROPOSAL_COLUMNS}, payload FROM repo_proposals WHERE repo_id = $1 AND user_id = $2 AND session = $3`,
    [input.repoId, input.user, input.session],
  );
  if (!rows[0]) throw new HubError(404, `no proposal ${input.user}/${input.session}`);
  const row = rows[0] as Record<string, unknown>;
  const proposal = proposalMeta(row);
  if (proposal.status !== 'approved') {
    throw new HubError(409, `proposal is ${proposal.status}; approve it before promoting`);
  }

  const state = await repoState(client, input.repoId);
  if ((state.main ?? null) !== (input.expectedMain ?? null)) {
    throw new HubError(409, 'remote main moved; pull and retry');
  }
  const newMain = input.bundle.refs.find((ref) => ref.name === 'main')?.commit_id ?? null;
  if (!newMain || newMain === state.main) {
    throw new HubError(400, 'promotion bundle must advance main');
  }

  const graph = await commitGraph(client, input.repoId, input.bundle.commits ?? []);
  if (state.main && !graphIsAncestor(graph, state.main, newMain)) {
    throw new HubError(409, 'promotion does not build on the current main; pull and retry');
  }
  if (proposal.tip && !graphIsAncestor(graph, proposal.tip, newMain)) {
    throw new HubError(409, 'promotion does not contain the proposal tip; pull and retry');
  }

  const proposalBundle = row.payload as Bundle;
  const incomingClaims = new Map(
    (input.bundle.claims ?? []).map((claim) => [String(claim.id ?? ''), claim] as const),
  );
  const draftIds = (proposalBundle.claims ?? [])
    .filter((claim) => claim.state === 'draft')
    .map((claim) => String(claim.id ?? ''))
    .filter(Boolean);
  if (draftIds.length) {
    const { rows: stored } = await client.query(
      'SELECT id, payload FROM repo_claims WHERE repo_id = $1 AND id = ANY($2::text[])',
      [input.repoId, draftIds],
    );
    const storedClaims = new Map<string, Record<string, unknown>>();
    for (const claim of stored as Array<{ id: string; payload: Record<string, unknown> }>) {
      storedClaims.set(claim.id, claim.payload);
    }
    for (const id of draftIds) {
      const effective = incomingClaims.get(id) ?? storedClaims.get(id);
      if (effective && effective.state === 'draft') {
        throw new HubError(403, `proposal draft ${id} was not approved; approve it with lore approve before promoting`);
      }
    }
  }

  const result = await push(client, {
    repoId: input.repoId,
    bundle: input.bundle,
    expectedMain: input.expectedMain,
    principal: input.principal,
    policy: input.policy ?? null,
  });

  const updated = await client.query(
    `UPDATE repo_proposals
        SET status = 'promoted', promoted_main = $4, promoted_at = now(), updated_at = now(),
            reviewed_by = COALESCE(reviewed_by, $5), reviewed_at = COALESCE(reviewed_at, now()),
            seq = nextval('hub_seq')
      WHERE repo_id = $1 AND user_id = $2 AND session = $3
      RETURNING ${PROPOSAL_COLUMNS}`,
    [input.repoId, input.user, input.session, result.main, input.principal.sub],
  );
  return { ...result, proposal: proposalMeta(updated.rows[0] as Record<string, unknown>) };
}
