import pc from 'picocolors';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { openDb, requireRoot, type DB } from '../db.js';
import { ensureConfig, readConfig, writeConfig, type LoreConfig } from '../config.js';
import { buildDeltaBundle, importBundle } from '../sync.js';
import { approveDrafts, ActionError } from '../actions.js';
import { policyPath, requireAction } from '../policy.js';
import { branchFor } from '../session.js';
import { promoteRef } from './promote.js';
import {
  httpProposal,
  httpProposals,
  httpPromoteProposal,
  httpReviewProposal,
  type HttpRemote,
  type ProposalMeta,
} from '../remotes/http.js';
import { pullHub } from '../remotes/hub.js';

export interface ProposalsOptions {
  action?: string;
  target?: string;
  note?: string;
  status?: string;
  session?: string;
}

function hubRemote(config: LoreConfig): HttpRemote {
  if (!config.remote) throw new Error('no remote configured; run: lore remote --hub <url>');
  if (config.remote.type !== 'http') {
    throw new Error('proposals live on lore-hub; configure an http remote with lore remote --hub <url>');
  }
  return config.remote;
}

function policyText(root: string): string | null {
  const file = policyPath(root);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** `user/session`, split at the last slash so emails and scoped ids stay intact. */
export function parseProposalTarget(target: string): { user: string; session: string } {
  const slash = target.lastIndexOf('/');
  if (slash <= 0 || slash === target.length - 1) {
    throw new Error(`expected <user>/<session>, got ${target}`);
  }
  return { user: target.slice(0, slash), session: target.slice(slash + 1) };
}

function printProposal(proposal: ProposalMeta): void {
  const status =
    proposal.status === 'open'
      ? pc.yellow('open')
      : proposal.status === 'approved'
        ? pc.green('approved')
        : proposal.status === 'promoted'
          ? pc.blue('promoted')
          : pc.red('rejected');
  console.log(
    `  ${status.padEnd(8)} ${pc.bold(`${proposal.user}/${proposal.session}`)}  ` +
      pc.dim(`tip ${proposal.tip?.slice(0, 12) ?? 'none'}  base ${proposal.base_main?.slice(0, 12) ?? 'none'}  ` +
        `${proposal.claims} claim(s) ${proposal.commits} commit(s)  updated ${proposal.updated_at.slice(0, 16)}`),
  );
  console.log(pc.dim(`           ${proposal.ref}${proposal.note ? `  note: ${proposal.note}` : ''}`));
}

async function listCommand(root: string, status?: string): Promise<void> {
  const config = ensureConfig(root);
  const remote = hubRemote(config);
  const proposals = await httpProposals(remote, config.repo_id, status ?? null);
  if (!proposals.length) {
    console.log(pc.dim(status ? `no ${status} proposals` : 'no proposals'));
    return;
  }
  console.log(pc.bold(`${proposals.length} proposal(s)`));
  for (const proposal of proposals) printProposal(proposal);
}

async function reviewCommand(root: string, target: string, action: 'approve' | 'reject', note?: string): Promise<void> {
  const config = ensureConfig(root);
  const remote = hubRemote(config);
  const { user, session } = parseProposalTarget(target);
  const proposal = await httpReviewProposal(remote, config.repo_id, { user, session, action, note });
  console.log(`${pc.green('[OK]')} ${action === 'approve' ? 'approved' : 'rejected'} ${proposal.ref} (${proposal.status})`);
  if (action === 'approve') console.log(pc.dim(`  promote it with: lore proposals promote ${user}/${session}`));
}

function claimLines(bundle: { claims?: Array<Record<string, unknown>> }): string[] {
  const lines: string[] = [];
  for (const claim of bundle.claims ?? []) {
    const state = String(claim.state ?? '');
    // Drafts are the reason a proposal exists: make them obvious.
    if (state !== 'draft') continue;
    let object = String(claim.object_json ?? '');
    try {
      object = String(JSON.parse(object));
    } catch {
      /* keep raw */
    }
    lines.push(`    draft ${String(claim.id)}  ${String(claim.subject_id)} — ${String(claim.predicate)}: ${object}`);
  }
  return lines;
}

async function promoteCommand(root: string, db: DB, target: string): Promise<void> {
  const config = ensureConfig(root);
  const remote = hubRemote(config);
  const { user, session } = parseProposalTarget(target);
  const principal = requireAction(root, 'promote');
  const author = `human:${principal.id}`;

  // One pull defines the main this promotion is allowed to build on.
  const pulled = await pullHub(db, root, remote, readConfig(root) ?? config, author);
  const hubMain = pulled.main;

  const { proposal, bundle } = await httpProposal(remote, config.repo_id, user, session);
  if (proposal.status !== 'approved') {
    throw new Error(`proposal ${proposal.ref} is ${proposal.status}; approve it first with lore proposals approve ${user}/${session}`);
  }

  importBundle(db, root, bundle, { author });
  const ref = bundle.refs[0]?.name ?? branchFor(session);
  const draftIds = (bundle.claims ?? [])
    .filter((claim) => claim.state === 'draft')
    .map((claim) => String(claim.id ?? ''))
    .filter(Boolean);
  let approved = 0;
  if (draftIds.length) {
    try {
      approved = approveDrafts(db, root, ref, draftIds).changed.length;
    } catch (error) {
      if (error instanceof ActionError) throw new Error(error.message);
      throw error;
    }
  }

  const merged = promoteRef(db, root, ref, 'main', {
    author,
    message: `promote proposal ${proposal.ref} into main`,
  });
  if (merged.mode === 'conflict') {
    console.log(pc.red(`\n  ABORT — ${merged.plan.conflicts.length} unresolved conflict(s) in the proposal`));
    for (const conflict of merged.plan.conflicts) {
      console.log(`\n  ${pc.bold(conflict.subject)} ${pc.dim('—')} ${pc.bold(conflict.predicate)}`);
      console.log(`    main   ${conflict.ours?.id ?? '(absent)'}`);
      console.log(`    ${ref} ${conflict.theirs?.id ?? '(absent)'}`);
    }
    console.log(pc.dim('\n  lore resolve ... then re-run: lore proposals promote'));
    process.exitCode = 2;
    db.close();
    return;
  }

  const delta = buildDeltaBundle(db, config.repo_id, hubMain);
  const result = await httpPromoteProposal(remote, config.repo_id, {
    user,
    session,
    expectedMain: hubMain,
    bundle: delta,
    policy: policyText(root),
  });
  writeConfig(root, {
    ...readConfig(root),
    repo_id: config.repo_id,
    hub_main: result.main,
    hub_seq: result.seq,
    hub_auth_seq: result.auth_seq,
  });

  console.log(`${pc.green('[OK]')} promoted ${proposal.ref} → main ${result.main?.slice(0, 12)}`);
  console.log(
    pc.dim(`  ${approved} draft(s) approved, merge ${merged.mode}, ${delta.claims.length} claim(s) published`),
  );
  db.close();
}

/**
 * Interactive remote review: inspect each open proposal and approve or reject
 * the review decision. Promotion stays an explicit, separate command.
 */
export async function reviewRemoteCommand(root: string): Promise<void> {
  const config = ensureConfig(root);
  const remote = hubRemote(config);
  const proposals = await httpProposals(remote, config.repo_id, 'open');
  if (!proposals.length) {
    console.log(pc.dim('no open proposals'));
    return;
  }

  const bundles = new Map<string, { claims?: Array<Record<string, unknown>> }>();
  for (const proposal of proposals) {
    const detail = await httpProposal(remote, config.repo_id, proposal.user, proposal.session);
    bundles.set(`${proposal.user}/${proposal.session}`, detail.bundle);
  }

  console.log(pc.bold(`lore review --remote — ${proposals.length} open proposal(s)`));
  for (const proposal of proposals) {
    printProposal(proposal);
    for (const line of claimLines(bundles.get(`${proposal.user}/${proposal.session}`) ?? {})) console.log(pc.dim(line));
  }

  if (!process.stdin.isTTY) {
    console.log(pc.dim('\nnon-interactive: nothing changed; run `lore proposals approve <user>/<session>`'));
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const proposal of proposals) {
      const id = `${proposal.user}/${proposal.session}`;
      const answer = (await rl.question(`\n${id}  [a]pprove  [r]eject  [s]kip  [q]uit > `)).trim().toLowerCase();
      if (answer === 'q') break;
      if (answer !== 'a' && answer !== 'r') continue;
      const note = answer === 'r' ? (await rl.question('  reason (optional): ')).trim() : '';
      const updated = await httpReviewProposal(remote, config.repo_id, {
        user: proposal.user,
        session: proposal.session,
        action: answer === 'a' ? 'approve' : 'reject',
        note: note || null,
      });
      console.log(pc.green(`  ${updated.status}`));
    }
  } finally {
    rl.close();
  }
  console.log(pc.dim('\npromote an approved proposal with: lore proposals promote <user>/<session>'));
}

export async function proposalsCommand(opts: ProposalsOptions): Promise<void> {
  const root = requireRoot();
  const action = opts.action ?? 'list';
  if (action === 'list') {
    await listCommand(root, opts.status);
    return;
  }
  if (!['approve', 'reject', 'promote'].includes(action)) {
    throw new Error('usage: lore proposals list|approve|reject|promote [<user>/<session>]');
  }
  if (!opts.target) throw new Error(`lore proposals ${action} needs <user>/<session>; run lore proposals list`);
  if (action === 'promote') {
    const db = openDb(root);
    try {
      await promoteCommand(root, db, opts.target);
    } finally {
      if (db.open) db.close();
    }
    return;
  }
  await reviewCommand(root, opts.target, action as 'approve' | 'reject', opts.note);
}
