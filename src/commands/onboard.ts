import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { initCommand } from './init.js';
import { ingestCommand } from './ingest.js';

export interface OnboardOptions {
  path?: string;
  template?: string;
  yes?: boolean;
}

const TEMPLATES = ['code', 'product', 'content', 'support'] as const;
type Template = (typeof TEMPLATES)[number];

const templateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');

function detect(root: string): { template: Template; signals: string[] } {
  const has = (rel: string) => existsSync(path.join(root, rel));
  const signals: string[] = [];
  let template: Template = 'product';

  const codeFiles = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle'];
  const codeHits = codeFiles.filter(has);
  if (codeHits.length || has('src') || has('app')) {
    template = 'code';
    signals.push(...codeHits, ...(has('src') ? ['src/'] : []));
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

  const interactive = Boolean(process.stdin.isTTY) && !opts.yes;
  let doIngest = true;

  if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const chosen = (await rl.question(`template [${template}] (${TEMPLATES.join('/')}): `)).trim();
      if (chosen) template = chosen as Template;
      if (!TEMPLATES.includes(template)) throw new Error(`unknown template "${template}"`);
      const answer = (await rl.question('ingest the repository now? [Y/n] ')).trim().toLowerCase();
      doIngest = answer !== 'n' && answer !== 'no';
    } finally {
      rl.close();
    }
  }

  const ontologyPath = path.join(root, 'lore.ontology.yml');
  const ontologyExisted = existsSync(ontologyPath);
  const stateExisted = existsSync(path.join(root, '.lore'));
  const previous = process.cwd();

  process.chdir(root);
  try {
    if (!stateExisted) initCommand({ root, gitignore: true });
    if (!ontologyExisted) {
      mkdirSync(path.dirname(ontologyPath), { recursive: true });
      copyFileSync(path.join(templateRoot, template, 'lore.ontology.yml'), ontologyPath);
      console.log(`${pc.green('✓')} ontology from template ${pc.bold(template)}`);
    } else {
      console.log(pc.dim('keeping the existing lore.ontology.yml'));
    }
    if (doIngest) ingestCommand({});
  } finally {
    process.chdir(previous);
  }

  const cli = process.argv[1] ?? 'lore';
  console.log(`\n${pc.bold('Next')}`);
  console.log(`  connect an agent`);
  console.log(pc.dim(`    claude mcp add lore --scope project --env LORE_SESSION=claude -- node ${cli} mcp`));
  console.log(`  open the dashboard   ${pc.cyan('lore ui')}`);
  console.log(`  review drafts        ${pc.cyan('lore review')}`);
  console.log(`  share with a team    ${pc.cyan('lore remote <shared-directory>')}`);
  if (detection.signals.length) console.log(pc.dim(`\n  detected: ${detection.signals.join(', ')}`));
}
