import { existsSync } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { fileHash, makeCommit, upsertClaim, type EvidenceKind } from '../model.js';
import { branchFor, currentSession } from '../session.js';

export interface WriteOptions {
  subject: string;
  predicate: string;
  object: string;
  kind: EvidenceKind;
  ref?: string;
  hash?: string;
  confidence?: string;
  author?: string;
  session?: string;
}

export function writeCommand(opts: WriteOptions): void {
  const root = requireRoot();
  const db = openDb(root);
  const session = currentSession(root, opts.session);
  const ref = branchFor(session);

  const evidenceRef = opts.ref ?? opts.subject;
  let hash = opts.hash ?? null;
  if (!hash && (opts.kind === 'file' || opts.kind === 'test')) {
    const abs = path.join(root, evidenceRef);
    if (existsSync(abs)) hash = fileHash(abs);
  }

  const result = upsertClaim(db, {
    subject: opts.subject,
    predicate: opts.predicate,
    object: opts.object,
    confidence: opts.confidence ? Number(opts.confidence) : undefined,
    author: opts.author ?? 'human:cli',
    evidence: [{ kind: opts.kind, ref: evidenceRef, hash }],
  });

  if (result.inserted) {
    makeCommit(db, {
      ref,
      entries: [{ claim_id: result.id, op: 'add' }],
      message: `write: ${opts.predicate} ${opts.subject}`,
      author: opts.author ?? 'human:cli',
      kind: 'write',
    });
  }

  const stateLabel = result.state === 'active' ? pc.green('active') : pc.yellow('draft');
  console.log(
    `${result.inserted ? '+' : pc.dim('=')} ${pc.bold(result.id)} ${stateLabel} ${pc.dim(`authority T${result.authority}`)}`,
  );
  console.log(`  ${opts.subject} ${pc.dim('—')} ${opts.predicate} ${pc.dim('—')} ${opts.object}`);
  console.log(`  ${pc.dim(`evidence: ${opts.kind}:${evidenceRef}${hash ? ` @ ${hash.slice(0, 15)}…` : ''}`)}`);
  if (result.state === 'draft') {
    console.log(pc.dim(`  draft không vào retrieval cho tới khi: lore approve ${result.id}`));
  }
  db.close();
}
