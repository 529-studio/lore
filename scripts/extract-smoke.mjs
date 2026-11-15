import assert from 'node:assert/strict';
import { extractAll } from '../dist/extract/index.js';

const candidates = extractAll('.');

// 1. ADR Decision Extraction
const decisions = candidates.filter((c) => c.predicate === 'decides');
assert(decisions.length > 0, 'expected ADR decisions to be extracted');
const adr1Decision = decisions.find((c) => c.subject === 'adr:001');
assert(adr1Decision, 'expected adr:001 decides claim');
assert(
  adr1Decision.object.includes('SQLite file at .lore/lore.db'),
  `unexpected adr:001 object: ${adr1Decision.object}`,
);

// 2. Lesson Rule / Guardrail Extraction
const rules = candidates.filter((c) => c.predicate === 'defines_rule');
assert(rules.length > 0, 'expected lesson rules or agent rules to be extracted');
const lesson4 = rules.find((c) => c.subject === 'lesson:L04');
assert(lesson4, 'expected lesson:L04 to be extracted with defines_rule');
assert(
  lesson4.object.includes('When a shared helper is the fix, delete the unsafe variant'),
  `unexpected lesson4 object: ${lesson4.object}`,
);

const issues = candidates.filter((c) => c.predicate === 'describes_issue');
const lesson4Issue = issues.find((c) => c.subject === 'lesson:L04');
assert(lesson4Issue, 'expected lesson:L04 to be extracted with describes_issue');
assert(
  lesson4Issue.object.includes('hashFile was hardened against path traversal'),
  `unexpected lesson4 issue object: ${lesson4Issue.object}`,
);

// 3. AGENTS.md Rule Extraction
const agentRule1 = rules.find((c) => c.subject.includes('doc:AGENTS.md') && c.subject.includes('root-cause'));
assert(agentRule1, 'expected AGENTS.md rule 1 (root-cause) to be extracted');
assert(agentRule1.object.includes('Do not ship a band-aid'), `unexpected agent rule: ${agentRule1.object}`);

console.log('[OK] doc extraction tests passed');
