import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDb } from '../db.js';
import { makeCommit, head } from '../model.js';
import { ONTOLOGY_TEMPLATE } from '../schema.js';
import { ensureConfig } from '../config.js';

export interface InitOptions {
  root?: string;
  gitignore?: boolean;
}

export function initCommand(opts: InitOptions = {}): void {
  const root = path.resolve(opts.root ?? process.cwd());
  const db = createDb(root);
  ensureConfig(root);
  const created: string[] = [];

  if (!existsSync(path.join(root, '.lore'))) created.push('.lore/');

  if (!head(db, 'main')) {
    makeCommit(db, {
      ref: 'main',
      entries: [],
      message: 'init: empty memory',
      author: 'human:init',
      kind: 'init',
    });
  }

  const ontologyPath = path.join(root, 'lore.ontology.yml');
  if (!existsSync(ontologyPath)) {
    writeFileSync(ontologyPath, ONTOLOGY_TEMPLATE);
    created.push('lore.ontology.yml');
  }

  if (opts.gitignore !== false && existsSync(path.join(root, '.git')) ) {
    const gitignore = path.join(root, '.gitignore');
    const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
    if (!/^\.lore\/?$/m.test(current)) {
      appendFileSync(gitignore, `${current && !current.endsWith('\n') ? '\n' : ''}.lore/\n`);
      created.push('.gitignore (+ .lore/)');
    }
  }

  db.close();
  console.log(`lore initialised in ${root}`);
  if (created.length) console.log(`  ${created.join('\n  ')}`);
}
