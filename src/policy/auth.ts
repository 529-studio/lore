import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { openDb } from '../db.js';
import { resolvePrincipal, teamMode, verifyToken, type Principal, type Role } from '../identity.js';

export type Action =
  | 'approve'
  | 'resolve'
  | 'redact'
  | 'purge'
  | 'promote'
  | 'attest'
  | 'revert'
  | 'write'
  | 'read'
  | 'admin';

/** A policy denial, mapped to 403 by the dashboard instead of a generic 500. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export interface TokenRevocationRecord {
  jti: string;
  sub: string;
  reason?: string;
  revoked_by: string;
  revoked_at: string;
}

export type ProtectedRule = string[] | { roles?: string[]; min_attestations?: number };

/** A protected entry may be a role list (legacy) or a rule object with a quorum. */
export function protectedRoles(rule: ProtectedRule): string[] {
  if (Array.isArray(rule)) return rule;
  return Array.isArray(rule.roles) ? rule.roles : ['maintainers'];
}

export function protectedQuorum(rule: ProtectedRule): number {
  if (Array.isArray(rule)) return 0;
  const value = Number(rule.min_attestations ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The strictest matching quorum for a subject; 0 when no rule asks for one. */
export function quorumFor(policy: GranularPolicyFile | null, subject: string): number {
  if (!policy?.protected) return 0;
  let quorum = 0;
  for (const [pattern, rule] of Object.entries(policy.protected)) {
    if (matchSubject(pattern, subject)) quorum = Math.max(quorum, protectedQuorum(rule));
  }
  return quorum;
}

export interface GranularPolicyFile {
  roles?: Record<string, string[]>;
  approve?: Record<string, string[]>;
  resolve?: string[] | Record<string, string[]>;
  redact?: string[];
  purge?: string[];
  promote?: string[];
  attest?: string[];
  revert?: string[];
  write?: Record<string, string[]>;
  read?: Record<string, string[]>;
  admin?: string[];
  protected?: Record<string, ProtectedRule>;
}

export function policyPath(root: string): string {
  return path.join(root, 'lore.policy.yml');
}

export function loadGranularPolicy(root: string): GranularPolicyFile | null {
  const file = policyPath(root);
  if (!existsSync(file)) return null;
  try {
    return parse(readFileSync(file, 'utf8')) as GranularPolicyFile;
  } catch {
    return null;
  }
}

export function revokeToken(
  root: string,
  identifier: string,
  opts: { reason?: string; revokedBy?: string } = {},
): TokenRevocationRecord {
  const db = openDb(root);
  let jti = identifier.trim();
  let sub = identifier.trim();

  // If identifier is a full signed JWT token, parse payload to extract jti and sub
  if (identifier.includes('.')) {
    try {
      const secret = process.env.LORE_TEAM_SECRET;
      if (secret) {
        const payload = verifyToken(identifier, secret);
        jti = payload.jti ?? identifier;
        sub = payload.sub;
      } else {
        const [encoded] = identifier.split('.');
        const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        jti = payload.jti ?? identifier;
        sub = payload.sub ?? identifier;
      }
    } catch {
      // Treat as raw identifier if token parsing fails
    }
  }

  const record: TokenRevocationRecord = {
    jti,
    sub,
    reason: opts.reason ?? 'administrative revocation',
    revoked_by: opts.revokedBy ?? 'admin',
    revoked_at: new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO token_revocation (jti, sub, reason, revoked_by, revoked_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(jti) DO UPDATE SET
      reason = excluded.reason,
      revoked_by = excluded.revoked_by,
      revoked_at = excluded.revoked_at
  `).run(record.jti, record.sub, record.reason, record.revoked_by, record.revoked_at);

  return record;
}

export function isTokenRevoked(
  root: string,
  target: { jti?: string; sub?: string },
): { revoked: boolean; record?: TokenRevocationRecord } {
  try {
    const db = openDb(root);
    if (target.jti) {
      const row = db.prepare(`SELECT * FROM token_revocation WHERE jti = ?`).get(target.jti) as TokenRevocationRecord | undefined;
      if (row) return { revoked: true, record: row };
    }
    if (target.sub) {
      const row = db.prepare(`SELECT * FROM token_revocation WHERE sub = ?`).get(target.sub) as TokenRevocationRecord | undefined;
      if (row) return { revoked: true, record: row };
    }
    return { revoked: false };
  } catch {
    return { revoked: false };
  }
}

export function listRevocations(root: string): TokenRevocationRecord[] {
  try {
    const db = openDb(root);
    return db.prepare(`SELECT * FROM token_revocation ORDER BY revoked_at DESC`).all() as TokenRevocationRecord[];
  } catch {
    return [];
  }
}

export function matchSubject(pattern: string, subject: string): boolean {
  if (pattern === '*' || pattern === subject) return true;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return subject.startsWith(prefix);
  }
  return false;
}

export function isMember(policy: GranularPolicyFile | null, role: string, principal: Principal): boolean {
  if (role === '*') return true;
  if (role === 'maintainers') return principal.role === 'maintainer';
  if (role === 'contributors') return true; // any authenticated identity
  if (role === 'machines') return principal.role === 'machine';
  if (role === 'auditors') return principal.role === 'auditor' || principal.role === 'maintainer';
  const members = policy?.roles?.[role];
  if (members?.includes('*')) return true;
  if (members?.includes(principal.id)) return true;
  return role === principal.role;
}

/**
 * Every protected rule that matches a subject is enforced. Broad patterns such
 * as `doc:*` must not shadow a stricter exact rule listed after them.
 */
function assertProtectedAllowed(
  principal: Principal,
  policy: GranularPolicyFile | null,
  subject: string | undefined,
  policyName: string,
): void {
  if (!policy?.protected || !subject) return;
  for (const [pattern, rule] of Object.entries(policy.protected)) {
    if (!matchSubject(pattern, subject)) continue;
    const roles = protectedRoles(rule);
    if (!roles.some((r) => isMember(policy, r, principal))) {
      throw new PolicyError(
        `subject ${subject} is protected; requires role ${roles.join(' or ')}; ${principal.id} is ${principal.role} (policy: ${policyName})`,
      );
    }
  }
}

/**
 * N-of-M review gate for a protected subject. Only distinct approvers whose
 * verdict is `agree` count, and never the claim's own author.
 */
function assertAttestationQuorum(
  root: string,
  principal: Principal,
  claimId: string,
  required: number,
): void {
  const db = openDb(root);
  const claim = db.prepare('SELECT author FROM claim WHERE id = ?').get(claimId) as { author: string } | undefined;
  if (!claim) throw new PolicyError(`no such claim: ${claimId}`);
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT a.actor) AS n FROM attestation a
         JOIN claim c ON c.id = a.attestation_claim_id
        WHERE a.claim_id = ? AND a.verdict = 'agree' AND a.actor <> ?`,
    )
    .get(claimId, claim.author) as { n: number };
  if (Number(row.n) < required) {
    throw new PolicyError(
      `claim ${claimId} needs ${required} independent attestation(s); found ${row.n} (attest with \`lore attest ${claimId} --verdict agree\` by another principal)`,
    );
  }
}

/** Resolve the caller and reject revoked tokens before any policy decision. */
function authorizePrincipal(root: string): Principal {
  const principal = resolvePrincipal(root);
  if (principal.source === 'token') {
    const revCheck = isTokenRevoked(root, { jti: principal.jti, sub: principal.id });
    if (revCheck.revoked) {
      throw new Error(`token has been revoked: ${revCheck.record?.reason ?? 'administrative revocation'}`);
    }
  }
  return principal;
}

function assertWriteAllowed(
  principal: Principal,
  policy: GranularPolicyFile | null,
  root: string,
  subject: string | undefined,
): void {
  if (!subject) return;
  const policyName = path.basename(policyPath(root));
  if (policy?.write) {
    for (const [pattern, roles] of Object.entries(policy.write)) {
      if (matchSubject(pattern, subject) && !roles.some((r) => isMember(policy, r, principal))) {
        throw new PolicyError(
          `write to ${subject} requires role ${roles.join(' or ')}; ${principal.id} is ${principal.role} (policy: ${policyName})`,
        );
      }
    }
  }
  assertProtectedAllowed(principal, policy, subject, policyName);
}

/**
 * Batch write check: resolves the principal and loads the policy once, then
 * verifies every unique subject. Used by bulk producers such as `lore ingest`
 * so a contributor cannot write a protected subject by extraction.
 */
export function requireWriteSubjects(root: string, subjects: Iterable<string>): Principal {
  const principal = authorizePrincipal(root);
  if (!teamMode(root)) return principal;
  const policy = loadGranularPolicy(root);
  for (const subject of new Set(subjects)) assertWriteAllowed(principal, policy, root, subject);
  return principal;
}

export function checkAuthorization(
  root: string,
  action: Action,
  ctx: { tier?: number; subject?: string; claimId?: string } = {},
): Principal {
  const principal = authorizePrincipal(root);

  // Machine approver rule: machines may only approve T0/T1 claims
  if (principal.role === 'machine' && action === 'approve' && (ctx.tier ?? 4) > 1) {
    throw new PolicyError('a machine approver may only approve T0/T1 evidence-backed claims');
  }

  if (!teamMode(root)) return principal;

  const policy = loadGranularPolicy(root);
  const policyName = path.basename(policyPath(root));

  // Admin action check (e.g. revoking tokens, configuring policies)
  if (action === 'admin') {
    const adminRoles = policy?.admin ?? ['maintainers'];
    if (adminRoles.some((r) => isMember(policy, r, principal))) return principal;
    throw new PolicyError(`admin requires role ${adminRoles.join(' or ')}; ${principal.id} is ${principal.role}`);
  }

  // Granular write authorization check
  if (action === 'write') {
    assertWriteAllowed(principal, policy, root, ctx.subject);
    return principal;
  }

  // Lifecycle action: approve. Protected access is an additional gate, not an
  // alternative to the tier rule.
  if (action === 'approve') {
    assertProtectedAllowed(principal, policy, ctx.subject, policyName);
    const quorum = ctx.subject ? quorumFor(policy, ctx.subject) : 0;
    if (quorum > 0) {
      if (!ctx.claimId) {
        // A quorum is per claim and cannot be guessed for a bulk action.
        throw new PolicyError(
          `subject ${ctx.subject} requires ${quorum} independent attestation(s); approve one claim at a time`,
        );
      }
      assertAttestationQuorum(root, principal, ctx.claimId, quorum);
    }
    const key = `t${ctx.tier ?? 4}`;
    const roles = policy?.approve?.[key] ?? policy?.approve?.t4 ?? ['maintainers'];
    if (roles.some((r) => isMember(policy, r, principal))) return principal;
    throw new PolicyError(
      `approve t${ctx.tier ?? 4} requires role ${roles.join(' or ')}; ${principal.id} is ${principal.role} (policy: ${policyName})`,
    );
  }

  // Lifecycle action: resolve
  if (action === 'resolve') {
    assertProtectedAllowed(principal, policy, ctx.subject, policyName);
    const roles = Array.isArray(policy?.resolve)
      ? policy.resolve
      : (policy?.resolve as Record<string, string[]> | undefined)?.['*'] ?? ['maintainers'];
    if (roles.some((r) => isMember(policy, r, principal))) return principal;
    throw new PolicyError(
      `resolve requires role ${roles.join(' or ')}; ${principal.id} is ${principal.role} (policy: ${policyName})`,
    );
  }

  // Other lifecycle actions: redact, purge, promote, attest, revert
  const direct = policy?.[action];
  const roles = Array.isArray(direct) ? direct : ['maintainers'];
  if (roles.some((r) => isMember(policy, r, principal))) return principal;

  throw new PolicyError(
    `${action} requires role ${roles.join(' or ')}; ${principal.id} is ${principal.role} (policy: ${policyName})`,
  );
}
