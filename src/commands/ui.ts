import { spawn } from 'node:child_process';
import pc from 'picocolors';
import { requireRoot } from '../db.js';
import { startUi } from '../ui/server.js';

export interface UiCommandOptions {
  port?: string;
  host?: string;
  open?: boolean;
}

export async function uiCommand(opts: UiCommandOptions): Promise<void> {
  const root = requireRoot();
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ? Number(opts.port) : 4173;

  const handle = await startUi(root, { host, port });
  console.log(`${pc.green('✓')} lore ui ${pc.bold(handle.url)} ${pc.dim('(local, loopback only)')}`);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(pc.yellow('[WARN] bound to a non-loopback address; anyone on the network can read this memory'));
  }
  console.log(pc.dim('  Ctrl+C to stop'));

  if (opts.open) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(command, [handle.url], { stdio: 'ignore', detached: true }).unref();
  }

  const shutdown = () => {
    handle.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
