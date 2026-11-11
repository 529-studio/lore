import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { extractAll, hashFile, type Candidate } from '../extract/index.js';
import { activeAt, head, makeCommit, upsertClaim } from '../model.js';
import { branchFor, currentSession } from '../session.js';

function evidenceRef(c: Candidate): string {
  if (c.subject.startsWith('file:')) return c.subject.slice(5);
  if (c.subject.startsWith('doc:')) return c.subject.slice(4);
  if (c.subject.startsWith('pkg:')) return 'package.json';
  if (c.subject.startsWith('env:')) return c.object;
  return c.subject;
}

export function ingestCommand(opts: { author?: string; session?: string; dryRun?: boolean; quiet?: boolean }): void {
  const root = requireRoot();
  const db = openDb(root);
  const session = currentSession(root, opts.session);
  const ref = branchFor(session);
  const candidates = extractAll(root);

  if (opts.dryRun) {
    for (const c of candidates) console.log(`${c.subject} | ${c.predicate} | ${c.object}`);
    console.log(pc.dim(`\n${candidates.length} candidates (dry run, nothing written)`));
    db.close();
    return;
  }

  const apply = db.transaction(() => {
    const present = activeAt(db, head(db, ref) ?? head(db, 'main'));
    const inserted: string[] = [];
    const byPredicate = new Map<string, number>();

    for (const c of candidates) {
      const evRef = c.evidenceRef ?? evidenceRef(c);
      const result = upsertClaim(db, {
        subject: c.subject,
        predicate: c.predicate,
        object: c.object,
        confidence: c.confidence,
        author: opts.author ?? 'lore:ingest',
        evidence: [{ kind: 'file', ref: evRef, hash: hashFile(root, evRef) }],
      });
      // Re-observation on a fresh branch must still record the claim in that branch.
      if (result.state === 'active' && !present.has(result.id)) {
        inserted.push(result.id);
        present.set(result.id, 'add');
        byPredicate.set(c.predicate, (byPredicate.get(c.predicate) ?? 0) + 1);
      }
    }

    if (inserted.length) {
      makeCommit(db, {
        ref,
        entries: inserted.map((id) => ({ claim_id: id, op: 'add' as const })),
        message: `import: ${inserted.length} claims from deterministic extractors`,
        author: opts.author ?? 'lore:ingest',
        kind: 'import',
      });
    }

    return { inserted, byPredicate };
  });

  const { inserted, byPredicate } = apply();

  console.log(
    `${pc.green('+')} ${pc.bold(String(inserted.length))} new claims ${pc.dim(`(${candidates.length} candidates scanned)`)}`,
  );
  for (const [predicate, count] of [...byPredicate.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pc.dim('•')} ${predicate.padEnd(22)} ${count}`);
  }
  if (inserted.length) {
    console.log(pc.dim(`\nbranch ${ref} — ${inserted.length} claims in active set (authority T1: file hash)`));
  } else {
    console.log(pc.dim('memory already up to date'));
  }
  db.close();
}
