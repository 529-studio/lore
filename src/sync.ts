import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import path from 'node:path';
import type { DB } from './db.js';
import { head, makeCommit, runClaimWriteHooks, type ClaimRow, type Trust } from './model.js';
import { planMerge } from './merge.js';
import { loadOntology } from './ontology.js';
import { readConfig } from './config.js';
import { scrubClaimAuditLog } from './security/scrub.js';
import { branchFor, currentSession } from './session.js';
import { loadPending, markResolutionsApplied } from './resolution.js';

export interface Bundle {
  format: 'lore-bundle/1';
  repo_id: string;
  created_at: string;
  refs: Array<{ name: string; commit_id: string }>;
  entities: Array<Record<string, unknown>>;
  claims: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  commits: Array<Record<string, unknown>>;
  entries: Array<Record<string, unknown>>;
  /** Tier-1 conflicts. Optional so bundles written before Canon still import. */
  conflicts?: Array<Record<string, unknown>>;
  /**
   * Data-safety tombstones. Optional for the same reason as `conflicts`: stores
   * and hubs written before this field existed must still import.
   */
  redactions?: Array<Record<string, unknown>>;
  purge_audits?: Array<Record<string, unknown>>;
  token_revocations?: Array<Record<string, unknown>>;
  attestations?: Array<Record<string, unknown>>;
}

export function bundleFile(remoteDir: string, repoId: string): string {
  return path.join(remoteDir, `${repoId}.lorebundle`);
}

const TRUST_RANK: Record<Trust, number> = {
  candidate: 1,
  canonical: 2,
  stale: 3,
  contested: 4,
  retracted: 5,
};

function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Two stores can legitimately disagree about trust. Retraction wins; otherwise
 * the newer verification wins; on a tie the more restrictive trust wins. This
 * keeps a conflict or a retraction from being silently undone by an import.
 */
function mergeTrust(
  local: { trust: Trust; last_verified_at: string | null; tx_from: string },
  remote: { trust: Trust; last_verified_at: string | null; tx_from: string },
): Trust {
  if (local.trust === 'retracted' || remote.trust === 'retracted') return 'retracted';
  const lt = Date.parse(local.last_verified_at ?? local.tx_from);
  const rt = Date.parse(remote.last_verified_at ?? remote.tx_from);
  if (Number.isFinite(lt) && Number.isFinite(rt) && lt !== rt) return lt > rt ? local.trust : remote.trust;
  return TRUST_RANK[remote.trust] > TRUST_RANK[local.trust] ? remote.trust : local.trust;
}

/** A bundle carries whole history; the store is text and small. */
export function buildBundle(db: DB, repoId: string, refNames = ['main']): Bundle {
  const refs: Bundle['refs'] = [];
  for (const name of refNames) {
    const tip = head(db, name);
    if (tip) refs.push({ name, commit_id: tip });
  }
  return {
    format: 'lore-bundle/1',
    repo_id: repoId,
    created_at: new Date().toISOString(),
    refs,
    entities: db.prepare('SELECT * FROM entity').all() as Array<Record<string, unknown>>,
    claims: db.prepare('SELECT * FROM claim ORDER BY tx_from ASC').all() as Array<Record<string, unknown>>,
    evidence: db.prepare('SELECT * FROM evidence').all() as Array<Record<string, unknown>>,
    commits: db.prepare('SELECT * FROM memory_commit ORDER BY ts ASC').all() as Array<Record<string, unknown>>,
    entries: db.prepare('SELECT * FROM commit_entry').all() as Array<Record<string, unknown>>,
    conflicts: db.prepare('SELECT * FROM claim_conflict ORDER BY id ASC').all() as Array<
      Record<string, unknown>
    >,
    redactions: db.prepare('SELECT * FROM redaction ORDER BY ts ASC').all() as Array<Record<string, unknown>>,
    purge_audits: db.prepare('SELECT * FROM purge_audit ORDER BY ts ASC').all() as Array<Record<string, unknown>>,
    token_revocations: db.prepare('SELECT * FROM token_revocation ORDER BY revoked_at ASC').all() as Array<
      Record<string, unknown>
    >,
    attestations: db.prepare('SELECT * FROM attestation ORDER BY ts ASC').all() as Array<
      Record<string, unknown>
    >,
  };
}

/**
 * A push delta relative to the server's main: commits the hub cannot already
 * have (not ancestors of `baseMain`) plus their entries, claims and evidence.
 * Tombstones and conflicts are small and always included. With no base (first
 * push) the whole store is sent.
 */
export function buildDeltaBundle(db: DB, repoId: string, baseMain: string | null, refNames = ['main']): Bundle {
  if (!baseMain) return buildBundle(db, repoId, refNames);
  const allCommits = db.prepare('SELECT * FROM memory_commit ORDER BY ts ASC').all() as Array<Record<string, unknown>>;
  const newCommits = allCommits.filter((row) => !isAncestor(db, String(row.id), baseMain));
  const commitIds = new Set(newCommits.map((row) => String(row.id)));
  const allEntries = db.prepare('SELECT * FROM commit_entry').all() as Array<Record<string, unknown>>;
  const entries = allEntries.filter((row) => commitIds.has(String(row.commit_id)));
  const claimIds = new Set(entries.map((row) => String(row.claim_id)));
  const allClaims = db.prepare('SELECT * FROM claim ORDER BY tx_from ASC').all() as Array<Record<string, unknown>>;
  const claims = allClaims.filter((row) => claimIds.has(String(row.id)));
  const allEvidence = db.prepare('SELECT * FROM evidence').all() as Array<Record<string, unknown>>;
  const evidence = allEvidence.filter((row) => claimIds.has(String(row.claim_id)));
  const refs: Bundle['refs'] = [];
  for (const name of refNames) {
    const tip = head(db, name);
    if (tip) refs.push({ name, commit_id: tip });
  }
  return {
    format: 'lore-bundle/1',
    repo_id: repoId,
    created_at: new Date().toISOString(),
    refs,
    entities: db.prepare('SELECT * FROM entity').all() as Array<Record<string, unknown>>,
    claims,
    evidence,
    commits: newCommits,
    entries,
    conflicts: db.prepare('SELECT * FROM claim_conflict ORDER BY id ASC').all() as Array<Record<string, unknown>>,
    redactions: db.prepare('SELECT * FROM redaction ORDER BY ts ASC').all() as Array<Record<string, unknown>>,
    purge_audits: db.prepare('SELECT * FROM purge_audit ORDER BY ts ASC').all() as Array<Record<string, unknown>>,
    token_revocations: db.prepare('SELECT * FROM token_revocation ORDER BY revoked_at ASC').all() as Array<
      Record<string, unknown>
    >,
    // Review records are tiny and may reference a claim the delta no longer
    // carries; a quorum check cannot wait for the next claim change.
    attestations: db.prepare('SELECT * FROM attestation ORDER BY ts ASC').all() as Array<Record<string, unknown>>,
  };
}

interface EncryptedBundle {
  format: 'lore-bundle/1-encrypted';
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function passphrase(): string | null {
  const value = process.env.LORE_BUNDLE_PASSPHRASE;
  return value && value.length >= 8 ? value : null;
}

export function readBundle(file: string): Bundle {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Bundle | EncryptedBundle;
  const format = (raw as { format?: string }).format;
  if (format === 'lore-bundle/1-encrypted') {
    const encrypted = raw as EncryptedBundle;
    const secret = passphrase();
    if (!secret) throw new Error('bundle is encrypted; set LORE_BUNDLE_PASSPHRASE');
    const salt = Buffer.from(encrypted.salt, 'base64');
    const iv = Buffer.from(encrypted.iv, 'base64');
    const key = scryptSync(secret, salt, 32);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as Bundle;
  }
  if (format !== 'lore-bundle/1') throw new Error(`unsupported bundle format: ${String(format)}`);
  const bundle = raw as Bundle;
  if (!bundle.repo_id) throw new Error('bundle has no repo_id');
  return bundle;
}

export function writeBundle(file: string, bundle: Bundle): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const secret = passphrase();
  if (!secret) {
    writeFileSync(file, `${JSON.stringify(bundle)}\n`);
    return;
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(secret, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(bundle), 'utf8'), cipher.final()]);
  const payload: EncryptedBundle = {
    format: 'lore-bundle/1-encrypted',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  writeFileSync(file, `${JSON.stringify(payload)}\n`);
}

export interface ImportResult {
  entities: number;
  claims: number;
  commits: number;
  merge: 'none' | 'up-to-date' | 'fast-forward' | 'three-way';
}

export function isAncestor(db: DB, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  const stmt = db.prepare('SELECT parent_id, merge_parent_id FROM memory_commit WHERE id = ?');
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = stmt.get(id) as { parent_id: string | null; merge_parent_id: string | null } | undefined;
    if (!row) continue;
    if (row.parent_id === ancestor || row.merge_parent_id === ancestor) return true;
    if (row.parent_id) queue.push(row.parent_id);
    if (row.merge_parent_id) queue.push(row.merge_parent_id);
  }
  return false;
}

export function setRef(db: DB, name: string, commitId: string): void {
  db.prepare(
    'INSERT INTO ref(name, commit_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET commit_id = excluded.commit_id',
  ).run(name, commitId);
}

/** Merge a remote tip into a local ref with the same ladder used everywhere else. */
export function mergeTip(
  db: DB,
  root: string,
  ref: string,
  sourceTip: string,
  author: string,
  ontology = loadOntology(root),
): ImportResult['merge'] {
  const local = head(db, ref);
  if (!local) {
    setRef(db, ref, sourceTip);
    return 'fast-forward';
  }
  if (local === sourceTip || isAncestor(db, sourceTip, local)) return 'up-to-date';

  // A fresh store has only the empty init commit; adopt the remote instead of
  // manufacturing a three-way merge with no common base.
  const localEntries = db
    .prepare('SELECT COUNT(*) AS n FROM commit_entry WHERE commit_id = ?')
    .get(local) as { n: number };
  const localCommit = db
    .prepare('SELECT parent_id FROM memory_commit WHERE id = ?')
    .get(local) as { parent_id: string | null } | undefined;
  if (localEntries.n === 0 && localCommit?.parent_id === null) {
    setRef(db, ref, sourceTip);
    return 'fast-forward';
  }
  if (isAncestor(db, local, sourceTip)) {
    setRef(db, ref, sourceTip);
    return 'fast-forward';
  }

  const plan = planMerge(db, root, local, sourceTip, {
    strategy: 'authority',
    strict: false,
    ontology,
    pendingResolution: loadPending(db),
  });
  if (plan.mode === 'conflict') {
    // Record what blocked the sync so `lore resolve` (including --auto-semantic)
    // can see it, and leave the remote tracking ref in place for comparison.
    db.prepare('DELETE FROM merge_conflict WHERE resolved = 0').run();
    const insert = db.prepare(
      `INSERT INTO merge_conflict(ours_tip, theirs_tip, subject_id, predicate, ours_claim, theirs_claim, base_claim, reason, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ts = new Date().toISOString();
    for (const c of plan.conflicts) {
      insert.run(local, sourceTip, c.subject, c.predicate, c.ours?.id ?? null, c.theirs?.id ?? null, c.base?.id ?? null, c.reason, ts);
    }
    const names = plan.conflicts.map((c) => `${c.subject} ${c.predicate}`).join(', ');
    throw new Error(
      `cannot sync: ${plan.conflicts.length} unresolved conflict(s) in ${names}; ` +
        'run `lore resolve <subject> <predicate> --take ours|theirs|both`, then `lore push` again',
    );
  }

  makeCommit(db, {
    ref,
    entries: [
      ...plan.add.map((claim_id) => ({ claim_id, op: 'add' as const })),
      ...plan.retract.map((claim_id) => ({ claim_id, op: 'retract' as const })),
    ],
    message: `sync: merge ${sourceTip}`,
    author,
    kind: 'merge',
    mergeParent: sourceTip,
  });
  markResolutionsApplied(db);
  return 'three-way';
}

export function importBundle(
  db: DB,
  root: string,
  bundle: Bundle,
  opts: { force?: boolean; author?: string } = {},
): ImportResult {
  const config = readConfig(root);
  if (config?.repo_id && config.repo_id !== bundle.repo_id && !opts.force) {
    throw new Error(
      `bundle belongs to repository ${bundle.repo_id}, this store is ${config.repo_id}; use --force to import anyway`,
    );
  }

  const counts = { entities: 0, claims: 0, commits: 0, merge: 'none' as ImportResult['merge'] };
  const changedIds = new Set<string>();

  const apply = db.transaction(() => {
    db.exec('PRAGMA defer_foreign_keys = ON');

    // Tombstones are authoritative before any row is inserted: a purge is
    // permanent, and a redaction pins the payload even if a peer still ships it.
    // Read them under the write lock so a concurrent purge cannot be missed.
    const purgedIds = new Set(
      (db.prepare('SELECT claim_id FROM purge_audit').all() as Array<{ claim_id: string }>).map((r) => r.claim_id),
    );
    for (const row of bundle.purge_audits ?? []) {
      const id = String(row.claim_id ?? '');
      if (id) purgedIds.add(id);
    }
    const redactedIds = new Set(
      (db.prepare('SELECT claim_id FROM redaction').all() as Array<{ claim_id: string }>).map((r) => r.claim_id),
    );
    for (const row of bundle.redactions ?? []) {
      const id = String(row.claim_id ?? '');
      if (id) redactedIds.add(id);
    }
    // A purge is the stronger tombstone; a stale peer must not re-redact it.
    for (const id of purgedIds) redactedIds.delete(id);
    const skippedIds = new Set([...purgedIds, ...redactedIds]);

    const deleteClaimRead = db.prepare('DELETE FROM claim_read WHERE claim_id = ?');
    const deleteCommitEntry = db.prepare('DELETE FROM commit_entry WHERE claim_id = ?');
    const deleteEvidence = db.prepare('DELETE FROM evidence WHERE claim_id = ?');
    const clearSupersedes = db.prepare('UPDATE claim SET supersedes = NULL WHERE supersedes = ?');
    const deleteRedaction = db.prepare('DELETE FROM redaction WHERE claim_id = ?');
    const deleteAttestation = db.prepare('DELETE FROM attestation WHERE claim_id = ? OR attestation_claim_id = ?');
    const deleteClaimConflict = db.prepare('DELETE FROM claim_conflict WHERE left_claim = ? OR right_claim = ?');
    const deleteMergeConflict = db.prepare(
      'DELETE FROM merge_conflict WHERE ours_claim = ? OR theirs_claim = ? OR base_claim = ?',
    );
    const deleteClaim = db.prepare('DELETE FROM claim WHERE id = ?');
    const insertPurgeAudit = db.prepare(
      'INSERT INTO purge_audit(claim_id, actor, reason, ts) VALUES (?, ?, ?, ?) ON CONFLICT(claim_id) DO NOTHING',
    );
    const insertRedaction = db.prepare(
      'INSERT INTO redaction(claim_id, original_hash, actor, reason, ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT(claim_id) DO NOTHING',
    );
    const pinRedaction = db.prepare(
      `UPDATE claim SET object_json = '"[redacted]"', state = 'retracted', trust = 'retracted' WHERE id = ?`,
    );
    const closeConflict = db.prepare(
      `UPDATE claim_conflict SET resolved = 1, resolved_by = 'lore:sync:redact'
       WHERE resolved = 0 AND (left_claim = ? OR right_claim = ?)`,
    );

    for (const id of purgedIds) {
      deleteClaimRead.run(id);
      deleteCommitEntry.run(id);
      deleteEvidence.run(id);
      clearSupersedes.run(id);
      deleteRedaction.run(id);
      deleteAttestation.run(id, id);
      deleteClaimConflict.run(id, id);
      deleteMergeConflict.run(id, id, id);
      deleteClaim.run(id);
      scrubClaimAuditLog(db, id);
    }
    for (const row of bundle.purge_audits ?? []) {
      const id = String(row.claim_id ?? '');
      if (!id) continue;
      insertPurgeAudit.run(
        id,
        String(row.actor ?? 'lore:sync'),
        row.reason ?? null,
        String(row.ts ?? new Date().toISOString()),
      );
    }
    for (const row of bundle.redactions ?? []) {
      const id = String(row.claim_id ?? '');
      if (!id || purgedIds.has(id)) continue;
      insertRedaction.run(
        id,
        String(row.original_hash ?? ''),
        String(row.actor ?? 'lore:sync'),
        row.reason ?? null,
        String(row.ts ?? new Date().toISOString()),
      );
    }
    for (const id of redactedIds) {
      pinRedaction.run(id);
      closeConflict.run(id, id);
      scrubClaimAuditLog(db, id);
    }

    const insertRevocation = db.prepare(
      `INSERT INTO token_revocation (jti, sub, reason, revoked_by, revoked_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(jti) DO UPDATE SET
         sub = CASE WHEN excluded.revoked_at > token_revocation.revoked_at
                    THEN excluded.sub ELSE token_revocation.sub END,
         reason = CASE WHEN excluded.revoked_at > token_revocation.revoked_at
                       THEN excluded.reason ELSE token_revocation.reason END,
         revoked_by = CASE WHEN excluded.revoked_at > token_revocation.revoked_at
                           THEN excluded.revoked_by ELSE token_revocation.revoked_by END,
         revoked_at = CASE WHEN excluded.revoked_at > token_revocation.revoked_at
                           THEN excluded.revoked_at ELSE token_revocation.revoked_at END`,
    );
    for (const row of bundle.token_revocations ?? []) {
      const jti = String(row.jti ?? '');
      if (!jti) continue;
      insertRevocation.run(
        jti,
        String(row.sub ?? ''),
        row.reason ?? null,
        String(row.revoked_by ?? 'lore:sync'),
        String(row.revoked_at ?? new Date().toISOString()),
      );
    }

    const insertAttestation = db.prepare(
      `INSERT OR IGNORE INTO attestation(claim_id, attestation_claim_id, verdict, actor, ts, proof_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const row of bundle.attestations ?? []) {
      const claimId = String(row.claim_id ?? '');
      const attestationClaimId = String(row.attestation_claim_id ?? '');
      // Either endpoint being purged means the attestation must not survive.
      if (!claimId || purgedIds.has(claimId) || purgedIds.has(attestationClaimId)) continue;
      const verdict = row.verdict === 'disagree' ? 'disagree' : 'agree';
      insertAttestation.run(
        claimId,
        attestationClaimId,
        verdict,
        String(row.actor ?? 'lore:sync'),
        String(row.ts ?? new Date().toISOString()),
        row.proof_json ?? null,
      );
    }

    const insertEntity = db.prepare(
      'INSERT OR IGNORE INTO entity(id, kind, canonical, created_at) VALUES (?, ?, ?, ?)',
    );
    for (const row of bundle.entities) {
      insertEntity.run(row.id, row.kind, row.canonical, row.created_at);
      counts.entities += 1;
    }

    const insertClaim = db.prepare(
      `INSERT OR IGNORE INTO claim(id, subject_id, predicate, object_json, valid_from, valid_to, tx_from,
        authority, confidence, author, supersedes, state,
        trust, ttl_days, last_verified_at, confirmations, contradictions, invalidated_by_json,
        written_by, agent_id, session_id, run_id, tags_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Bundles from before Canon have no trust column. Rebuild the same decision
    // the one-time backfill makes: observed evidence is canonical, drafts wait.
    const observed = new Map<string, boolean>();
    const verifiedAt = new Map<string, string>();
    for (const ev of bundle.evidence) {
      if (ev.hash != null || ev.commit_id != null) observed.set(String(ev.claim_id), true);
      if (typeof ev.verified_at === 'string') {
        const current = verifiedAt.get(String(ev.claim_id));
        if (!current || ev.verified_at > current) verifiedAt.set(String(ev.claim_id), ev.verified_at);
      }
    }
    const trustOf = (row: Record<string, unknown>): string => {
      if (typeof row.trust === 'string') return row.trust;
      if (row.state === 'retracted') return 'retracted';
      if (row.state === 'draft') return 'candidate';
      return observed.get(String(row.id)) ? 'canonical' : 'candidate';
    };
    const writtenBy = (row: Record<string, unknown>): string => {
      if (typeof row.written_by === 'string') return row.written_by;
      const author = String(row.author ?? '');
      return author.startsWith('agent:') ? 'agent' : author.startsWith('human:') ? 'human' : 'legacy';
    };
    const agentId = (row: Record<string, unknown>): string | null => {
      if (typeof row.agent_id === 'string') return row.agent_id;
      const author = String(row.author ?? '');
      return author.startsWith('agent:') ? author.slice('agent:'.length).split('/')[0] : null;
    };

    const getClaim = db.prepare('SELECT * FROM claim WHERE id = ?');
    const updateClaim = db.prepare(
      `UPDATE claim SET trust = ?, last_verified_at = ?, invalidated_by_json = ?,
                        confirmations = MAX(confirmations, ?), contradictions = MAX(contradictions, ?)
       WHERE id = ?`,
    );

    for (const row of bundle.claims) {
      const id = String(row.id);
      if (skippedIds.has(id)) continue;
      const remoteTrust = trustOf(row) as Trust;
      const remoteVerified =
        (typeof row.last_verified_at === 'string' ? row.last_verified_at : null) ??
        verifiedAt.get(id) ??
        String(row.tx_from);
      const remoteInvalidated = typeof row.invalidated_by_json === 'string' ? row.invalidated_by_json : null;

      const existing = getClaim.get(id) as ClaimRow | undefined;
      if (!existing) {
        insertClaim.run(
          row.id, row.subject_id, row.predicate, row.object_json, row.valid_from, row.valid_to,
          row.tx_from, row.authority, row.confidence, row.author, row.supersedes, row.state,
          remoteTrust, row.ttl_days ?? null, remoteVerified,
          row.confirmations ?? 0, row.contradictions ?? 0, remoteInvalidated,
          writtenBy(row), agentId(row), row.session_id ?? null, row.run_id ?? null, row.tags_json ?? '[]',
        );
        changedIds.add(id);
      } else {
        const merged = mergeTrust(existing, { trust: remoteTrust, last_verified_at: remoteVerified, tx_from: String(row.tx_from) });
        const invalidated = merged === remoteTrust ? remoteInvalidated : existing.invalidated_by_json;
        const verified = laterIso(existing.last_verified_at, remoteVerified);
        updateClaim.run(
          merged,
          verified,
          invalidated,
          row.confirmations ?? 0,
          row.contradictions ?? 0,
          id,
        );
        if (merged !== existing.trust || verified !== existing.last_verified_at) changedIds.add(id);
      }
      counts.claims += 1;
    }

    const insertEvidence = db.prepare(
      `INSERT OR IGNORE INTO evidence(claim_id, kind, ref, hash, commit_id, verified_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of bundle.evidence) {
      if (skippedIds.has(String(row.claim_id))) continue;
      insertEvidence.run(row.claim_id, row.kind, row.ref, row.hash, row.commit_id, row.verified_at, row.status);
    }

    const insertConflict = db.prepare(
      `INSERT INTO claim_conflict
         (subject_id, predicate, left_claim, right_claim, tier, reason, detected_at, resolved, resolved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(left_claim, right_claim) DO UPDATE SET
         resolved = MAX(claim_conflict.resolved, excluded.resolved),
         resolved_by = CASE WHEN excluded.resolved = 1 THEN excluded.resolved_by ELSE claim_conflict.resolved_by END,
         detected_at = CASE WHEN excluded.detected_at > claim_conflict.detected_at
                            THEN excluded.detected_at ELSE claim_conflict.detected_at END`,
    );
    for (const row of bundle.conflicts ?? []) {
      if (skippedIds.has(String(row.left_claim)) || skippedIds.has(String(row.right_claim))) continue;
      insertConflict.run(
        row.subject_id, row.predicate, row.left_claim, row.right_claim, row.tier ?? 1,
        row.reason ?? 'tier-1 conflict', row.detected_at ?? new Date().toISOString(),
        row.resolved ?? 0, row.resolved_by ?? null,
      );
    }

    const insertCommit = db.prepare(
      `INSERT OR IGNORE INTO memory_commit(id, parent_id, merge_parent_id, tree_hash, message, author, ts, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of bundle.commits) {
      insertCommit.run(
        row.id, row.parent_id, row.merge_parent_id, row.tree_hash, row.message, row.author, row.ts, row.kind,
      );
      counts.commits += 1;
    }

    const insertEntry = db.prepare(
      'INSERT OR IGNORE INTO commit_entry(commit_id, claim_id, op) VALUES (?, ?, ?)',
    );
    for (const row of bundle.entries) {
      // A purged/redacted claim must not re-enter the branch fold through history.
      if (skippedIds.has(String(row.claim_id))) continue;
      insertEntry.run(row.commit_id, row.claim_id, row.op);
    }
    return { skippedIds, changedIds };
  });

  // IMMEDIATE takes the write lock before reading tombstones, so a purge or
  // redaction committed by another process cannot race the import snapshot.
  const { skippedIds } = apply.immediate();
  const ontology = loadOntology(root);

  for (const id of changedIds) {
    if (skippedIds.has(id)) continue;
    runClaimWriteHooks(db, id);
  }

  const mainRef = bundle.refs.find((r) => r.name === 'main');
  if (mainRef) {
    // Record what the remote had before merging: a conflicted merge throws, and
    // the reviewer still needs the remote observation to compare and resolve.
    setRef(db, 'refs/remotes/origin/main', mainRef.commit_id);
    counts.merge = mergeTip(db, root, 'main', mainRef.commit_id, opts.author ?? 'lore:sync', ontology);
  }
  for (const ref of bundle.refs) {
    if (ref.name === 'main') continue;
    // Non-main refs (proposal branches, peer branches) are imported as branches.
    // A diverged local branch is left alone: local work is never overwritten.
    const localTip = head(db, ref.name);
    if (!localTip || localTip === ref.commit_id || isAncestor(db, localTip, ref.commit_id)) {
      setRef(db, ref.name, ref.commit_id);
    }
  }

  return counts;
}

/**
 * After a fetch, move the current session branch forward when it is strictly
 * behind main. A branch with its own unpushed commits is left alone.
 */
export function fastForwardSession(db: DB, root: string): void {
  const ref = branchFor(currentSession(root));
  const tip = head(db, ref);
  const main = head(db, 'main');
  if (!tip || !main || tip === main) return;
  if (isAncestor(db, tip, main)) setRef(db, ref, main);
}

/** Import the remote bundle if present, then write ours. Returns the import result. */
export function pushToDir(db: DB, root: string, dir: string, repoId: string, author: string): ImportResult {
  const file = bundleFile(dir, repoId);
  let imported: ImportResult = { entities: 0, claims: 0, commits: 0, merge: 'none' };
  if (existsSync(file)) {
    imported = importBundle(db, root, readBundle(file), { author });
  }
  writeBundle(file, buildBundle(db, repoId));
  return imported;
}

export function fetchFromDir(db: DB, root: string, dir: string, repoId: string, author: string): ImportResult {
  const file = bundleFile(dir, repoId);
  if (!existsSync(file)) throw new Error(`no bundle at ${file} (push one first, or check the remote path)`);
  return importBundle(db, root, readBundle(file), { author });
}

export * from './sync/litestream.js';
