import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import pc from 'picocolors';
import type { AgentName } from './setup.js';

export const LORE_MEMORY_PROTOCOL_START = '<!-- lore:memory-protocol:start -->';
export const LORE_MEMORY_PROTOCOL_END = '<!-- lore:memory-protocol:end -->';

export const LORE_AGENT_RULES_SNIPPET = `${LORE_MEMORY_PROTOCOL_START}
## 11. Persistent memory protocol (Lore)

This project uses Lore for shared memory across all AI agents and sessions.
- **Task start**: Before proposing or editing code, invoke MCP tool \`memory_search\` with relevant file paths, symbols, or feature keywords to retrieve active architectural decisions, conventions, and environment variables.
- **Definition of Done**: When introducing or modifying environment variables, API endpoints, module dependencies, or architectural rules, invoke \`memory_write\` with evidence.
- **Provenance & drift**: Use \`memory_blame\` to verify authority, author, and evidence before overwriting an established pattern.
${LORE_MEMORY_PROTOCOL_END}`;

export interface RulesResult {
  file: string;
  action: 'created' | 'appended' | 'already-present';
}

export interface RulesOptions {
  root?: string;
  print?: boolean;
  targets?: AgentName[];
  dryRun?: boolean;
}

export function installAgentRules(root: string, opts: { targets?: AgentName[]; dryRun?: boolean } = {}): RulesResult[] {
  const results: RulesResult[] = [];
  const candidates: string[] = [];

  const hasAgentsMd = existsSync(path.join(root, 'AGENTS.md'));
  const hasClaudeMd = existsSync(path.join(root, 'CLAUDE.md'));
  const hasCursorRules = existsSync(path.join(root, '.cursorrules'));

  if (opts.targets && opts.targets.length) {
    for (const t of opts.targets) {
      if (t === 'claude') candidates.push('CLAUDE.md');
      else if (t === 'cursor') candidates.push('.cursorrules');
      else candidates.push('AGENTS.md');
    }
  } else {
    if (hasAgentsMd) candidates.push('AGENTS.md');
    if (hasClaudeMd) candidates.push('CLAUDE.md');
    if (hasCursorRules) candidates.push('.cursorrules');
  }

  const uniqueCandidates = [...new Set(candidates)];
  if (!uniqueCandidates.length) {
    uniqueCandidates.push('AGENTS.md');
  }

  for (const relFile of uniqueCandidates) {
    const fullPath = path.join(root, relFile);
    if (!existsSync(fullPath)) {
      if (!opts.dryRun) {
        mkdirSync(path.dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, `# ${relFile}\n\n${LORE_AGENT_RULES_SNIPPET}\n`, 'utf8');
      }
      results.push({ file: relFile, action: 'created' });
      continue;
    }

    const content = readFileSync(fullPath, 'utf8');
    if (content.includes(LORE_MEMORY_PROTOCOL_START) || content.includes('memory_search')) {
      results.push({ file: relFile, action: 'already-present' });
      continue;
    }

    if (!opts.dryRun) {
      const updated = content.trimEnd() + '\n\n' + LORE_AGENT_RULES_SNIPPET + '\n';
      writeFileSync(fullPath, updated, 'utf8');
    }
    results.push({ file: relFile, action: 'appended' });
  }

  return results;
}

export function rulesCommand(opts: RulesOptions = {}): void {
  const root = path.resolve(opts.root ?? process.cwd());

  if (opts.print) {
    console.log(LORE_AGENT_RULES_SNIPPET);
    return;
  }

  console.log(`Checking autonomous agent memory rules in ${pc.bold(root)}...`);
  const results = installAgentRules(root, opts);
  for (const r of results) {
    if (r.action === 'created') {
      console.log(`  ${pc.green('[OK]')} Created ${pc.bold(r.file)} with autonomous memory protocol`);
    } else if (r.action === 'appended') {
      console.log(`  ${pc.green('[OK]')} Injected autonomous memory protocol into ${pc.bold(r.file)}`);
    } else {
      console.log(`  ${pc.dim('[OK]')} ${pc.dim(r.file)}: memory protocol already present`);
    }
  }
}
