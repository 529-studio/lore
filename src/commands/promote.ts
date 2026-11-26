import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import type { DB } from '../db.js';
import { head, makeCommit } from '../model.js';
import { planMerge, type MergePlan } from '../merge.js';
import { loadOntology } from '../ontology.js';
import { branchFor, ensureSession } from '../session.js';
import { requireAction } from '../policy.js';
import { loadPending, markResolutionsApplied } from '../resolution.js';

export interface PromoteRefResult {
  mode: MergePlan['mode'];
  commitId: string | null;
  plan: MergePlan;
  /** Cross-branch merge decisions persisted by this promotion. */
  decisions: number;
}

/**
 * Merge one branch into another with the shared ladder. Used by `lore promote`
 * and by remote proposal promotion, so both consume `lore resolve` decisions
 * and leave the same merge_decision trail.
 */
export function promoteRef(
  db: DB,
  root: string,
  fromRef: string,
  into: string,
  opts: { strict?: boolean; author: string; message?: string; dryRun?: boolean } = { author: 'human:promote' },
): PromoteRefResult {
  const intoTip = head(db, into);
  const fromTip = head(db, fromRef);
  if (!fromTip) throw new Error(`${fromRef} has no commits yet`);

  const plan = planMerge(db, root, intoTip, fromTip, {
    strategy: 'authority',
    strict: Boolean(opts.strict),
    ontology: loadOntology(root),
    pendingResolution: loadPending(db),
  });

  if (opts.dryRun || plan.mode === 'up-to-date' || plan.mode === 'conflict') {
    return { mode: plan.mode, commitId: null, plan, decisions: 0 };
  }

  if (plan.mode === 'fast-forward') {
    db.prepare(
      'INSERT INTO ref(name, commit_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET commit_id = excluded.commit_id',
    ).run(into, fromTip);
    return { mode: 'fast-forward', commitId: fromTip, plan, decisions: 0 };
  }

  const apply = db.transaction(() => {
    const id = makeCommit(db, {
      ref: into,
      entries: [
        ...plan.add.map((claim_id) => ({ claim_id, op: 'add' as const })),
        ...plan.retract.map((claim_id) => ({ claim_id, op: 'retract' as const })),
      ],
      message: opts.message ?? `promote ${fromRef} into ${into}`,
      author: opts.author,
      kind: 'merge',
      mergeParent: fromTip,
    });
    const insert = db.prepare(
      `INSERT INTO merge_decision(commit_id, subject_id, predicate, winner, loser, rule, reason, actor, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ts = new Date().toISOString();
    for (const d of plan.decisions) {
      insert.run(id, d.subject, d.predicate, d.winner, d.loser, d.rule, d.reason, opts.author, ts);
    }
    markResolutionsApplied(db);
    return id;
  });

  const commitId = apply();
  return { mode: 'three-way', commitId, plan, decisions: plan.decisions.length };
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
  const principal = requireAction(root, 'promote');
  const into = opts.into ?? 'main';
  const session = ensureSession(db, root, opts.session);
  const fromRef = branchFor(session);
  const author = `human:${principal.id}`;

  const result = promoteRef(db, root, fromRef, into, {
    strict: opts.strict,
    dryRun: opts.dryRun,
    author,
  });
  const plan = result.plan;
  console.log(`${pc.bold(into)} ${pc.dim('←')} ${pc.bold(fromRef)} ${pc.dim(`(base ${plan.baseCommit ?? 'none'})`)}`);

  if (plan.mode === 'up-to-date') {
    console.log(pc.dim('  up to date'));
    db.close();
    return;
  }

  if (plan.mode === 'fast-forward') {
    console.log(pc.green(`  fast-forward → ${plan.theirsTip ?? result.commitId}`));
    db.close();
    return;
  }

  if (plan.mode === 'conflict') {
    console.log(pc.red(`\n  ABORT — ${plan.conflicts.length} unresolved conflict(s)`));
    for (const c of plan.conflicts) {
      console.log(`\n  ${pc.bold(c.subject)} ${pc.dim('—')} ${pc.bold(c.predicate)}`);
      console.log(`    ${into}  ${c.ours?.id ?? '(absent)'} ${c.ours ? pc.yellow(`T${c.ours.authority}`) : ''}`);
      console.log(`    ${fromRef} ${c.theirs?.id ?? '(absent)'} ${c.theirs ? pc.yellow(`T${c.theirs.authority}`) : ''}`);
    }
    console.log(pc.dim(`\n  lore resolve ... then re-run: lore promote`));
    process.exitCode = 2;
    db.close();
    return;
  }

  if (opts.dryRun) {
    console.log(pc.dim(`  dry run: +${plan.add.length} / -${plan.retract.length}`));
    db.close();
    return;
  }

  console.log(pc.green(`  promoted → ${result.commitId}`));
  console.log(pc.dim(`  +${plan.add.length} added, -${plan.retract.length} retracted, ${result.decisions} resolved`));
  db.close();
}
