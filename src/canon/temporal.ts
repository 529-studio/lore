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

export interface RelativeTemporalResult {
  timestamp: number;
  iso: string;
  offsetMs: number;
  direction: 'past' | 'future' | 'now';
}

const UNIT_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  second: 1000,
  seconds: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 3600 * 1000,
  hr: 3600 * 1000,
  hour: 3600 * 1000,
  hours: 3600 * 1000,
  d: 86400 * 1000,
  day: 86400 * 1000,
  days: 86400 * 1000,
  w: 7 * 86400 * 1000,
  wk: 7 * 86400 * 1000,
  week: 7 * 86400 * 1000,
  weeks: 7 * 86400 * 1000,
  mo: 30 * 86400 * 1000,
  month: 30 * 86400 * 1000,
  months: 30 * 86400 * 1000,
  y: 365 * 86400 * 1000,
  yr: 365 * 86400 * 1000,
  year: 365 * 86400 * 1000,
  years: 365 * 86400 * 1000,
};

/**
 * Parses natural language relative temporal expressions into deterministic timestamps and ISO dates.
 * Supports keywords (now, today, yesterday, tomorrow, last week/month/year), verbose offsets ("3 days ago"),
 * future offsets ("in 2 hours"), and compact shorthands ("-3d", "+2h").
 */
export function parseRelativeTemporal(value: string, now: number = Date.now()): RelativeTemporalResult | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();

  // 1. Direct keywords
  if (trimmed === 'now' || trimmed === 'today') {
    return { timestamp: now, iso: new Date(now).toISOString(), offsetMs: 0, direction: 'now' };
  }
  if (trimmed === 'yesterday') {
    const offsetMs = 86400 * 1000;
    const ts = now - offsetMs;
    return { timestamp: ts, iso: new Date(ts).toISOString(), offsetMs, direction: 'past' };
  }
  if (trimmed === 'tomorrow') {
    const offsetMs = 86400 * 1000;
    const ts = now + offsetMs;
    return { timestamp: ts, iso: new Date(ts).toISOString(), offsetMs, direction: 'future' };
  }
  if (trimmed === 'last week') {
    const offsetMs = 7 * 86400 * 1000;
    const ts = now - offsetMs;
    return { timestamp: ts, iso: new Date(ts).toISOString(), offsetMs, direction: 'past' };
  }
  if (trimmed === 'last month') {
    const offsetMs = 30 * 86400 * 1000;
    const ts = now - offsetMs;
    return { timestamp: ts, iso: new Date(ts).toISOString(), offsetMs, direction: 'past' };
  }
  if (trimmed === 'last year') {
    const offsetMs = 365 * 86400 * 1000;
    const ts = now - offsetMs;
    return { timestamp: ts, iso: new Date(ts).toISOString(), offsetMs, direction: 'past' };
  }

  // 2. Verbose offset: "<N> <unit> ago"
  const agoMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)\s+ago$/);
  if (agoMatch) {
    const count = parseFloat(agoMatch[1]);
    const unit = agoMatch[2];
    const multiplier = UNIT_MS[unit];
    if (multiplier) {
      const offsetMs = Math.round(count * multiplier);
      const ts = now - offsetMs;
      return { timestamp: ts, iso: new Date(ts).toISOString(), offsetMs, direction: 'past' };
    }
  }

  // 3. Verbose future offset: "in <N> <unit>"
  const inMatch = trimmed.match(/^in\s+(\d+(?:\.\d+)?)\s*([a-z]+)$/);
  if (inMatch) {
    const count = parseFloat(inMatch[1]);
    const unit = inMatch[2];
    const multiplier = UNIT_MS[unit];
    if (multiplier) {
      const offsetMs = Math.round(count * multiplier);
      const ts = now + offsetMs;
      return { timestamp: ts, iso: new Date(ts).toISOString(), offsetMs, direction: 'future' };
    }
  }

  // 4. Shorthands: "-<N><unit>" or "+<N><unit>"
  const shorthandMatch = trimmed.match(/^([+-])\s*(\d+(?:\.\d+)?)\s*([a-z]+)$/);
  if (shorthandMatch) {
    const sign = shorthandMatch[1];
    const count = parseFloat(shorthandMatch[2]);
    const unit = shorthandMatch[3];
    const multiplier = UNIT_MS[unit];
    if (multiplier) {
      const offsetMs = Math.round(count * multiplier);
      const direction = sign === '-' ? 'past' : 'future';
      const ts = sign === '-' ? now - offsetMs : now + offsetMs;
      return { timestamp: ts, iso: new Date(ts).toISOString(), offsetMs, direction };
    }
  }

  return null;
}

export function parseTemporalInstant(value: string | number | undefined, label: string, now?: number): number {
  if (value === undefined) return now ?? Date.now();
  if (typeof value === 'number') return value;

  const rel = parseRelativeTemporal(value, now);
  if (rel) {
    return rel.timestamp;
  }

  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`${label}: not a valid ISO date or relative temporal expression: ${value}`);
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
 * Convenience helper for "as-of" queries:
 * Shorthand for querying both effective time and transaction time at the same instant.
 */
export function queryAsOf(
  db: DB,
  root: string,
  instant: string | number,
  query: Omit<BiTemporalQuery, 'validAt' | 'txAt'> = {},
): ClaimRow[] {
  return queryBiTemporal(db, root, {
    ...query,
    validAt: instant,
    txAt: instant,
  });
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
