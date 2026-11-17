import pc from 'picocolors';
import { reconstructTimeline } from '../canon/temporal.js';
import { openDb, requireRoot } from '../db.js';
import { oneLine } from '../util/text.js';

export interface TimelineCommandOptions {
  subject: string;
  predicate?: string;
  json?: boolean;
}

function formatInstant(iso: string | null): string {
  if (!iso) return 'present';
  return iso.replace('T', ' ').slice(0, 16);
}

function formatTrust(trust: string, state: string): string {
  const s = state === 'active' ? pc.green(state) : state === 'draft' ? pc.yellow(state) : pc.red(state);
  const t =
    trust === 'canonical'
      ? pc.green(`[${trust}]`)
      : trust === 'stale' || trust === 'contested'
        ? pc.red(`[${trust}]`)
        : pc.yellow(`[${trust}]`);
  return `${s} ${t}`;
}

export function timelineCommand(opts: TimelineCommandOptions): void {
  const root = requireRoot();
  const db = openDb(root);

  const res = reconstructTimeline(db, opts.subject, opts.predicate);
  db.close();

  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (!res.entries.length) {
    console.log(
      pc.yellow(`no timeline entries found for ${opts.subject}${opts.predicate ? ` (predicate: ${opts.predicate})` : ''}`),
    );
    return;
  }

  console.log(
    pc.bold(`Bi-temporal Timeline for ${pc.cyan(opts.subject)}`) +
      (opts.predicate ? ` [${pc.magenta(opts.predicate)}]` : '') +
      ` (${res.entries.length} revision(s))`,
  );
  console.log();

  res.entries.forEach((e, idx) => {
    const validSpan = `${formatInstant(e.validFrom)} .. ${formatInstant(e.validTo)}`;
    const txSpan = `${formatInstant(e.txFrom)} .. ${formatInstant(e.txTo)}`;
    const objStr = typeof e.object === 'string' ? e.object : JSON.stringify(e.object);

    console.log(
      `  [${idx + 1}] ${pc.bold(e.predicate)}: ${pc.white(oneLine(objStr))}`,
    );
    console.log(
      `      ${pc.dim('valid:')} ${validSpan.padEnd(42)} ${pc.dim('tx:')} ${txSpan}`,
    );
    console.log(
      `      ${pc.dim('claim:')} ${e.claimId}  ${formatTrust(e.trust, e.state)}  ${pc.dim('by:')} ${oneLine(e.author)}`,
    );
    if (e.supersedes) {
      console.log(`      ${pc.dim('supersedes:')} ${e.supersedes}`);
    }
    if (e.supersededBy) {
      console.log(`      ${pc.dim('superseded by:')} ${e.supersededBy}`);
    }
    console.log();
  });
}
