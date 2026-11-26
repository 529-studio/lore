import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import {
  gcCandidates,
  tombstoneCandidates,
  purgeTombstones,
  compactDatabase,
  getDatabaseStorageStats,
} from '../gc.js';
import { runClaimRetractHooks } from '../model.js';
import { ensureSession } from '../session.js';
import { pruneHashCache } from '../hash-cache.js';
import { requireAction } from '../policy.js';

export interface GcOptions {
  root?: string;
  ttlSessions?: string;
  ttlDays?: string;
  purgeTombstones?: boolean;
  tombstoneTtlDays?: string;
  compact?: boolean;
  dryRun?: boolean;
  session?: string;
}

export function gcCommand(opts: GcOptions): void {
  const root = opts.root ?? requireRoot();
  const db = openDb(root);
  ensureSession(db, root, opts.session);

  const policy = {
    ttlSessions: Number(opts.ttlSessions ?? 3),
    ...(opts.ttlDays !== undefined ? { ttlDays: Number(opts.ttlDays) } : {}),
  };

  const draftCandidates = gcCandidates(db, policy);
  const tombstoneList = opts.purgeTombstones
    ? tombstoneCandidates(db, {
        tombstoneTtlDays: opts.tombstoneTtlDays !== undefined ? Number(opts.tombstoneTtlDays) : 30,
      })
    : [];

  const initialStats = getDatabaseStorageStats(db);

  if (!draftCandidates.length && !tombstoneList.length && !opts.compact) {
    console.log(pc.dim('no draft claims eligible for GC'));
    if (opts.purgeTombstones) {
      console.log(pc.dim('no tombstones eligible for purge'));
    }
    db.close();
    return;
  }

  if (opts.dryRun) {
    if (draftCandidates.length) {
      console.log(`${draftCandidates.length} draft(s) would be retracted:`);
      for (const c of draftCandidates) console.log(pc.dim(`  ${c.id}  ${c.subject} — ${c.predicate}  (${c.reason})`));
    } else {
      console.log(pc.dim('no draft claims eligible for GC'));
    }

    if (opts.purgeTombstones) {
      if (tombstoneList.length) {
        console.log(`${tombstoneList.length} tombstone(s) would be purged permanently:`);
        for (const t of tombstoneList) console.log(pc.dim(`  ${t.id}  ${t.subject} — ${t.predicate}  (${t.reason})`));
      } else {
        console.log(pc.dim('no tombstones eligible for purge'));
      }
    }

    if (opts.compact || initialStats.freelistPages > 0) {
      console.log(
        pc.dim(
          `  storage: ${initialStats.pageCount} pages, ${initialStats.freelistPages} freelist page(s) (~${Math.round(initialStats.freelistBytes / 1024)} KB reclaimable)`,
        ),
      );
    }
    db.close();
    return;
  }

  // Authorize the destructive part before retracting drafts: a denied purge
  // must not leave the invocation half-applied.
  if (opts.purgeTombstones && tombstoneList.length) requireAction(root, 'purge');

  if (draftCandidates.length) {
    const update = db.prepare("UPDATE claim SET state = 'retracted', trust = 'retracted' WHERE id = ?");
    db.transaction(() => {
      for (const c of draftCandidates) {
        update.run(c.id);
        runClaimRetractHooks(db, c.id, 'lore:gc');
      }
    })();
    console.log(`${pc.green('✓')} retracted ${draftCandidates.length} stale draft(s); rows are kept`);
    for (const c of draftCandidates.slice(0, 10)) {
      console.log(pc.dim(`  ${c.id}  ${c.subject} — ${c.predicate}  (${c.reason})`));
    }
    if (draftCandidates.length > 10) console.log(pc.dim(`  … and ${draftCandidates.length - 10} more`));
  } else {
    console.log(pc.dim('no draft claims eligible for GC'));
  }

  if (opts.purgeTombstones) {
    if (tombstoneList.length) {
      const purged = purgeTombstones(db, tombstoneList, 'lore:gc');
      console.log(
        `${pc.green('✓')} purged ${purged} tombstone(s) older than ${opts.tombstoneTtlDays ?? 30} day(s); recorded in purge_audit`,
      );
      for (const t of tombstoneList.slice(0, 10)) {
        console.log(pc.dim(`  ${t.id}  ${t.subject} — ${t.predicate}  (${t.reason})`));
      }
      if (tombstoneList.length > 10) console.log(pc.dim(`  … and ${tombstoneList.length - 10} more`));
    } else {
      console.log(pc.dim('no tombstones eligible for purge'));
    }
  }

  const pruned = pruneHashCache(db);
  if (pruned) console.log(pc.dim(`  pruned ${pruned} hash-cache row(s) older than 30 days`));

  if (opts.compact || (opts.purgeTombstones && tombstoneList.length > 0)) {
    const comp = compactDatabase(db);
    console.log(
      `${pc.green('✓')} compacted database: reclaimed ${comp.reclaimedPages} page(s) (~${Math.round(comp.reclaimedBytes / 1024)} KB)`,
    );
  }

  db.close();
}
