import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import type { DB } from '../db.js';
import { head, makeCommit, type ClaimRow } from '../model.js';
import { planMerge, type Decision } from '../merge.js';
import { loadOntology } from '../ontology.js';
import { resolveRevision } from '../revision.js';
import { branchFor, currentSession } from '../session.js';

const SEP = '\u0000';

function loadPending(db: DB): Map<string, 'ours' | 'theirs' | 'both'> {
  const rows = db
    .prepare('SELECT subject_id, predicate, take FROM resolution WHERE applied = 0')
    .all() as Array<{ subject_id: string; predicate: string; take: 'ours' | 'theirs' | 'both' }>;
  return new Map(rows.map((r) => [`${r.subject_id}${SEP}${r.predicate}`, r.take]));
}

function objectOf(row: ClaimRow | null): string {
  if (!row) return '(absent)';
  try {
    return String(JSON.parse(row.object_json));
  } catch {
    return row.object_json;
  }
}

function describe(row: ClaimRow | null): string {
  if (!row) return pc.dim('(absent)');
  return `${pc.dim(row.id)} ${pc.yellow(`T${row.authority}`)} ${objectOf(row)}`;
}

function printDecisions(decisions: Decision[]): void {
  for (const d of decisions) {
    const tag =
      d.rule === 'authority'
        ? pc.blue('authority')
        : d.rule === 'recency'
          ? pc.magenta('recency')
          : d.rule === 'human'
            ? pc.green('human')
            : pc.cyan(d.rule);
    console.log(`  ${pc.dim('resolved')} ${tag} ${d.subject} ${pc.dim('—')} ${d.predicate} ${pc.dim(`(${d.reason})`)}`);
  }
}

export interface MergeOptions {
  branch: string;
  session?: string;
  strategy?: 'authority' | 'recency';
  strict?: boolean;
  dryRun?: boolean;
}

export function mergeCommand(opts: MergeOptions): void {
  const root = requireRoot();
  const db = openDb(root);
  const session = currentSession(root, opts.session);
  const ref = branchFor(session);
  const oursTip = head(db, ref) ?? head(db, 'main');
  const theirs = resolveRevision(db, opts.branch, root);

  if (!theirs.id) throw new Error(`unknown branch/revision: ${opts.branch}`);

  const ontology = loadOntology(root);
  const plan = planMerge(db, root, oursTip, theirs.id, {
    strategy: opts.strategy ?? 'authority',
    strict: Boolean(opts.strict),
    ontology,
    pendingResolution: loadPending(db),
  });

  console.log(`${pc.bold(ref)} ${pc.dim('←')} ${pc.bold(theirs.label)} ${pc.dim(`(base ${plan.baseCommit ?? 'none'})`)}`);

  if (plan.mode === 'up-to-date') {
    console.log(pc.dim('  up to date — nothing to merge'));
    db.close();
    return;
  }

  if (plan.mode === 'fast-forward') {
    if (!opts.dryRun) {
      db.prepare(
        'INSERT INTO ref(name, commit_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET commit_id = excluded.commit_id',
      ).run(ref, theirs.id);
      db.prepare('UPDATE resolution SET applied = 1 WHERE applied = 0').run();
    }
    console.log(pc.green(`  fast-forward → ${theirs.id}`));
    db.close();
    return;
  }

  if (plan.mode === 'conflict') {
    if (!opts.dryRun) {
      db.prepare('DELETE FROM merge_conflict WHERE resolved = 0').run();
      const insert = db.prepare(
        `INSERT INTO merge_conflict(ours_tip, theirs_tip, subject_id, predicate, ours_claim, theirs_claim, base_claim, reason, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const ts = new Date().toISOString();
      for (const c of plan.conflicts) {
        insert.run(oursTip, theirs.id, c.subject, c.predicate, c.ours?.id ?? null, c.theirs?.id ?? null, c.base?.id ?? null, c.reason, ts);
      }
    }
    console.log(pc.red(`\n  ABORT — ${plan.conflicts.length} unresolved conflict(s) (not guessing)`));
    for (const c of plan.conflicts) {
      console.log(`\n  ${pc.bold(c.subject)} ${pc.dim('—')} ${pc.bold(c.predicate)} ${pc.dim(`(${c.reason})`)}`);
      console.log(`    ours   ${describe(c.ours)}`);
      console.log(`    theirs ${describe(c.theirs)}`);
      if (c.base) console.log(`    base   ${describe(c.base)}`);
    }
    console.log(
      pc.dim(`\n  resolve manually: lore resolve <subject> <predicate> --take ours|theirs|both --reason "..."\n  then re-run: lore merge ${theirs.label}`),
    );
    process.exitCode = 2;
    db.close();
    return;
  }

  if (opts.dryRun) {
    console.log(pc.dim(`  dry run: +${plan.add.length} / -${plan.retract.length}`));
    printDecisions(plan.decisions);
    db.close();
    return;
  }

  const entries = [
    ...plan.add.map((id) => ({ claim_id: id, op: 'add' as const })),
    ...plan.retract.map((id) => ({ claim_id: id, op: 'retract' as const })),
  ];

  const apply = db.transaction(() => {
    const id = makeCommit(db, {
      ref,
      entries,
      message: `merge ${theirs.label} into ${ref}`,
      author: `agent:${session}`,
      kind: 'merge',
      mergeParent: theirs.id,
    });

    const insertDecision = db.prepare(
      `INSERT INTO merge_decision(commit_id, subject_id, predicate, winner, loser, rule, reason, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ts = new Date().toISOString();
    for (const d of plan.decisions) {
      insertDecision.run(id, d.subject, d.predicate, d.winner, d.loser, d.rule, d.reason, ts);
    }
    db.prepare('UPDATE resolution SET applied = 1 WHERE applied = 0').run();
    db.prepare('UPDATE merge_conflict SET resolved = 1 WHERE resolved = 0').run();
    return id;
  });

  const commitId = apply();

  console.log(pc.green(`  merged → ${commitId}`));
  console.log(pc.dim(`  +${plan.add.length} added, -${plan.retract.length} retracted, ${plan.decisions.length} resolved`));
  printDecisions(plan.decisions);
  db.close();
}
