import pc from 'picocolors';
import { openDb, requireRoot } from '../db.js';
import { explainTarget, type ClaimExplanation } from '../canon/explain.js';

export interface ExplainOptions {
  json?: boolean;
}

const AUTHORITY: Record<number, string> = {
  0: 'T0 (test)',
  1: 'T1 (file/command)',
  2: 'T2 (human)',
  3: 'T3 (verified)',
  4: 'T4 (inference)',
};

function age(days: number | null): string {
  if (days === null) return 'never';
  if (days === 0) return 'today';
  return `${days}d ago`;
}

function shortHash(hash: string | null): string {
  if (!hash) return '(no hash)';
  return hash.length > 19 ? `${hash.slice(0, 19)}…` : hash;
}

function printClaim(c: ClaimExplanation): void {
  const state = c.state === 'active' ? pc.green(c.state) : c.state === 'draft' ? pc.yellow(c.state) : pc.red(c.state);
  const trust =
    c.trust === 'canonical'
      ? pc.green(c.trust)
      : c.trust === 'contested' || c.trust === 'stale'
        ? pc.red(c.trust)
        : pc.yellow(c.trust);

  console.log(pc.bold(c.id));
  console.log(`  subject    ${pc.cyan(c.subject)}`);
  console.log(`  predicate  ${pc.bold(c.predicate)}`);
  console.log(`  object     ${c.object}`);
  console.log(`  state      ${state}  ${pc.dim(c.in_branch ? `in ${c.branch}` : `not in ${c.branch}`)}`);
  console.log(`  trust      ${trust}`);
  console.log(`  why        ${c.trust_reason}`);
  console.log(
    `  written by ${c.written_by} via ${c.author}  ${pc.dim(
      `agent ${c.agent_id ?? '-'}  session ${c.session_id ?? '-'}  run ${c.run_id ?? '-'}`,
    )}`,
  );
  console.log(
    `  time       tx ${c.tx_from} (${age(Math.max(0, Math.round((Date.now() - Date.parse(c.tx_from)) / 86_400_000)))}), ` +
      `valid ${c.valid_from ?? '-'} .. ${c.valid_to ?? '-'}, verified ${age(c.verified_age_days)}`,
  );
  console.log(
    `  confidence ${c.confidence}  authority ${AUTHORITY[c.authority] ?? `T${c.authority}`}  ` +
      `confirmations ${c.confirmations}  contradictions ${c.contradictions}`,
  );
  console.log(`  evidence   ${c.valid_evidence} valid, ${c.stale_evidence} stale`);
  if (!c.evidence.length) {
    console.log(pc.dim('    (no evidence)'));
  } else {
    for (const e of c.evidence) {
      console.log(
        pc.dim(
          `    ${e.kind}:${e.ref}  ${shortHash(e.hash)}  commit ${e.commit_id ?? '-'}  ` +
            `verified ${age(e.age_days)}  ${e.status}`,
        ),
      );
    }
  }
  console.log(`  freshness  ${c.freshness}${c.open_conflicts ? pc.red(`  open conflicts ${c.open_conflicts}`) : ''}`);
  if (c.supersedes.length) {
    console.log(`  supersedes ${c.supersedes.map((s) => `${s.id} (${s.object})`).join(' <- ')}`);
  } else {
    console.log(pc.dim('  supersedes none'));
  }
  if (c.superseded_by.length) console.log(`  superseded by ${c.superseded_by.join(', ')}`);
  for (const conflict of c.conflicts) {
    const status = conflict.resolved ? pc.dim('resolved') : pc.red('open');
    console.log(
      `  conflict   #${conflict.id} tier ${conflict.tier} ${status} with ${conflict.with}` +
        pc.dim(`  ${conflict.reason}`),
    );
  }
}

/** lore explain — why a claim is (or is not) injected. */
export function explainCommand(target: string, opts: ExplainOptions = {}): void {
  const root = requireRoot();
  const db = openDb(root);

  const result = explainTarget(db, root, target);
  db.close();

  if (opts.json) {
    console.log(JSON.stringify({ schema: 1, ...result }, null, 2));
    return;
  }

  console.log(pc.bold(`lore explain ${result.target}`));
  console.log('');
  result.claims.forEach((claim, i) => {
    if (i) console.log(pc.dim('  —'));
    printClaim(claim);
  });
}
