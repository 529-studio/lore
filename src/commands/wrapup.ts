import { createInterface } from 'node:readline';
import process from 'node:process';
import path from 'node:path';
import pc from 'picocolors';
import { openDb, requireRoot, type DB } from '../db.js';
import { head, makeCommit, type ClaimRow } from '../model.js';
import { planMerge } from '../merge.js';
import { loadOntology } from '../ontology.js';
import { branchFor, ensureSession, rotateSession } from '../session.js';
import { requireAction } from '../policy.js';
import { approveDrafts } from '../actions.js';
import { loadPending } from './promote.js';
import { runSessionHook } from '../plugins/loader.js';

export interface WrapupOptions {
  root?: string;
  session?: string;
  into?: string;
  yes?: boolean;
  rotate?: boolean;
  dryRun?: boolean;
}

function objectOf(row: ClaimRow): string {
  try {
    return String(JSON.parse(row.object_json));
  } catch {
    return row.object_json;
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes');
    });
  });
}

export async function wrapupCommand(opts: WrapupOptions = {}): Promise<void> {
  const root = path.resolve(opts.root ?? requireRoot());
  const db = openDb(root);
  const into = opts.into ?? 'main';
  const session = ensureSession(db, root, opts.session);
  const fromRef = branchFor(session);

  const draftStmt = opts.session
    ? db.prepare("SELECT * FROM claim WHERE session_id = ? AND state = 'draft' ORDER BY tx_from ASC")
    : db.prepare("SELECT * FROM claim WHERE (session_id = ? OR session_id IS NULL) AND state = 'draft' ORDER BY tx_from ASC");
  const drafts = (opts.session ? draftStmt.all(opts.session) : draftStmt.all(session)) as ClaimRow[];

  let fromTip = head(db, fromRef);
  const intoTip = head(db, into);

  if (!drafts.length && (!fromTip || fromTip === intoTip)) {
    console.log(`${pc.green('[OK]')} Session ${pc.bold(session)} is clean. Nothing to wrap up.`);
    db.close();
    return;
  }

  console.log(pc.bold(`lore wrapup — session ${session} → ${into}`));
  console.log(`  branch:     ${pc.bold(fromRef)}`);
  console.log(`  target:     ${pc.bold(into)}`);
  console.log(`  drafts:     ${drafts.length ? pc.yellow(String(drafts.length)) : pc.green('0')}`);

  if (drafts.length > 0) {
    console.log(pc.dim('\n  Drafts to approve:'));
    for (const d of drafts) {
      const obj = objectOf(d);
      console.log(
        `    ${pc.yellow('+')} ${pc.bold(d.subject_id)} ${pc.dim('—')} ${d.predicate}: ${pc.dim(obj)} (T${d.authority} ${d.author})`,
      );
    }
  }

  if (opts.dryRun) {
    console.log(pc.dim(`\n  dry run: would approve ${drafts.length} draft(s) and merge ${fromRef} into ${into}`));
    db.close();
    return;
  }

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      console.log(pc.yellow(`\n[WARN] Non-interactive environment. Run with --yes to approve and promote.`));
      db.close();
      return;
    }
    const ok = await confirm(`\nApprove ${drafts.length} draft(s) and merge into ${into}? [Y/n] `);
    if (!ok) {
      console.log(pc.dim('Aborted.'));
      db.close();
      return;
    }
  }

  // Authorize the promotion before approving drafts: a denied wrapup must not
  // leave the branch half-approved.
  const promotePrincipal = requireAction(root, 'promote');

  // 1. Approve drafts
  if (drafts.length > 0) {
    const draftIds = drafts.map((d) => d.id);
    const approved = approveDrafts(db, root, fromRef, draftIds);
    console.log(`  ${pc.green('[OK]')} Approved ${approved.changed.length} draft(s) onto ${pc.bold(fromRef)}`);
    fromTip = head(db, fromRef);
  }

  // 2. Promote branch into target (main)
  if (!fromTip) {
    console.log(pc.dim(`  nothing to merge into ${into}`));
  } else {
    const plan = planMerge(db, root, intoTip, fromTip, {
      strategy: 'authority',
      strict: false,
      ontology: loadOntology(root),
      pendingResolution: loadPending(db),
    });

    if (plan.mode === 'up-to-date') {
      console.log(pc.dim(`  ${into} is already up to date with ${fromRef}`));
    } else if (plan.mode === 'fast-forward') {
      // Moving main is a promotion, authorized before approval above.
      db.prepare(
        'INSERT INTO ref(name, commit_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET commit_id = excluded.commit_id',
      ).run(into, fromTip);
      console.log(`  ${pc.green('[OK]')} Fast-forwarded ${pc.bold(into)} → ${fromTip}`);
    } else if (plan.mode === 'conflict') {
      console.log(pc.red(`\n[ERR] ABORT — ${plan.conflicts.length} unresolved conflict(s) between ${into} and ${fromRef}:`));
      for (const c of plan.conflicts) {
        console.log(`  ${pc.bold(c.subject)} ${pc.dim('—')} ${pc.bold(c.predicate)}`);
      }
      console.log(pc.dim(`\nResolve conflicts with 'lore resolve' before re-running wrapup.`));
      process.exitCode = 2;
      db.close();
      return;
    } else {
      db.transaction(() => {
        const id = makeCommit(db, {
          ref: into,
          entries: [
            ...plan.add.map((claim_id) => ({ claim_id, op: 'add' as const })),
            ...plan.retract.map((claim_id) => ({ claim_id, op: 'retract' as const })),
          ],
          message: `wrapup: merge ${fromRef} into ${into}`,
          author: `human:${promotePrincipal.id}`,
          kind: 'merge',
          mergeParent: fromTip,
        });
        const insert = db.prepare(
          `INSERT INTO merge_decision(commit_id, subject_id, predicate, winner, loser, rule, reason, actor, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const now = new Date().toISOString();
        for (const d of plan.decisions) {
          insert.run(id, d.subject, d.predicate, d.winner, d.loser, d.rule, d.reason, `human:${promotePrincipal.id}`, now);
        }
      })();
      console.log(
        `  ${pc.green('[OK]')} Merged ${pc.bold(fromRef)} into ${pc.bold(into)} (+${plan.add.length} / -${plan.retract.length})`,
      );
    }
  }

  // 3. Rotate session
  if (opts.rotate !== false) {
    const newSession = rotateSession(root);
    console.log(`  ${pc.green('[OK]')} Rotated session to ${pc.bold(newSession)}`);
  }

  console.log(`\n${pc.green('[OK]')} Wrapup complete. Session memory successfully integrated.`);
  db.close();
  runSessionHook(
    'afterWrapup',
    { workspaceRoot: path.resolve(root), session, into },
    (message) => console.error(`[WARN] ${message}`),
  );
}
