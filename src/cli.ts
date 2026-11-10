#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import { approveCommand } from './commands/approve.js';
import { blameCommand } from './commands/blame.js';
import { diffCommand } from './commands/diff.js';
import { ingestCommand } from './commands/ingest.js';
import { initCommand } from './commands/init.js';
import { logCommand } from './commands/log.js';
import { mergeCommand } from './commands/merge.js';
import { resolveCommand } from './commands/resolve.js';
import { revertCommand } from './commands/revert.js';
import { statusCommand } from './commands/status.js';
import { searchCommand } from './commands/search.js';
import { verifyCommand } from './commands/verify.js';
import { writeCommand } from './commands/write.js';
import type { EvidenceKind } from './model.js';

const program = new Command();

program
  .name('lore')
  .description('Git for what your agents know — versioned, verifiable memory')
  .version('0.0.1');

program
  .command('init')
  .description('khởi tạo .lore/ trong repo hiện tại')
  .option('--root <path>', 'repo root (mặc định: cwd)')
  .option('--no-gitignore', 'không tự thêm .lore/ vào .gitignore')
  .action((opts) => initCommand({ root: opts.root, gitignore: opts.gitignore }));

program
  .command('write')
  .description('ghi một claim (draft nếu evidence là agent/human)')
  .requiredOption('--subject <id>', 'entity id, vd file:src/a.ts, env:DATABASE_URL, sym:src/a.ts#fn')
  .requiredOption('--predicate <name>', 'vd read_by, declares_dependency')
  .requiredOption('--object <text>', 'giá trị của claim')
  .option('--kind <kind>', 'test|file|command|human|agent', 'file')
  .option('--ref <ref>', 'đường dẫn/nguồn của evidence (mặc định: subject)')
  .option('--hash <hash>', 'hash evidence (tự tính nếu là file/test)')
  .option('--confidence <n>', '0..1')
  .option('--author <id>', 'human:... hoặc agent:...')
  .option('--session <id>', 'ghi vào branch agent/<session>')
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
    }),
  );

program
  .command('ingest')
  .description('quét repo, sinh claim từ extractor tất định (package.json, env, imports, routes, compose)')
  .option('--dry-run', 'chỉ in ra, không ghi')
  .option('--author <id>')
  .option('--session <id>')
  .action((opts) => ingestCommand(opts));

program
  .command('log')
  .description('lịch sử commit của branch hiện tại')
  .option('-n, --limit <n>', 'số commit', '20')
  .option('--graph', 'hiện ký hiệu graph')
  .option('--session <id>')
  .action((opts) => logCommand(opts));

program
  .command('blame <subject>')
  .description('ai/cái gì dạy agent điều này')
  .option('--predicate <name>')
  .action((subject, opts) => blameCommand({ subject, predicate: opts.predicate }));

program
  .command('diff <range> [to]')
  .description('claim nào thêm/xoá giữa hai revision (main..agent/<ses>, hoặc hai commit)')
  .action((range, to) => diffCommand({ range, to }));

program
  .command('revert <commit>')
  .description('đảo ngược một commit bằng commit mới (không rewrite history)')
  .option('--session <id>')
  .action((commit, opts) => revertCommand({ commit, session: opts.session }));

program
  .command('merge <branch>')
  .description('3-way merge branch vào branch hiện tại; conflict thì abort, không đoán')
  .option('--session <id>')
  .option('--strategy <s>', 'authority | recency', 'authority')
  .option('--strict', 'không cho recency phá conflict cùng tier')
  .option('--dry-run', 'chỉ in kế hoạch')
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
  .description('ghi quyết định tay cho một conflict')
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
  .command('status')
  .description('sức khoẻ memory: draft, stale, commit')
  .action(() => statusCommand());

program
  .command('approve [claim]')
  .description('draft -> active')
  .option('--all-drafts', 'approve toàn bộ draft')
  .option('--session <id>')
  .action((claim, opts) => approveCommand({ claim, allDrafts: opts.allDrafts, session: opts.session }));

program
  .command('search [query]')
  .description('score the active set of the current branch against the task scope')
  .option('--files <paths>', 'đường dẫn trong scope, phân cách bằng dấu phẩy')
  .option('--symbols <ids>', 'entity id trong scope, phân cách bằng dấu phẩy')
  .option('--budget <n>', 'token budget (chars/4)', '2000')
  .option('--include-stale', 'đừng loại claim stale')
  .option('--json', 'in JSON cho tool đọc')
  .action((query, opts) =>
    searchCommand({
      query,
      files: opts.files,
      symbols: opts.symbols,
      budget: opts.budget,
      includeStale: opts.includeStale,
      json: opts.json,
    }),
  );

program
  .command('verify [claim]')
  .description('chạy lại evidence hash, ghi status valid/stale')
  .option('--all', 'verify toàn bộ claim trong active set của branch hiện tại')
  .option('--strict', 'exit 3 nếu còn claim stale')
  .action((claim, opts) => verifyCommand({ claim, all: opts.all, strict: opts.strict }));

try {
  program.parse();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(pc.red(`error: ${message}`));
  process.exit(1);
}
