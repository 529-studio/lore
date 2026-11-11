import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import type { DB } from '../db.js';
import { head, makeCommit } from '../model.js';
import { planMerge } from '../merge.js';
import { loadOntology } from '../ontology.js';
import { branchFor, currentSession } from '../session.js';

const SEP = '\u0000';

function loadPending(db: DB): Map<string, 'ours' | 'theirs' | 'both'> {
  const rows = db
    .prepare('SELECT subject_id, predicate, take FROM resolution WHERE applied = 0')
    .all() as Array<{ subject_id: string; predicate: string; take: 'ours' | 'theirs' | 'both' }>;
  return new Map(rows.map((r) => [`${r.subject_id}${SEP}${r.predicate}`, r.take]));
}

export interface PromoteOptions {
  session?: string;
  into?: string;
  strict?: boolean;
  dryRun?: boolean;
}

/**
 * Merge the current session branch into `main` (or --into <ref>), so other
 * sessions inherit it. This is the missing link that made new branches start empty.
 */
export function promoteCommand(opts: PromoteOptions): void {
  const root = requireRoot();
  const db = openDb(root);
  const into = opts.into ?? 'main';
  const session = currentSession(root, opts.session);
  const fromRef = branchFor(session);

  const intoTip = head(db, into);
  const fromTip = head(db, fromRef);
  if (!fromTip) throw new Error(`${fromRef} has no commits yet`);

  const plan = planMerge(db, root, intoTip, fromTip, {
    strategy: 'authority',
    strict: Boolean(opts.strict),
    ontology: loadOntology(root),
    pendingResolution: loadPending(db),
  });

  console.log(`${pc.bold(into)} ${pc.dim('←')} ${pc.bold(fromRef)} ${pc.dim(`(base ${plan.baseCommit ?? 'none'})`)}`);

  if (plan.mode === 'up-to-date') {
    console.log(pc.dim('  up to date'));
    db.close();
    return;
  }

  if (plan.mode === 'fast-forward') {
    if (!opts.dryRun) {
      db.prepare(
        'INSERT INTO ref(name, commit_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET commit_id = excluded.commit_id',
      ).run(into, fromTip);
    }
    console.log(pc.green(`  fast-forward → ${fromTip}`));
    db.close();
    return;
  }

  if (plan.mode === 'conflict') {
    console.log(pc.red(`\n  ABORT — ${plan.conflicts.length} conflict chưa giải được`));
    for (const c of plan.conflicts) {
      console.log(`\n  ${pc.bold(c.subject)} ${pc.dim('—')} ${pc.bold(c.predicate)}`);
      console.log(`    ${into}  ${c.ours?.id ?? '(absent)'} ${c.ours ? pc.yellow(`T${c.ours.authority}`) : ''}`);
      console.log(`    ${fromRef} ${c.theirs?.id ?? '(absent)'} ${c.theirs ? pc.yellow(`T${c.theirs.authority}`) : ''}`);
    }
    console.log(pc.dim(`\n  lore resolve ... rồi chạy lại: lore promote`));
    process.exitCode = 2;
    db.close();
    return;
  }

  if (opts.dryRun) {
    console.log(pc.dim(`  dry run: +${plan.add.length} / -${plan.retract.length}`));
    db.close();
    return;
  }

  const apply = db.transaction(() => {
    const id = makeCommit(db, {
      ref: into,
      entries: [
        ...plan.add.map((claim_id) => ({ claim_id, op: 'add' as const })),
        ...plan.retract.map((claim_id) => ({ claim_id, op: 'retract' as const })),
      ],
      message: `promote ${fromRef} into ${into}`,
      author: `agent:${session}`,
      kind: 'merge',
      mergeParent: fromTip,
    });
    const insert = db.prepare(
      `INSERT INTO merge_decision(commit_id, subject_id, predicate, winner, loser, rule, reason, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ts = new Date().toISOString();
    for (const d of plan.decisions) {
      insert.run(id, d.subject, d.predicate, d.winner, d.loser, d.rule, d.reason, ts);
    }
    db.prepare('UPDATE resolution SET applied = 1 WHERE applied = 0').run();
    return id;
  });

  const commitId = apply();
  console.log(pc.green(`  promoted → ${commitId}`));
  console.log(pc.dim(`  +${plan.add.length} added, -${plan.retract.length} retracted, ${plan.decisions.length} resolved`));
  db.close();
}
