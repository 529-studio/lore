// Security scrub and zero-knowledge claim attestations — SPEC §6, §15.
// Ensures no raw secrets, API keys, credentials or connection strings are persisted in SQLite,
// and provides offline verifiable zero-knowledge attestations (salted SHA-256 commitments).

import crypto from 'node:crypto';
import { SecretFinding, mask, scanText as baseScanText } from '../secrets.js';

export interface ScrubResult {
  text: string;
  scrubbed: boolean;
  count: number;
  findings: SecretFinding[];
}

export interface ScrubbedFields {
  subject: string;
  predicate: string;
  object: string;
  scrubbed: boolean;
  count: number;
  findings: SecretFinding[];
}

const EXTRA_SECRET_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  {
    kind: 'connection-string',
    re: /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp|mssql):\/\/[^\s'"]*:[^\s'"]*@[^\s'"]+\b/gi,
  },
  {
    kind: 'bearer-token',
    re: /\bBearer\s+[A-Za-z0-9_\-\.]{20,}\b/gi,
  },
];

/**
 * Enhanced secret scanner that includes base secrets plus connection strings and extended API tokens.
 */
export function scanSecurityText(text: string): SecretFinding[] {
  const base = baseScanText(text);
  const seen = new Set<string>(base.map((f) => `${f.kind}:${f.match}`));
  const additional: SecretFinding[] = [];

  for (const { kind, re } of EXTRA_SECRET_PATTERNS) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      const value = match[0];
      const key = `${kind}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      additional.push({
        kind,
        match: value,
        masked: mask(value),
        index: match.index ?? 0,
      });
    }
  }

  return [...base, ...additional].sort((a, b) => a.index - b.index);
}

/**
 * Redacts secrets from text by replacing each match with a safe placeholder.
 */
export function scrubText(
  input: string,
  placeholderFn: (finding: SecretFinding) => string = (f) => `[REDACTED:${f.kind}]`,
): ScrubResult {
  const findings = scanSecurityText(input);
  if (!findings.length) {
    return { text: input, scrubbed: false, count: 0, findings: [] };
  }

  let result = '';
  let cursor = 0;

  for (const finding of findings) {
    // If overlapping previous match, skip
    if (finding.index < cursor) continue;
    result += input.slice(cursor, finding.index);
    result += placeholderFn(finding);
    cursor = finding.index + finding.match.length;
  }
  result += input.slice(cursor);

  return {
    text: result,
    scrubbed: true,
    count: findings.length,
    findings,
  };
}

/**
 * Scrub all write fields (subject, predicate, object) before persistence.
 */
export function scrubClaimFields(fields: {
  subject: string;
  predicate: string;
  object: string;
}): ScrubbedFields {
  const sRes = scrubText(fields.subject);
  const pRes = scrubText(fields.predicate);
  const oRes = scrubText(fields.object);

  const totalCount = sRes.count + pRes.count + oRes.count;
  const allFindings = [...sRes.findings, ...pRes.findings, ...oRes.findings];

  return {
    subject: sRes.text,
    predicate: pRes.text,
    object: oRes.text,
    scrubbed: totalCount > 0,
    count: totalCount,
    findings: allFindings,
  };
}

// --- Zero-Knowledge Attestation Protocol ----------------------------------------

export interface ZkProof {
  version: 1;
  claimId: string;
  verdict: 'agree' | 'disagree';
  actor: string;
  commitment: string;
  salt: string;
  algorithm: 'sha256-salted';
  timestamp: string;
  reason?: string;
}

/**
 * Canonicalizes an object string for consistent hashing.
 */
export function canonicalizeClaimObject(rawObject: string): string {
  try {
    const parsed = JSON.parse(rawObject);
    if (parsed !== null && typeof parsed === 'object') {
      const keys = Object.keys(parsed).sort();
      const sortedObj: Record<string, unknown> = {};
      for (const k of keys) sortedObj[k] = parsed[k];
      return JSON.stringify(sortedObj);
    }
  } catch {
    // fallback to trimmed raw string
  }
  return rawObject.trim();
}

/**
 * Compute the zero-knowledge commitment hash:
 * H(claimId || ":" || canonicalObject || ":" || salt)
 */
export function computeZkCommitment(claimId: string, canonicalObject: string, salt: string): string {
  return crypto
    .createHash('sha256')
    .update(`${claimId}:${canonicalObject}:${salt}`)
    .digest('hex');
}

/**
 * Creates a zero-knowledge attestation proof for a claim.
 */
export function createZkProof(
  claim: { id: string; object: string },
  opts: {
    verdict: 'agree' | 'disagree';
    actor: string;
    salt?: string;
    reason?: string;
  },
): ZkProof {
  const salt = opts.salt ?? crypto.randomBytes(16).toString('hex');
  const canonicalObj = canonicalizeClaimObject(claim.object);
  const commitment = computeZkCommitment(claim.id, canonicalObj, salt);

  return {
    version: 1,
    claimId: claim.id,
    verdict: opts.verdict,
    actor: opts.actor,
    commitment,
    salt,
    algorithm: 'sha256-salted',
    timestamp: new Date().toISOString(),
    ...(opts.reason ? { reason: opts.reason } : {}),
  };
}

/**
 * Verifies a zero-knowledge attestation proof against a claim.
 * Offline-verifiable: ensures proof commitment matches the claim's content without needing online state.
 */
export function verifyZkProof(
  claim: { id: string; object: string },
  proof: ZkProof,
): { valid: boolean; reason?: string } {
  if (proof.version !== 1) {
    return { valid: false, reason: `unsupported proof version: ${proof.version}` };
  }
  if (proof.claimId !== claim.id) {
    return { valid: false, reason: `claimId mismatch: proof is for ${proof.claimId}, claim is ${claim.id}` };
  }
  if (proof.algorithm !== 'sha256-salted') {
    return { valid: false, reason: `unsupported proof algorithm: ${proof.algorithm}` };
  }

  const canonicalObj = canonicalizeClaimObject(claim.object);
  const expectedCommitment = computeZkCommitment(claim.id, canonicalObj, proof.salt);

  if (expectedCommitment !== proof.commitment) {
    return { valid: false, reason: 'commitment mismatch: object content does not match zero-knowledge proof' };
  }

  return { valid: true };
}
