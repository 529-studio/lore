#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';
import pc from 'picocolors';
import { approveCommand } from './commands/approve.js';
import { blameCommand } from './commands/blame.js';
import { diffCommand } from './commands/diff.js';
import { gcCommand } from './commands/gc.js';
import { guardCommand } from './commands/guard.js';
import { identityCommand } from './commands/identity.js';
import { uiCommand } from './commands/ui.js';
import { attestCommand } from './commands/attest.js';
import { rejectCommand } from './commands/reject.js';
import { reviewCommand } from './commands/review.js';
import { onboardCommand } from './commands/onboard.js';
import { aliasCommand } from './commands/alias.js';
import { renameCommand } from './commands/rename.js';
import { digestCommand } from './commands/digest.js';
import { bundleCommand } from './commands/bundle.js';
import { fetchCommand } from './commands/fetch.js';
import { pushCommand } from './commands/push.js';
import { purgeCommand } from './commands/purge.js';
import { redactCommand } from './commands/redact.js';
import { remoteCommand } from './commands/remote.js';
import { exportCommand } from './commands/export.js';
import { ingestCommand } from './commands/ingest.js';
import { initCommand } from './commands/init.js';
import { logCommand } from './commands/log.js';
import { mcpCommand } from './commands/mcp.js';
import { mergeCommand } from './commands/merge.js';
import { promoteCommand } from './commands/promote.js';
import { resolveCommand } from './commands/resolve.js';
import { revertCommand } from './commands/revert.js';
import { statusCommand } from './commands/status.js';
import { supersedeCommand } from './commands/supersede.js';
import { searchCommand } from './commands/search.js';
import { explainCommand } from './commands/explain.js';
import { canonConfirmCommand, canonDecayCommand, canonMetricsCommand, canonStatusCommand } from './commands/canon.js';
import { verifyCommand } from './commands/verify.js';
import { writeCommand } from './commands/write.js';
import type { EvidenceKind } from './model.js';
import { installCanon } from './canon/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const program = new Command();

program
  .name('lore')
  .description('Git for what your agents know — versioned, verifiable memory')
  .version(pkg.version);

program
  .command('init')
  .description('initialise .lore/ in the current repository')
  .option('--root <path>', 'repository root (default: cwd)')
  .option('--no-gitignore', 'do not add .lore/ to .gitignore')
  .action((opts) => initCommand({ root: opts.root, gitignore: opts.gitignore }));

program
  .command('write')
  .description('write one claim (draft when evidence is agent/human)')
  .requiredOption('--subject <id>', 'entity id, vd file:src/a.ts, env:DATABASE_URL, sym:src/a.ts#fn')
  .requiredOption('--predicate <name>', 'vd read_by, declares_dependency')
  .requiredOption('--object <text>', 'claim value')
  .option('--kind <kind>', 'test|file|command|human|agent', 'file')
  .option('--ref <ref>', 'evidence source path (default: subject)')
  .option('--hash <hash>', 'evidence hash (computed for file/test)')
  .option('--confidence <n>', '0..1')
  .option('--author <id>', 'human:... or agent:...')
  .option('--session <id>', 'write to branch agent/<session>')
  .option('--valid-from <iso>', 'when the claim became true (default: immediately)')
  .option('--ttl-days <n>', 'decay after N days without re-verification (default: ontology)')
  .action((opts) =>
    writeCommand({
      subject: opts.subject,
      predicate: opts.predicate,
      object: opts.object,
      kind: opts.kind as EvidenceKind,
      ref: opts.ref,
      hash: opts.hash,
      confidence: opts.confidence,
      author: opts.author,
      session: opts.session,
      validFrom: opts.validFrom,
      ttlDays: opts.ttlDays,
    }),
  );

program
  .command('supersede <claim>')
  .description('replace a claim with a new version, keeping the old one in history')
  .requiredOption('--object <text>', 'new claim value')
  .option('--kind <kind>', 'test|file|command|human|agent', 'file')
  .option('--ref <ref>', 'evidence source (default: the claim id)')
  .option('--hash <hash>')
  .option('--confidence <n>')
  .option('--author <id>')
  .option('--session <id>')
  .option('--ttl-days <n>', 'override the inherited TTL in days')
  .action((claim, opts) =>
    supersedeCommand({
      claim,
      object: opts.object,
      kind: opts.kind as EvidenceKind,
      ref: opts.ref,
      hash: opts.hash,
      confidence: opts.confidence,
      author: opts.author,
      session: opts.session,
      ttlDays: opts.ttlDays,
    }),
  );

program
  .command('ingest')
  .description('scan the repo and derive claims from deterministic extractors (package.json, env, imports, routes, compose)')
  .option('--dry-run', 'print candidates without writing')
  .option('--author <id>')
  .option('--session <id>')
  .action((opts) => ingestCommand(opts));

program
  .command('log')
  .description('commit history of the current branch')
  .option('-n, --limit <n>', 'number of commits', '20')
  .option('--graph', 'show graph markers')
  .option('--session <id>')
  .action((opts) => logCommand(opts));

program
  .command('blame <subject>')
  .description('who or what taught the agent this')
  .option('--predicate <name>')
  .action((subject, opts) => blameCommand({ subject, predicate: opts.predicate }));

program
  .command('diff <range> [to]')
  .description('claims added/removed between two revisions (main..agent/<ses>, or two commits)')
  .action((range, to) => diffCommand({ range, to }));

program
  .command('revert <commit>')
  .description('invert a commit with a new commit (history is never rewritten)')
  .option('--session <id>')
  .action((commit, opts) => revertCommand({ commit, session: opts.session }));

program
  .command('merge <branch>')
  .description('3-way merge a branch into the current one; abort on conflict instead of guessing')
  .option('--session <id>')
  .option('--strategy <s>', 'authority | recency', 'authority')
  .option('--strict', 'do not let recency break same-tier conflicts')
  .option('--dry-run', 'print the plan only')
  .action((branch, opts) =>
    mergeCommand({
      branch,
      session: opts.session,
      strategy: opts.strategy === 'recency' ? 'recency' : 'authority',
      strict: opts.strict,
      dryRun: opts.dryRun,
    }),
  );

program
  .command('resolve <subject> <predicate>')
  .description('record a manual decision for one conflict')
  .requiredOption('--take <side>', 'ours | theirs | both')
  .option('--reason <text>')
  .action((subject, predicate, opts) => {
    const take = opts.take;
    if (take !== 'ours' && take !== 'theirs' && take !== 'both') {
      throw new Error('--take must be ours | theirs | both');
    }
    resolveCommand({ subject, predicate, take, reason: opts.reason });
  });

program
  .command('promote')
  .description('merge the current branch into main so other sessions can see it')
  .option('--into <ref>', 'target', 'main')
  .option('--session <id>')
  .option('--strict', 'do not let recency break same-tier conflicts')
  .option('--dry-run')
  .action((opts) =>
    promoteCommand({
      session: opts.session,
      into: opts.into,
      strict: opts.strict,
      dryRun: opts.dryRun,
    }),
  );

program
  .command('redact <claim>')
  .description('replace a claim object with [redacted], keeping the id and an audit row')
  .option('--reason <text>')
  .option('--author <id>')
  .option('--session <id>')
  .action((claim, opts) =>
    redactCommand({ claim, reason: opts.reason, author: opts.author, session: opts.session }),
  );

program
  .command('purge <claim>')
  .description('permanently remove a claim row, keeping an audit entry')
  .option('--reason <text>')
  .option('--author <id>')
  .option('--yes', 'confirm the permanent deletion')
  .action((claim, opts) =>
    purgeCommand({ claim, reason: opts.reason, author: opts.author, yes: opts.yes }),
  );

program
  .command('alias [action] [alias] [entity]')
  .description('name an entity so humans can say "refund flow" instead of doc:...#refund-flow')
  .option('--author <id>')
  .action((action, alias, entity, opts) =>
    aliasCommand({ action, alias, entity, author: opts.author }),
  );

program
  .command('rename <old> <new>')
  .description('move entities and evidence after a file rename, keeping history')
  .option('--author <id>')
  .option('--session <id>')
  .action((oldPath, newPath, opts) =>
    renameCommand({ old: oldPath, new: newPath, author: opts.author, session: opts.session }),
  );

program
  .command('onboard')
  .description('first run: detect the stack, choose a template, ingest, print next steps')
  .option('--path <dir>', 'repository to onboard (default: cwd)')
  .option('--template <name>', 'code | product | content | support')
  .option('--yes', 'no prompts (CI)')
  .action((opts) => onboardCommand({ path: opts.path, template: opts.template, yes: opts.yes }));

program
  .command('review')
  .description('review draft claims one by one: approve, reject, skip')
  .option('--all', 'approve every draft after one confirmation')
  .option('--session <id>')
  .option('--limit <n>', 'maximum drafts to show', '100')
  .action((opts) => reviewCommand({ all: opts.all, session: opts.session, limit: opts.limit }));

program
  .command('reject <claim>')
  .description('reject a draft: retract it, keeping the row and the reason')
  .option('--reason <text>')
  .option('--session <id>')
  .action((claim, opts) => rejectCommand({ claim, reason: opts.reason, session: opts.session }));

program
  .command('attest <claim>')
  .description('independent review: agree or disagree with a claim')
  .requiredOption('--verdict <v>', 'agree | disagree')
  .option('--reason <text>')
  .option('--session <id>')
  .action((claim, opts) => {
    if (opts.verdict !== 'agree' && opts.verdict !== 'disagree') {
      throw new Error('--verdict must be agree or disagree');
    }
    attestCommand({ claim, verdict: opts.verdict, reason: opts.reason, session: opts.session });
  });

program
  .command('digest')
  .description('what changed since the last review: claims, conflicts, attestations')
  .option('--days <n>', 'window in days', '7')
  .action((opts) => digestCommand({ days: opts.days }));

program
  .command('ui')
  .description('local dashboard: health, review, undo, settings')
  .option('--port <n>', 'port (0 picks a free one)', '4173')
  .option('--host <host>', 'bind address', '127.0.0.1')
  .option('--open', 'open the browser')
  .action((opts) => uiCommand({ port: opts.port, host: opts.host, open: opts.open }));

program
  .command('identity [action]')
  .description('show the current identity, or issue a team token')
  .option('--user <email>', 'identity to issue a token for')
  .option('--role <role>', 'maintainer | contributor', 'maintainer')
  .option('--days <n>', 'token lifetime in days', '30')
  .action((action, opts) =>
    identityCommand({ action, user: opts.user, role: opts.role, days: opts.days }),
  );

program
  .command('remote [path]')
  .description('configure a shared directory or a postgres database for fetch/push')
  .option('--show', 'print the current remote')
  .option('--postgres', 'use a postgres connection instead of a directory')
  .option('--env <name>', 'read the postgres connection string from this environment variable')
  .action((path, opts) =>
    remoteCommand({ path, show: opts.show, postgres: opts.postgres, env: opts.env }),
  );

program
  .command('fetch')
  .description('import commits from the shared directory')
  .option('--path <dir>', 'override the configured remote')
  .option('--author <id>')
  .action((opts) => fetchCommand({ path: opts.path, author: opts.author }));

program
  .command('push')
  .description('merge the remote first, then publish main to the shared directory')
  .option('--path <dir>', 'override the configured remote')
  .option('--author <id>')
  .action((opts) => pushCommand({ path: opts.path, author: opts.author }));

program
  .command('bundle <action> [file]')
  .description('export or import a signed-by-absence bundle for air-gapped sharing')
  .option('--out <file>', 'output file for bundle export')
  .option('--force', 'import a bundle from a different repository id')
  .option('--author <id>')
  .action((action, file, opts) =>
    bundleCommand({ action, file: opts.out ?? file, force: opts.force, author: opts.author }),
  );

program
  .command('guard')
  .description('scan for secrets before they enter a claim or a commit')
  .option('--staged', 'scan the staged diff (used by the pre-commit hook)')
  .option('--path <dir>', 'scan a directory instead of the whole repository')
  .option('--install', 'install a pre-commit hook that runs `lore guard --staged`')
  .option('--force', 'replace an existing pre-commit hook')
  .action((opts) =>
    guardCommand({ staged: opts.staged, path: opts.path, install: opts.install, force: opts.force }),
  );

program
  .command('gc')
  .description('retract draft claims nobody reviewed (rows are never deleted)')
  .option('--ttl-sessions <n>', 'sessions without review before a draft is retracted', '3')
  .option('--ttl-days <n>', 'explicit age override in days')
  .option('--dry-run')
  .option('--session <id>')
  .action((opts) =>
    gcCommand({
      ttlSessions: opts.ttlSessions,
      ttlDays: opts.ttlDays,
      dryRun: opts.dryRun,
      session: opts.session,
    }),
  );

program
  .command('status')
  .description('memory health: drafts, stale claims, commits')
  .option('--strict', 'exit 3 when health crosses a threshold')
  .option('--max-stale <pct>', 'maximum stale percentage (default 15)')
  .option('--max-conflicts <n>', 'maximum unresolved conflicts (default 0)')
  .option('--stats', 'print hash-cache hits, reads and misses')
  .option('--no-cache', 'bypass the hash cache and re-read every file')
  .action((opts) =>
    statusCommand({
      strict: opts.strict,
      maxStale: opts.maxStale,
      maxConflicts: opts.maxConflicts,
      stats: opts.stats,
      noCache: opts.cache === false,
    }),
  );

program
  .command('approve [claim]')
  .description('draft -> active')
  .option('--all-drafts', 'approve every draft')
  .option('--session <id>')
  .action((claim, opts) => approveCommand({ claim, allDrafts: opts.allDrafts, session: opts.session }));

program
  .command('search [query]')
  .description('score the active set of the current branch against the task scope')
  .option('--files <paths>', 'comma-separated paths in scope')
  .option('--symbols <ids>', 'comma-separated entity ids in scope')
  .option('--budget <n>', 'token budget (chars/4)', '2000')
  .option('--include-stale', 'keep stale claims')
  .option('--as-of <iso>', 'read memory as it was known and valid at this instant')
  .option('--no-cache', 'bypass the hash cache')
  .option('--trust-remote', 'include claims observed on newer code than this checkout')
  .option('--json', 'machine-readable JSON')
  .action((query, opts) =>
    searchCommand({
      query,
      files: opts.files,
      symbols: opts.symbols,
      budget: opts.budget,
      includeStale: opts.includeStale,
      asOf: opts.asOf,
      noCache: opts.cache === false,
      trustRemote: opts.trustRemote,
      json: opts.json,
    }),
  );

program
  .command('explain <target>')
  .description('why a claim is injected: trust, provenance, evidence and conflicts')
  .option('--json', 'machine-readable JSON')
  .action((target, opts) => explainCommand(target, { json: opts.json }));

const canon = program
  .command('canon')
  .description('Canon trust layer: status and unresolved tier-1 conflicts');

canon
  .command('status')
  .description('counts per trust state plus unresolved conflicts')
  .option('--json', 'machine-readable JSON')
  .action((opts) => canonStatusCommand({ json: opts.json }));

canon
  .command('decay')
  .description('evaluate TTL and evidence decay; mark claims stale without deleting them')
  .option('--dry-run', 'show what would decay without writing')
  .option('--json', 'machine-readable JSON')
  .action((opts) => canonDecayCommand({ dryRun: opts.dryRun, json: opts.json }));

canon
  .command('confirm <claim>')
  .description('human re-assertion: clear decay, refresh last_verified_at and confirmations')
  .option('--json', 'machine-readable JSON')
  .action((claim, opts) => canonConfirmCommand(claim, { json: opts.json }));

canon
  .command('metrics')
  .description('five outcome numbers; writes JSON (default canon-metrics.json)')
  .option('--json', 'print the JSON too')
  .option('--out <file>', 'output file')
  .action((opts) => canonMetricsCommand({ json: opts.json, out: opts.out }));

program
  .command('verify [claim]')
  .description('re-hash evidence and record valid/stale')
  .option('--all', 'verify every claim in the current branch active set')
  .option('--strict', 'exit 3 when stale claims remain')
  .option('--accept', 're-observe drifted files and store the new hash')
  .option('--no-cache', 'bypass the hash cache')
  .action((claim, opts) =>
    verifyCommand({
      claim,
      all: opts.all,
      strict: opts.strict,
      accept: opts.accept,
      noCache: opts.cache === false,
    }),
  );

program
  .command('export')
  .description('read-only projection of the active set (SPEC §10.3)')
  .requiredOption('--md', 'markdown projection')
  .option('--out <path>', 'write to a file (default: stdout)')
  .action((opts) => exportCommand({ md: opts.md, out: opts.out }));

program
  .command('mcp')
  .description('MCP server over stdio (JSON-RPC 2.0): memory_search/write/blame/status/diff')
  .action(() => mcpCommand());

try {
  installCanon();
  await program.parseAsync();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(pc.red(`error: ${message}`));
  process.exit(1);
}
