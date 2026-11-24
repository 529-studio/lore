import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { claimsFor, type ClaimRow } from '../model.js';
import { requireAction } from '../policy.js';
import { isSemanticallyEquivalent } from '../merge.js';
import { cosineSimilarity, generateLocalEmbedding } from '../search/vector.js';

export interface ResolveOptions {
  subject?: string;
  predicate?: string;
  take?: 'ours' | 'theirs' | 'both';
  reason?: string;
  autoSemantic?: boolean;
  root?: string;
}

export function resolveCommand(opts: ResolveOptions): void {
  const root = opts.root ?? requireRoot();
  const db = openDb(root);

  if (opts.autoSemantic) {
    const conflicts = db
      .prepare(
        `SELECT mc.id, mc.subject_id, mc.predicate, mc.ours_claim, mc.theirs_claim, mc.base_claim
         FROM merge_conflict mc
         WHERE mc.resolved = 0`,
      )
      .all() as Array<{
      id: number;
      subject_id: string;
      predicate: string;
      ours_claim: string | null;
      theirs_claim: string | null;
      base_claim: string | null;
    }>;

    if (!conflicts.length) {
      console.log(pc.dim('no open merge conflicts to resolve'));
      db.close();
      return;
    }

    const claimStmt = db.prepare('SELECT * FROM claim WHERE id = ?');
    const insertRes = db.prepare(
      `INSERT INTO resolution(subject_id, predicate, take, reason, ts, applied)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(subject_id, predicate) DO UPDATE SET
         take = excluded.take, reason = excluded.reason, ts = excluded.ts, applied = 0`,
    );

    let count = 0;
    const now = new Date().toISOString();
    for (const c of conflicts) {
      const o = c.ours_claim ? (claimStmt.get(c.ours_claim) as ClaimRow | undefined) : undefined;
      const t = c.theirs_claim ? (claimStmt.get(c.theirs_claim) as ClaimRow | undefined) : undefined;
      const b = c.base_claim ? (claimStmt.get(c.base_claim) as ClaimRow | undefined) : undefined;

      let take: 'ours' | 'theirs' = 'ours';
      let reason = 'semantic auto-resolution';

      if (o && t) {
        if (isSemanticallyEquivalent(o.object_json, t.object_json)) {
          take = 'ours';
          reason = 'semantically equivalent payloads';
        } else if (Math.abs(o.confidence - t.confidence) >= 0.05) {
          take = o.confidence > t.confidence ? 'ours' : 'theirs';
          reason = `confidence ${(take === 'ours' ? o : t).confidence.toFixed(2)} beats ${(take === 'ours' ? t : o).confidence.toFixed(2)}`;
        } else {
          const context = `${c.subject_id} ${c.predicate} ${b ? b.object_json : ''}`;
          const simO = cosineSimilarity(generateLocalEmbedding(context), generateLocalEmbedding(o.object_json));
          const simT = cosineSimilarity(generateLocalEmbedding(context), generateLocalEmbedding(t.object_json));
          take = simO >= simT ? 'ours' : 'theirs';
          reason = `semantic alignment ${(take === 'ours' ? simO : simT).toFixed(2)} beats ${(take === 'ours' ? simT : simO).toFixed(2)}`;
        }
      } else if (o && !t) {
        take = 'ours';
      } else if (!o && t) {
        take = 'theirs';
      }

      insertRes.run(c.subject_id, c.predicate, take, reason, now);
      console.log(
        `${pc.green('✓')} auto-resolved: ${c.subject_id} ${pc.dim('—')} ${c.predicate} → ${pc.bold(take)} ${pc.dim(`(${reason})`)}`,
      );
      count++;
    }
    console.log(pc.dim(`  auto-resolved ${count} conflict(s). Re-run 'lore merge <branch>' to apply.`));
    db.close();
    return;
  }

  if (!opts.subject || !opts.predicate || !opts.take) {
    throw new Error('subject, predicate, and --take are required unless --auto-semantic is specified');
  }

  const claims = claimsFor(db, opts.subject).filter((c) => c.predicate === opts.predicate);
  if (!claims.length) {
    throw new Error(`no claims for ${opts.subject} — ${opts.predicate}`);
  }

  const principal = requireAction(root, 'resolve', { subject: opts.subject });

  db.prepare(
    `INSERT INTO resolution(subject_id, predicate, take, reason, ts, applied)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(subject_id, predicate) DO UPDATE SET
       take = excluded.take, reason = excluded.reason, ts = excluded.ts, applied = 0`,
  ).run(opts.subject, opts.predicate, opts.take, opts.reason ?? null, new Date().toISOString());

  console.log(
    `${pc.green('✓')} recorded by ${principal.id}: ${opts.subject} ${pc.dim('—')} ${opts.predicate} → ${pc.bold(opts.take)}`,
  );
  if (opts.reason) console.log(pc.dim(`  reason: ${opts.reason}`));
  console.log(pc.dim('  re-run `lore merge <branch>` to apply'));
  db.close();
}
