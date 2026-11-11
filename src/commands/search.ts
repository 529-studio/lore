import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { searchClaims } from '../retrieval.js';
import { evidenceFor } from '../model.js';

export interface SearchCommandOptions {
  query?: string;
  files?: string; // comma-separated paths
  symbols?: string; // comma-separated entity ids
  budget?: string; // token budget
  includeStale?: boolean;
  json?: boolean;
}

function list(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

/** lore search — score the active set against the task scope. */
export function searchCommand(opts: SearchCommandOptions): void {
  const root = requireRoot();
  const db = openDb(root);

  const hits = searchClaims(db, root, {
    query: opts.query,
    files: list(opts.files),
    symbols: list(opts.symbols),
    budgetTokens: opts.budget ? Number(opts.budget) : undefined,
    includeStale: opts.includeStale,
  });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          schema: 1,
          query: opts.query ?? null,
          budget_tokens: opts.budget ? Number(opts.budget) : 2000,
          hits: hits.map((h) => ({
            id: h.claim.id,
            subject: h.claim.subject_id,
            predicate: h.claim.predicate,
            object: h.claim.object_json,
            score: Number(h.score.toFixed(3)),
            reasons: h.reasons,
            stale: h.stale,
            evidence: evidenceFor(db, h.claim.id),
          })),
        },
        null,
        2,
      ),
    );
    db.close();
    return;
  }
  db.close();

  if (!hits.length) {
    console.log(pc.yellow('no hits — run `lore ingest` or widen the scope'));
    return;
  }

  console.log(`${hits.length} hit(s) ${pc.dim(`budget ${opts.budget ?? 2000} tok`)}`);
  hits.forEach((h, i) => {
    const c = h.claim;
    let object = c.object_json;
    try {
      object = String(JSON.parse(c.object_json));
    } catch {
      // keep raw json
    }
    const badge = h.stale ? pc.red(' STALE') : '';
    console.log(
      `  [${i + 1}] ${pc.bold(pc.green(h.score.toFixed(1)))}  ${pc.cyan(c.subject_id)} ${pc.dim('—')} ${pc.bold(
        c.predicate,
      )} ${pc.dim('—')} ${object}${badge}`,
    );
    console.log(pc.dim(`      ${c.id}  T${c.authority}  ${c.author}`));
    console.log(pc.dim(`      ${h.reasons.join('  ')}`));
  });
}
