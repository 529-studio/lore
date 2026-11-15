import { createRequire } from 'node:module';
import pc from 'picocolors';
import { checkNpmUpdate } from '../update.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { name: string; version: string };

export interface CheckUpdateOptions {
  json?: boolean;
  timeout?: string;
}

export async function checkUpdateCommand(opts: CheckUpdateOptions = {}): Promise<void> {
  const timeoutMs = opts.timeout ? Number(opts.timeout) : 2000;
  const result = await checkNpmUpdate(pkg.name, pkg.version, { timeoutMs });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          package: pkg.name,
          current: result.current,
          latest: result.latest,
          update_available: result.updateAvailable,
          error: result.error ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (result.updateAvailable && result.latest) {
    console.log(pc.yellow(`[WARN] update available: ${result.current} -> ${result.latest}`));
    console.log(pc.dim(`run \`npm install -g ${pkg.name}\` to update`));
    return;
  }

  if (result.error) {
    console.log(pc.yellow(`[WARN] could not check npm registry: ${result.error}`));
    console.log(pc.dim(`current version: v${result.current}`));
    return;
  }

  console.log(pc.green(`[OK] ${pkg.name} is up to date (v${result.current})`));
}
