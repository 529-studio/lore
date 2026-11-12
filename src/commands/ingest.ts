import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { extractAll, type Candidate } from '../extract/index.js';
import { activeAt, head, makeCommit, upsertClaim } from '../model.js';
import { hashCache } from '../hash-cache.js';
import { SecretDetected } from '../secrets.js';
import { gitHead } from '../util/git.js';
import { gateTier } from '../policy.js';
import { branchFor, currentSession, ensureSession } from '../session.js';

function evidenceRef(c: Candidate): string {
  if (c.subject.startsWith('file:')) return c.subject.slice(5).split('#')[0];
  if (c.subject.startsWith('doc:')) return c.subject.slice(4).split('#')[0];
  if (c.subject.startsWith('sym:')) return c.subject.slice(4).split('#')[0];
  if (c.subject.startsWith('pkg:')) return 'package.json';
  if (c.subject.startsWith('env:')) return c.object;
  return c.subject;
}

export function ingestCommand(opts: { author?: string; session?: string; dryRun?: boolean; quiet?: boolean }): void {
  const root = requireRoot();
  const db = openDb(root);
  const session = ensureSession(db, root, opts.session);
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
    const cache = hashCache(db, root);
    const gated = gateTier(root, 1);
    const inserted: string[] = [];
    const byPredicate = new Map<string, number>();
    const blocked: Array<{ subject: string; detail: string }> = [];

    for (const c of candidates) {
      const evRef = c.evidenceRef ?? evidenceRef(c);
      let result;
      try {
        result = upsertClaim(db, {
        subject: c.subject,
        predicate: c.predicate,
        object: c.object,
        confidence: c.confidence,
        author: opts.author ?? 'lore:ingest',
          evidence: [{ kind: 'file', ref: evRef, hash: cache.hash(evRef), commit: gitHead(root) }],
          forceDraft: gated,
        });
      } catch (error) {
        if (error instanceof SecretDetected) {
          blocked.push({ subject: c.subject, detail: error.message });
          continue;
        }
        throw error;
      }
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

    return { inserted, byPredicate, blocked };
  });

  const { inserted, byPredicate, blocked } = apply();

  console.log(
    `${pc.green('+')} ${pc.bold(String(inserted.length))} new claims ${pc.dim(`(${candidates.length} candidates scanned)`)}`,
  );
  for (const [predicate, count] of [...byPredicate.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pc.dim('•')} ${predicate.padEnd(22)} ${count}`);
  }
  if (blocked.length) {
    console.log(pc.red(`\n${blocked.length} candidate(s) blocked by the secret firewall:`));
    for (const b of blocked) console.log(pc.dim(`  ${b.subject}  ${b.detail}`));
    console.log(pc.dim('  nothing was stored for these candidates'));
    process.exitCode = 1;
  }
  if (inserted.length) {
    console.log(pc.dim(`\nbranch ${ref} — ${inserted.length} claims in active set (authority T1: file hash)`));
  } else {
    console.log(pc.dim('memory already up to date'));
  }
  db.close();
}
