import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { activeAt, claimsFor, evidenceFor, head } from '../model.js';
import { branchFor, ensureSession, recordReads } from '../session.js';

export function blameCommand(opts: { subject: string; predicate?: string }): void {
  const root = requireRoot();
  const db = openDb(root);
  const session = ensureSession(db, root);
  const ref = branchFor(session);
  const inBranch = activeAt(db, head(db, ref) ?? head(db, 'main'));
  const claims = claimsFor(db, opts.subject).filter(
    (c) => !opts.predicate || c.predicate === opts.predicate,
  );

  if (claims.length) recordReads(db, session, claims.map((c) => c.id));

  if (!claims.length) {
    const suggestions = db
      .prepare('SELECT DISTINCT subject_id FROM claim WHERE subject_id LIKE ? ORDER BY subject_id LIMIT 10')
      .all(`%${opts.subject}%`) as Array<{ subject_id: string }>;
    console.log(pc.yellow(`no claims for ${opts.subject}`));
    if (suggestions.length) {
      console.log(pc.dim('did you mean:'));
      for (const s of suggestions) console.log(pc.dim(`  ${s.subject_id}`));
    }
    db.close();
    return;
  }

  const bySubject = new Map<string, typeof claims>();
  for (const c of claims) {
    const list = bySubject.get(c.subject_id) ?? [];
    list.push(c);
    bySubject.set(c.subject_id, list);
  }

  for (const [subject, list] of bySubject) {
    console.log(pc.bold(pc.cyan(subject)));
    for (const c of list) {
      const state =
        c.state === 'draft'
          ? pc.yellow('draft')
          : inBranch.has(c.id)
            ? pc.green('active')
            : pc.dim('out-of-branch');
      const obj = (() => {
        try {
          return String(JSON.parse(c.object_json));
        } catch {
          return c.object_json;
        }
      })();
      console.log(`  ${pc.dim('•')} ${pc.bold(c.predicate)}: ${obj}`);
      console.log(
        pc.dim(
          `    ${c.id}  ${state}  T${c.authority}  conf ${c.confidence.toFixed(2)}  ${c.author}  ${c.tx_from.replace('T', ' ').slice(0, 16)}${c.valid_from ? `  valid_from ${c.valid_from.slice(0, 10)}` : ''}${c.valid_to ? `  -> valid_to ${c.valid_to.slice(0, 10)}` : ''}`,
        ),
      );
      for (const ev of evidenceFor(db, c.id)) {
        const badge = ev.status === 'valid' ? pc.green('valid') : pc.red(ev.status);
        console.log(pc.dim(`    ↳ ${ev.kind}:${ev.ref} `) + badge + pc.dim(ev.hash ? ` ${ev.hash.slice(0, 15)}…` : ''));
      }
    }
    console.log();
  }
  db.close();
}
