import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { ActionError, approveDrafts, rejectDraft } from '../actions.js';
import { evidenceFor, type ClaimRow } from '../model.js';
import { resolvePrincipal } from '../identity.js';
import { describePolicy } from '../policy.js';
import { branchFor, ensureSession } from '../session.js';

export interface ReviewOptions {
  all?: boolean;
  session?: string;
  limit?: string;
}

function objectOf(row: ClaimRow): string {
  try {
    return String(JSON.parse(row.object_json));
  } catch {
    return row.object_json;
  }
}

function printDraft(db: import('../db.js').DB, row: ClaimRow, index: number, total: number): void {
  console.log(`\n${pc.dim(`[${index}/${total}]`)} ${pc.bold(row.subject_id)} ${pc.dim('—')} ${row.predicate}`);
  console.log(`  ${objectOf(row)}`);
  console.log(pc.dim(`  ${row.id}  T${row.authority}  conf ${row.confidence.toFixed(2)}  ${row.author}`));
  for (const ev of evidenceFor(db, row.id)) {
    console.log(pc.dim(`  ↳ ${ev.kind}:${ev.ref} ${ev.status}`));
  }
}

export async function reviewCommand(opts: ReviewOptions): Promise<void> {
  const root = requireRoot();
  const db = openDb(root);
  const session = ensureSession(db, root, opts.session);
  const ref = branchFor(session);
  const principal = resolvePrincipal();

  const limit = Number(opts.limit ?? 100);
  const drafts = db
    .prepare("SELECT * FROM claim WHERE state = 'draft' ORDER BY tx_from ASC, rowid ASC LIMIT ?")
    .all(limit) as ClaimRow[];

  if (!drafts.length) {
    console.log(pc.green('nothing to review — no draft claims'));
    db.close();
    return;
  }

  console.log(pc.bold(`lore review — ${drafts.length} draft(s)`));
  console.log(pc.dim(`  ${principal.id} (${principal.role})  ·  ${describePolicy(root)}`));

  // A TTY gets prompts; a pipe gets its lines consumed as answers. Empty stdin
  // (for example in CI) prints the queue and changes nothing.
  let rl: ReturnType<typeof createInterface> | null = null;
  let piped: string[] = [];
  let cursor = 0;

  if (process.stdin.isTTY) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
  } else {
    const input = readFileSync(0, 'utf8');
    if (!input.trim()) {
      drafts.forEach((row, index) => printDraft(db, row, index + 1, drafts.length));
      console.log(pc.dim('\nnon-interactive: nothing changed; run `lore approve <id>` or `lore review --all`'));
      db.close();
      return;
    }
    piped = input.split(/\r?\n/).map((line) => line.trim());
  }

  const ask = async (prompt: string): Promise<string> => {
    if (rl) return rl.question(prompt);
    return piped[cursor++] ?? '';
  };
  let approved = 0;
  let rejected = 0;
  let skipped = 0;

  try {
    if (opts.all) {
      const answer = (await ask(`approve all ${drafts.length} draft(s) as ${principal.id}? [y/N] `))
        .trim()
        .toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        console.log(pc.yellow('aborted'));
        return;
      }
      try {
        const result = approveDrafts(db, root, ref, drafts.map((row) => row.id));
        approved = result.changed.length;
        console.log(pc.green(`✓ approved ${approved} claim(s)`));
      } catch (error) {
        if (error instanceof ActionError) console.log(pc.red(`[ERR] ${error.message}`));
        else throw error;
      }
      return;
    }

    for (let index = 0; index < drafts.length; index += 1) {
      const row = drafts[index];
      printDraft(db, row, index + 1, drafts.length);
      const answer = (await ask('  [a]pprove  [r]eject  [s]kip  [q]uit > ')).trim().toLowerCase();

      if (answer === 'q') break;
      if (answer === 's' || answer === '') {
        skipped += 1;
        continue;
      }
      if (answer === 'a') {
        try {
          approveDrafts(db, root, ref, [row.id]);
          approved += 1;
          console.log(pc.green('  ✓ approved'));
        } catch (error) {
          if (error instanceof ActionError) console.log(pc.red(`  [ERR] ${error.message}`));
          else throw error;
        }
        continue;
      }
      if (answer === 'r') {
        const reason = (await ask('  reason (optional): ')).trim();
        try {
          rejectDraft(db, root, ref, row.id, reason || undefined);
          rejected += 1;
          console.log(pc.green('  ✓ rejected'));
        } catch (error) {
          if (error instanceof ActionError) console.log(pc.red(`  [ERR] ${error.message}`));
          else throw error;
        }
        continue;
      }
      console.log(pc.yellow('  unknown key, skipped'));
      skipped += 1;
    }
  } finally {
    rl?.close();
  }

  console.log(
    `\n${pc.bold('summary')}  ${pc.green(`${approved} approved`)}  ${pc.red(`${rejected} rejected`)}  ${pc.dim(`${skipped} skipped`)}`,
  );
  if (approved) console.log(pc.dim('  run `lore promote` when the branch is ready'));
  db.close();
}
