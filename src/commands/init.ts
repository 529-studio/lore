import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import pc from 'picocolors';
import { createDb, stateDirFor } from '../db.js';
import { makeCommit, head } from '../model.js';
import { ONTOLOGY_TEMPLATE } from '../schema.js';
import { ensureConfig, writeConfig } from '../config.js';
import { detectWorkspaceAgents, setupCommand } from './setup.js';
import { installAgentRules } from './rules.js';
import { ingestCommand } from './ingest.js';

export interface InitOptions {
  root?: string;
  gitignore?: boolean;
  trustMode?: 'strict' | 'permissive';
  solo?: boolean;
  full?: boolean;
  setup?: string | boolean;
  rules?: boolean;
  ingest?: boolean;
}

export function initCommand(opts: InitOptions = {}): void {
  const root = path.resolve(opts.root ?? process.cwd());
  const stateDir = stateDirFor(root);
  const sharedState = stateDir !== path.join(root, '.lore');
  const stateExisted = existsSync(stateDir);
  const db = createDb(root);
  const config = ensureConfig(root);
  if (opts.solo || opts.trustMode === 'permissive') {
    config.trust_mode = 'permissive';
    writeConfig(root, config);
  } else if (opts.trustMode === 'strict') {
    config.trust_mode = 'strict';
    writeConfig(root, config);
  }
  const created: string[] = [];

  if (!stateExisted) created.push(sharedState ? `${stateDir} (shared store)` : '.lore/');

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

  const gitPath = path.join(root, '.git');
  const isPrimaryCheckout = existsSync(gitPath) && statSync(gitPath).isDirectory();
  if (opts.gitignore !== false && isPrimaryCheckout) {
    const gitignore = path.join(root, '.gitignore');
    const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
    if (!/^\.lore\/?$/m.test(current)) {
      appendFileSync(gitignore, `${current && !current.endsWith('\n') ? '\n' : ''}.lore/\n`);
      created.push('.gitignore (+ .lore/)');
    }
  }

  db.close();
  console.log(`lore initialised in ${root}`);
  if (sharedState) console.log(`  using shared store at ${stateDir}`);
  if (created.length) console.log(`  ${created.join('\n  ')}`);

  const detection = detectWorkspaceAgents(root);

  if (opts.rules || opts.full) {
    console.log(`\n${pc.bold('Agent memory directives:')}`);
    const ruleResults = installAgentRules(root);
    for (const r of ruleResults) {
      if (r.action === 'created') {
        console.log(`  ${pc.green('[OK]')} Created ${pc.bold(r.file)} with autonomous memory protocol`);
      } else if (r.action === 'appended') {
        console.log(`  ${pc.green('[OK]')} Injected autonomous memory protocol into ${pc.bold(r.file)}`);
      } else if (r.action === 'updated') {
        console.log(`  ${pc.green('[OK]')} Updated autonomous memory protocol in ${pc.bold(r.file)}`);
      } else {
        console.log(`  ${pc.dim('[OK]')} ${pc.dim(r.file)}: memory protocol already up to date`);
      }
    }
  }

  if (opts.ingest || opts.full) {
    console.log(`\n${pc.bold('Ingesting codebase facts:')}`);
    const previous = process.cwd();
    try {
      process.chdir(root);
      ingestCommand({ root });
    } finally {
      process.chdir(previous);
    }
  }

  if (opts.setup || opts.full) {
    console.log(`\n${pc.bold('Configuring agent MCP:')}`);
    const setupTarget = typeof opts.setup === 'string' ? opts.setup : 'all';
    setupCommand(setupTarget, { root, scope: 'project', rules: false });
  }

  if (!opts.full && !opts.rules && !opts.ingest && !opts.setup) {
    if (detection.hasCode || detection.ruleFiles.length > 0 || detection.configuredAgents.length > 0) {
      console.log(`\n${pc.cyan('[NOTE] Detected pre-existing project:')}`);
      if (detection.ruleFiles.length) {
        console.log(`  Agent rules: ${detection.ruleFiles.join(', ')}`);
      }
      if (detection.configuredAgents.length || detection.installedAgents.length) {
        const detected = [...new Set([...detection.configuredAgents, ...detection.installedAgents])];
        console.log(`  Coding agents: ${detected.join(', ')}`);
      }
      if (detection.codeSignals.length) {
        console.log(`  Code signals: ${detection.codeSignals.join(', ')}`);
      }
      console.log(`\nTo auto-inject memory protocol, ingest codebase facts, and configure MCP in one step:`);
      console.log(`  ${pc.bold('lore init --full')}${opts.solo ? ' --solo' : ''}`);
      console.log(`Or run individually:`);
      console.log(`  lore rules`);
      console.log(`  lore ingest`);
      console.log(`  lore setup --all`);
    }
  }

  if (opts.full) {
    console.log(`\n${pc.green('[OK]')} Full workspace onboarding complete.`);
  }
}
