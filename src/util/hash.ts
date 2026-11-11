import { createHash } from 'node:crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function shortHash(h: string): string {
  return h.replace(/^sha256:/, '').slice(0, 8);
}

/** Deterministic JSON: sorted keys, no whitespace. Enough for hashing stability. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export interface ClaimHashInput {
  subject: string;
  predicate: string;
  object: string;
  valid_from?: string | null;
}

/**
 * Content-addressed claim id.
 * tx_from / evidence / confidence are intentionally excluded: two agents
 * observing the same fact must produce the same id.
 */
export function claimId(c: ClaimHashInput): string {
  const canonical = {
    object: c.object,
    predicate: c.predicate,
    subject: c.subject,
    valid_from: c.valid_from ?? null,
  };
  return `c_${sha256(stableStringify(canonical)).slice(0, 32)}`;
}

/** Order-independent, but keeps the op: a draft and an active snapshot must not collide. */
export function treeHash(entries: Iterable<{ claim_id: string; op: string }>): string {
  const items = [...entries].map((e) => `${e.claim_id}:${e.op}`).sort();
  return `sha256:${sha256(items.join('\n'))}`;
}
