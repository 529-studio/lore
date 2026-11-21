import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import pc from 'picocolors';
import { parse } from 'yaml';
import type { AgentName } from './setup.js';

export const LORE_MEMORY_PROTOCOL_START = '<!-- lore:memory-protocol:start -->';
export const LORE_MEMORY_PROTOCOL_END = '<!-- lore:memory-protocol:end -->';

export function buildAgentRulesSnippet(root?: string): string {
  let projectPredicates: string[] = [];
  if (root) {
    const ontPath = path.join(root, 'lore.ontology.yml');
    if (existsSync(ontPath)) {
      try {
        const parsed = parse(readFileSync(ontPath, 'utf8')) as {
          predicates?: Record<string, unknown>;
        };
        if (parsed?.predicates) {
          projectPredicates = Object.keys(parsed.predicates);
        }
      } catch {
        // fallback to standard predicates
      }
    }
  }

  const standardPredicates = [
    'enforces_invariant',
    'defines_rule',
    'has_guardrail',
    'has_constraint',
    'decides',
    'imports_module',
    'exposes_route',
    'read_by',
    'declared_dependency',
  ];

  const mergedPredicates = [...new Set([...standardPredicates, ...projectPredicates])];
  const predicateList = mergedPredicates.slice(0, 10).map((p) => `\`${p}\``).join(', ');

  return `${LORE_MEMORY_PROTOCOL_START}
## 11. Persistent memory protocol (Lore)

This project uses Lore for shared memory across all AI agents and sessions.

### Protocol Actions
- **Task start**: Before proposing or editing code, invoke MCP tool \`memory_search\` with relevant file paths, symbols, or feature keywords to retrieve active architectural decisions, conventions, and environment variables.
- **Definition of Done**: When introducing or modifying environment variables, API endpoints, module dependencies, or architectural rules, invoke \`memory_write\` with evidence.
- **Provenance & drift**: Use \`memory_blame\` to verify authority, author, and evidence before overwriting an established pattern.

### Entity ID Conventions (subject)
- Files: \`file:<relative-path>\` (e.g. \`file:src/config.ts\`)
- Symbols: \`sym:<relative-path>#<name>\` (e.g. \`sym:src/policy.ts#isPermissiveTrust\`)
- Environment variables: \`env:<NAME>\` (e.g. \`env:LORE_TEAM_SECRET\`)
- Packages: \`pkg:<name>\` (e.g. \`pkg:@529studio/lore\`)
- Documents: \`doc:<relative-path>\` (e.g. \`doc:AGENTS.md\`)
- Architectural decisions: \`adr:<NNN>\` (e.g. \`adr:001\`)
- Rules & Guardrails: \`rule:<ID>\` or \`lesson:L<NN>\` (e.g. \`rule:MCP-001\`, \`lesson:L04\`)

### Standard Predicates
- Rules & Invariants: \`enforces_invariant\`, \`defines_rule\`, \`has_guardrail\`, \`has_constraint\`
- Architecture & Routes: \`decides\`, \`imports_module\`, \`exposes_route\`, \`read_by\`, \`entrypoint\`
- Dependencies: \`declared_dependency\`, \`uses_library\`, \`package_name\`
- Project predicates: ${predicateList}

### Evidence & Trust Tiers (kind & ref)
- Code / Tests: Use \`kind: "file"\` or \`kind: "test"\` with \`ref: "<relative-path>"\`. SHA-256 hashes ensure freshness; if file changes, claims auto-decay to stale.
- Inferences: Use \`kind: "agent"\`. Writes remain \`draft\` until reviewed via \`lore approve\` (or active in solo permissive mode).
${LORE_MEMORY_PROTOCOL_END}`;
}

export const LORE_AGENT_RULES_SNIPPET = buildAgentRulesSnippet();

export interface RulesResult {
  file: string;
  action: 'created' | 'appended' | 'updated' | 'already-present';
}

export interface RulesOptions {
  root?: string;
  print?: boolean;
  update?: boolean;
  force?: boolean;
  targets?: AgentName[];
  dryRun?: boolean;
}

export function installAgentRules(
  root: string,
  opts: { targets?: AgentName[]; dryRun?: boolean; update?: boolean; force?: boolean } = {},
): RulesResult[] {
  const results: RulesResult[] = [];
  const candidates: string[] = [];
  const shouldUpdate = Boolean(opts.update || opts.force);
  const snippet = buildAgentRulesSnippet(root);

  if (opts.targets && opts.targets.length) {
    for (const t of opts.targets) {
      if (t === 'claude') candidates.push('CLAUDE.md');
      else if (t === 'cursor') candidates.push('.cursorrules');
      else candidates.push('AGENTS.md');
    }
  } else {
    if (existsSync(path.join(root, 'AGENTS.md'))) candidates.push('AGENTS.md');
    if (existsSync(path.join(root, 'CLAUDE.md'))) candidates.push('CLAUDE.md');
    if (existsSync(path.join(root, '.cursorrules'))) candidates.push('.cursorrules');
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
        writeFileSync(fullPath, `# ${relFile}\n\n${snippet}\n`, 'utf8');
      }
      results.push({ file: relFile, action: 'created' });
      continue;
    }

    const content = readFileSync(fullPath, 'utf8');
    const startIdx = content.indexOf(LORE_MEMORY_PROTOCOL_START);
    const endIdx = content.indexOf(LORE_MEMORY_PROTOCOL_END);

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const existingSnippet = content.slice(startIdx, endIdx + LORE_MEMORY_PROTOCOL_END.length);
      if (existingSnippet === snippet) {
        results.push({ file: relFile, action: 'already-present' });
        continue;
      }
      if (shouldUpdate) {
        if (!opts.dryRun) {
          const updated =
            content.slice(0, startIdx) +
            snippet +
            content.slice(endIdx + LORE_MEMORY_PROTOCOL_END.length);
          writeFileSync(fullPath, updated, 'utf8');
        }
        results.push({ file: relFile, action: 'updated' });
        continue;
      }
      results.push({ file: relFile, action: 'already-present' });
      continue;
    }

    const legacyMatch = /## \d+\. Persistent memory protocol[\s\S]*?(?=\n## |\n#[^#]|$|\Z)/.exec(content);
    if (legacyMatch) {
      if (shouldUpdate) {
        if (!opts.dryRun) {
          const updated =
            content.slice(0, legacyMatch.index) +
            snippet +
            content.slice(legacyMatch.index + legacyMatch[0].length);
          writeFileSync(fullPath, updated, 'utf8');
        }
        results.push({ file: relFile, action: 'updated' });
        continue;
      }
      results.push({ file: relFile, action: 'already-present' });
      continue;
    }

    if (!opts.dryRun) {
      const updated = content.trimEnd() + '\n\n' + snippet + '\n';
      writeFileSync(fullPath, updated, 'utf8');
    }
    results.push({ file: relFile, action: 'appended' });
  }

  return results;
}

export function rulesCommand(opts: RulesOptions = {}): void {
  const root = path.resolve(opts.root ?? process.cwd());

  if (opts.print) {
    console.log(buildAgentRulesSnippet(root));
    return;
  }

  console.log(`Checking autonomous agent memory rules in ${pc.bold(root)}...`);
  const results = installAgentRules(root, opts);
  for (const r of results) {
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
