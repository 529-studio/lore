import type { DB } from '../db.js';
import { activeAtAsOf, head, type ClaimRow, type Trust } from '../model.js';
import { branchFor, currentSession } from '../session.js';

export interface BiTemporalRange {
  from?: string | number;
  to?: string | number;
}

export interface BiTemporalQuery {
  subject?: string;
  predicate?: string;
  validAt?: string | number;
  txAt?: string | number;
  validRange?: BiTemporalRange;
  txRange?: BiTemporalRange;
  branch?: string;
  includeStale?: boolean;
}

export interface TimelineEntry {
  claimId: string;
  subject: string;
  predicate: string;
  object: unknown;
  validFrom: string | null;
  validTo: string | null;
  txFrom: string;
  txTo: string | null;
  state: string;
  trust: Trust;
  author: string;
  supersedes: string | null;
  supersededBy: string | null;
  commitId: string | null;
  commitTs: string | null;
}

export interface TimelineResult {
  subject: string;
  predicate: string | null;
  entries: TimelineEntry[];
}

export function parseTemporalInstant(value: string | number | undefined, label: string): number {
  if (value === undefined) return Date.now();
  if (typeof value === 'number') return value;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`${label}: not a valid ISO date: ${value}`);
  }
  return ms;
}

export function isInValidTime(
  claim: { valid_from: string | null; valid_to: string | null },
  instantOrRange: number | BiTemporalRange,
): boolean {
  const vFrom = claim.valid_from ? Date.parse(claim.valid_from) : Number.NEGATIVE_INFINITY;
  const vTo = claim.valid_to ? Date.parse(claim.valid_to) : Number.POSITIVE_INFINITY;

  if (typeof instantOrRange === 'number') {
    return vFrom <= instantOrRange && instantOrRange < vTo;
  }

  const rangeStart =
    instantOrRange.from !== undefined
      ? parseTemporalInstant(instantOrRange.from, 'validRange.from')
      : Number.NEGATIVE_INFINITY;
  const rangeEnd =
    instantOrRange.to !== undefined
      ? parseTemporalInstant(instantOrRange.to, 'validRange.to')
      : Number.POSITIVE_INFINITY;

  return Math.max(vFrom, rangeStart) < Math.min(vTo, rangeEnd);
}

export function isInTxTime(
  txFromStr: string,
  txToStr: string | null,
  instantOrRange: number | BiTemporalRange,
): boolean {
  const tFrom = Date.parse(txFromStr);
  const tTo = txToStr ? Date.parse(txToStr) : Number.POSITIVE_INFINITY;

  if (typeof instantOrRange === 'number') {
    return tFrom <= instantOrRange && instantOrRange < tTo;
  }

  const rangeStart =
    instantOrRange.from !== undefined
      ? parseTemporalInstant(instantOrRange.from, 'txRange.from')
      : Number.NEGATIVE_INFINITY;
  const rangeEnd =
    instantOrRange.to !== undefined
      ? parseTemporalInstant(instantOrRange.to, 'txRange.to')
      : Number.POSITIVE_INFINITY;

  return Math.max(tFrom, rangeStart) < Math.min(tTo, rangeEnd);
}

/**
 * Executes a bi-temporal query across valid-time and transaction-time.
 */
export function queryBiTemporal(
  db: DB,
  root: string,
  query: BiTemporalQuery = {},
): ClaimRow[] {
  const session = currentSession(root);
  const branchName = query.branch ?? branchFor(session);
  const headTip = head(db, branchName) ?? head(db, 'main');

  const txInstantMs =
    query.txAt !== undefined
      ? parseTemporalInstant(query.txAt, 'txAt')
      : Date.now();

  const validInstantMs =
    query.validAt !== undefined
      ? parseTemporalInstant(query.validAt, 'validAt')
      : Date.now();

  // Active claim set at the transaction-time instant
  const activeMap = activeAtAsOf(db, headTip, txInstantMs);
  const activeIds = [...activeMap.keys()];
  if (!activeIds.length) return [];

  const claims: ClaimRow[] = [];
  const stmt = db.prepare('SELECT * FROM claim WHERE id = ?');

  for (const id of activeIds) {
    const row = stmt.get(id) as ClaimRow | undefined;
    if (!row) continue;

    if (query.subject && row.subject_id !== query.subject) continue;
    if (query.predicate && row.predicate !== query.predicate) continue;

    // Filter by valid time
    if (query.validRange) {
      if (!isInValidTime(row, query.validRange)) continue;
    } else {
      if (!isInValidTime(row, validInstantMs)) continue;
    }

    // Filter by transaction time range if specified
    if (query.txRange) {
      if (!isInTxTime(row.tx_from, null, query.txRange)) continue;
    }

    // Trust filtering
    const trustOk =
      row.trust === 'canonical' || (query.includeStale && row.trust === 'stale');
    if (!trustOk) continue;

    claims.push(row);
  }

  return claims;
}

/**
 * Reconstructs the 2D bi-temporal timeline of an entity (or specific predicate).
 */
export function reconstructTimeline(
  db: DB,
  subjectId: string,
  predicate?: string,
): TimelineResult {
  let sql = 'SELECT * FROM claim WHERE subject_id = ?';
  const params: unknown[] = [subjectId];
  if (predicate) {
    sql += ' AND predicate = ?';
    params.push(predicate);
  }
  sql += ' ORDER BY tx_from ASC, rowid ASC';

  const rows = db.prepare(sql).all(...params) as ClaimRow[];
  const entries: TimelineEntry[] = [];

  const supersedingStmt = db.prepare(
    'SELECT id, tx_from FROM claim WHERE supersedes = ? ORDER BY tx_from ASC LIMIT 1',
  );

  const commitEntryStmt = db.prepare(`
    SELECT c.id, c.ts, e.op
    FROM commit_entry e
    JOIN memory_commit c ON c.id = e.commit_id
    WHERE e.claim_id = ?
    ORDER BY c.ts ASC
  `);

  for (const row of rows) {
    const ops = commitEntryStmt.all(row.id) as Array<{ id: string; ts: string; op: string }>;
    const addCommit = ops.find((o) => o.op === 'add');
    const endOp = ops.find((o) => o.op === 'supersede' || o.op === 'retract');

    const nextClaim = supersedingStmt.get(row.id) as { id: string; tx_from: string } | undefined;
    const supersededBy = nextClaim?.id ?? null;

    // Transaction-time end: determined by explicit end commit, superseding claim tx_from, or null (still active)
    let txTo: string | null = null;
    if (endOp) {
      txTo = endOp.ts;
    } else if (nextClaim) {
      txTo = nextClaim.tx_from;
    } else if (row.state === 'retracted') {
      txTo = row.tx_from;
    }

    let parsedObject: unknown = row.object_json;
    try {
      parsedObject = JSON.parse(row.object_json);
    } catch {
      // Keep as string if not JSON
    }

    entries.push({
      claimId: row.id,
      subject: row.subject_id,
      predicate: row.predicate,
      object: parsedObject,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      txFrom: row.tx_from,
      txTo,
      state: row.state,
      trust: row.trust,
      author: row.author,
      supersedes: row.supersedes,
      supersededBy,
      commitId: addCommit?.id ?? null,
      commitTs: addCommit?.ts ?? null,
    });
  }

  return {
    subject: subjectId,
    predicate: predicate ?? null,
    entries,
  };
}
