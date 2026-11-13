import { existsSync } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { hashCache } from '../hash-cache.js';
import { gitHead } from '../util/git.js';
import { inBranch, makeCommit, supersedeClaim, type EvidenceKind } from '../model.js';
import { branchFor, currentSession, ensureSession } from '../session.js';

export interface SupersedeOptions {
  claim: string;
  object: string;
  kind: EvidenceKind;
  ref?: string;
  hash?: string;
  confidence?: string;
  author?: string;
  session?: string;
  ttlDays?: string;
}

export function supersedeCommand(opts: SupersedeOptions): void {
  const root = requireRoot();
  const db = openDb(root);
  const session = ensureSession(db, root, opts.session);
  const ref = branchFor(session);
  const evidenceRef = opts.ref ?? opts.claim;

  if (opts.ttlDays !== undefined && (!Number.isFinite(Number(opts.ttlDays)) || Number(opts.ttlDays) < 0)) {
    throw new Error(`--ttl-days: expected a non-negative number: ${opts.ttlDays}`);
  }

  let hash = opts.hash ?? null;
  if (!hash && (opts.kind === 'file' || opts.kind === 'test')) {
    hash = hashCache(db, root).hash(evidenceRef);
  }

  const run = db.transaction(() => {
    const result = supersedeClaim(db, opts.claim, {
      object: opts.object,
      confidence: opts.confidence ? Number(opts.confidence) : undefined,
      author: opts.author ?? 'human:cli',
      sessionId: session,
      ttlDays: opts.ttlDays !== undefined ? Number(opts.ttlDays) : undefined,
      evidence: [{ kind: opts.kind, ref: evidenceRef, hash, commit: gitHead(root) }],
    });

    if (result.state === 'active' && !inBranch(db, ref, result.newId)) {
      makeCommit(db, {
        ref,
        entries: [{ claim_id: result.newId, op: 'supersede' }],
        message: `supersede: ${result.oldId} -> ${result.newId}`,
        author: opts.author ?? 'human:cli',
        kind: 'write',
      });
    }
    return result;
  });

  const result = run();
  const state = result.state === 'active' ? pc.green('active') : pc.yellow('draft');
  console.log(`${pc.green('~')} ${pc.bold(result.newId)} ${state} ${pc.dim(`authority T${result.authority}`)}`);
  console.log(pc.dim(`  supersedes ${result.oldId}`));
  console.log(`  ${opts.object}`);
  db.close();
}
