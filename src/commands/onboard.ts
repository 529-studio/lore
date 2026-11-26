import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { stateDirFor } from '../db.js';
import { initCommand } from './init.js';
import { createOnboardSession, ingestCommand, publishIngestBaseline } from './ingest.js';
import { installAgentRules } from './rules.js';
import { detectWorkspaceAgents, setupCommand } from './setup.js';

export interface OnboardOptions {
  path?: string;
  template?: string;
  yes?: boolean;
  setup?: string | boolean;
}

const TEMPLATES = ['code', 'product', 'content', 'support'] as const;
type Template = (typeof TEMPLATES)[number];

const templateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');

function detect(root: string): { template: Template; signals: string[] } {
  const has = (rel: string) => existsSync(path.join(root, rel));
  const isDir = (rel: string) => {
    try {
      return statSync(path.join(root, rel)).isDirectory();
    } catch {
      return false;
    }
  };
  const signals: string[] = [];
  let template: Template = 'product';

  const codeFiles = [
    'package.json',
    'pyproject.toml',
    'go.mod',
    'Cargo.toml',
    'pom.xml',
    'build.gradle',
    'pnpm-workspace.yaml',
    'turbo.json',
    'nx.json',
    'lerna.json',
    'go.work',
    'Makefile',
  ];
  const nested = [
    'frontend/package.json',
    'app/package.json',
    'backend/package.json',
    'backend/requirements.txt',
    'packages',
    'apps',
    'services',
  ];
  let containers: string[] = [];
  try {
    containers = readdirSync(root).filter(
      (name) => /^(docker-)?compose.*\.ya?ml$/i.test(name) || /^(dockerfile|containerfile)(\..*)?$/i.test(name),
    );
  } catch {
    // unreadable directory: fall back to the checks below
  }

  const codeHits = [...codeFiles.filter(has), ...nested.filter(has), ...containers];
  const dirHits = ['src', 'app', 'scripts'].filter(isDir);
  if (codeHits.length || dirHits.length) {
    template = 'code';
    signals.push(...codeHits, ...dirHits.map((d) => `${d}/`));
  }
  if (has('issues') || has('docs/issues')) {
    signals.push('issues/');
    if (template === 'product') template = 'support';
  }
  if (has('content') || has('blog') || has('posts')) {
    signals.push('content/');
    if (template === 'product') template = 'content';
  }
  if (has('docs/adr')) signals.push('docs/adr/');

  return { template, signals: [...new Set(signals)] };
}

/**
 * First run: detect the stack, pick a starter ontology, ingest, and print the two
 * commands that turn memory on for an agent.
 */
export async function onboardCommand(opts: OnboardOptions = {}): Promise<void> {
  const root = path.resolve(opts.path ?? process.cwd());
  if (!existsSync(root)) throw new Error(`no such directory: ${root}`);

  const detection = detect(root);
  let template: Template = (opts.template as Template | undefined) ?? detection.template;
  if (!TEMPLATES.includes(template)) {
    throw new Error(`unknown template "${template}"; choose ${TEMPLATES.join(', ')}`);
  }

  const agentDetection = detectWorkspaceAgents(root);
  const detectedAgents = [...new Set([...agentDetection.configuredAgents, ...agentDetection.installedAgents])];
  const interactive = Boolean(process.stdin.isTTY) && !opts.yes;
  let doIngest = true;
  let doSetup = opts.setup !== false;

  if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const chosen = (await rl.question(`template [${template}] (${TEMPLATES.join('/')}): `)).trim();
      if (chosen) template = chosen as Template;
      if (!TEMPLATES.includes(template)) throw new Error(`unknown template "${template}"`);
      const answer = (await rl.question('ingest the repository now? [Y/n] ')).trim().toLowerCase();
      doIngest = answer !== 'n' && answer !== 'no';
      if (opts.setup === undefined) {
        const agentNames = detectedAgents.length ? detectedAgents.join(', ') : 'standard agents';
        const setupAnswer = (await rl.question(`configure MCP for coding agents (${agentNames}) now? [Y/n] `)).trim().toLowerCase();
        doSetup = setupAnswer !== 'n' && setupAnswer !== 'no';
      }
    } finally {
      rl.close();
    }
  }

  const ontologyPath = path.join(root, 'lore.ontology.yml');
  const ontologyExisted = existsSync(ontologyPath);
  const stateExisted = existsSync(stateDirFor(root));
  const previous = process.cwd();

  process.chdir(root);
  try {
    if (!stateExisted) await initCommand({ root, gitignore: true });
    if (!ontologyExisted) {
      mkdirSync(path.dirname(ontologyPath), { recursive: true });
      copyFileSync(path.join(templateRoot, template, 'lore.ontology.yml'), ontologyPath);
      console.log(`${pc.green('[OK]')} ontology from template ${pc.bold(template)}`);
    } else {
      console.log(pc.dim('keeping the existing lore.ontology.yml'));
    }
    installAgentRules(root);
    if (doIngest) {
      const session = createOnboardSession();
      await ingestCommand({ session });
      publishIngestBaseline(root, session);
    }
    if (doSetup) {
      const target = typeof opts.setup === 'string' ? opts.setup : 'all';
      setupCommand(target, { root, scope: 'project', rules: false });
    }
  } finally {
    process.chdir(previous);
  }

  console.log(`\n${pc.bold('Next')}`);
  console.log(`  agent memory setup`);
  if (doSetup) {
    const names = detectedAgents.length ? detectedAgents.join(', ') : 'detected agents';
    console.log(`    ${pc.green('[OK]')} MCP configured for ${names}`);
  } else {
    console.log(`    run ${pc.cyan('lore setup --all')} to configure detected agents (Cursor, Claude, Antigravity, OpenCode, Codex, Gemini)`);
  }
  if (detectedAgents.length) {
    console.log(pc.dim(`    detected agents: ${detectedAgents.join(', ')}`));
  }
  console.log(`  open the dashboard   ${pc.cyan('lore ui')}`);
  console.log(`  review drafts        ${pc.cyan('lore review')}`);
  console.log(`  share with a team    ${pc.cyan('lore remote <shared-directory>')}`);
  if (detection.signals.length) console.log(pc.dim(`\n  detected: ${detection.signals.join(', ')}`));
}
