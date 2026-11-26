import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { extractAll, type Candidate } from '../extract/index.js';
import { activeAt, head, makeCommit, upsertClaim } from '../model.js';
import { hashCache } from '../hash-cache.js';
import { SecretDetected } from '../secrets.js';
import { gitHead } from '../util/git.js';
import { gateTier, PolicyError, requireWriteSubjects } from '../policy.js';
import { loadOntology } from '../ontology.js';
import { branchFor, currentSession, ensureSession } from '../session.js';
import { collectRepoExtractors } from '../plugins/loader.js';
import { promoteCommand } from './promote.js';

/**
 * The onboarding ingest runs on a fresh branch so it never promotes unrelated
 * work from a pre-existing `agent/onboard` ref or from the caller's session.
 */
export function createOnboardSession(): string {
  return `onboard_${randomUUID().slice(0, 8)}`;
}

/**
 * The file a candidate was observed in. `pkg:` has no path of its own — the
 * extractor must name the manifest it came from, because a monorepo has many.
 * Without one there is no file to hash, so the claim cannot become canonical
 * (docs/lessons/L07).
 */
function evidenceRef(c: Candidate): string | null {
  if (c.subject.startsWith('file:')) return c.subject.slice(5).split('#')[0];
  if (c.subject.startsWith('doc:')) return c.subject.slice(4).split('#')[0];
  if (c.subject.startsWith('sym:')) return c.subject.slice(4).split('#')[0];
  if (c.subject.startsWith('env:')) return c.object;
  return null;
}

/**
 * Publish the onboarding ingest baseline: fast-forward/merge `agent/onboard`
 * into `main` so every agent session forked from `main` inherits the knowledge.
 * Returns true when main moved. A contributor who cannot promote keeps the
 * baseline on its branch instead of failing onboarding.
 */
export function publishIngestBaseline(root: string, session: string): boolean {
  const db = openDb(root);
  const ref = branchFor(session);
  const tip = head(db, ref);
  const mainTip = head(db, 'main');
  db.close();
  if (!tip || tip === mainTip) return false;
  try {
    promoteCommand({ session });
    return true;
  } catch (error) {
    if (error instanceof PolicyError) {
      console.log(pc.yellow(`  baseline kept on ${ref}: ${error.message}`));
      return false;
    }
    throw error;
  }
}

export async function ingestCommand(
  opts: { root?: string; author?: string; session?: string; dryRun?: boolean; quiet?: boolean } = {},
): Promise<void> {
  const root = opts.root ? path.resolve(opts.root) : requireRoot();
  const db = openDb(root);
  const session = ensureSession(db, root, opts.session);
  const ref = branchFor(session);
  const plugin = await collectRepoExtractors(root);
  for (const warning of plugin.warnings) console.log(pc.yellow(`[WARN] ${warning}`));
  const candidates: Candidate[] = [
    ...extractAll(root),
    ...plugin.candidates.filter(
      (c) => typeof c.subject === 'string' && typeof c.predicate === 'string' && typeof c.object === 'string',
    ),
  ];

  if (opts.dryRun) {
    for (const c of candidates) console.log(`${c.subject} | ${c.predicate} | ${c.object}`);
    console.log(pc.dim(`\n${candidates.length} candidates (dry run, nothing written)`));
    db.close();
    return;
  }

  // Extraction is a bulk write: a contributor must not ingest a protected
  // subject. Check the whole candidate set before the first row is written.
  requireWriteSubjects(
    root,
    candidates.map((c) => c.subject),
  );

  const apply = db.transaction(() => {
    const present = activeAt(db, head(db, ref) ?? head(db, 'main'));
    const cache = hashCache(db, root);
    const gated = gateTier(root, 1);
    const ontology = loadOntology(root);
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
          evidence: evRef
            ? [{ kind: 'file' as const, ref: evRef, hash: cache.hash(evRef), commit: gitHead(root) }]
            : [],
          forceDraft: gated,
          writtenBy: 'agent',
          agentId: 'lore-ingest',
          sessionId: session,
          ttlDays: ontology.ttlDays(c.predicate),
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
