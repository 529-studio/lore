import process from 'node:process';
import path from 'node:path';
import { readConfig, writeConfig, ensureConfig } from '../config.js';

export interface ConfigOptions {
  root?: string;
}

export function configCommand(action?: string, key?: string, value?: string, opts: ConfigOptions = {}): void {
  const root = path.resolve(opts.root ?? process.cwd());
  const config = (readConfig(root) ?? ensureConfig(root)) as Record<string, unknown>;

  const act = action ?? 'list';

  if (act === 'list') {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  if (act === 'get') {
    if (!key) throw new Error('missing config key: lore config get <key>');
    const val = config[key];
    if (val === undefined) {
      console.log('');
      return;
    }
    console.log(typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val));
    return;
  }

  if (act === 'set') {
    if (!key) throw new Error('missing config key: lore config set <key> <value>');
    if (value === undefined) throw new Error('missing config value: lore config set <key> <value>');

    let parsed: unknown = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }

    config[key] = parsed;
    writeConfig(root, config as any);
    console.log(`[OK] set ${key} = ${JSON.stringify(parsed)}`);
    return;
  }

  if (act === 'unset') {
    if (!key) throw new Error('missing config key: lore config unset <key>');
    if (key in config) {
      delete config[key];
      writeConfig(root, config as any);
      console.log(`[OK] unset ${key}`);
    }
    return;
  }

  throw new Error(`unknown config action "${act}"; choose get, set, unset, or list`);
}
