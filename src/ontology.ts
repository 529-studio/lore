import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export type Cardinality = 'one' | 'many';

export interface Ontology {
  cardinality(predicate: string): Cardinality;
  known(predicate: string): boolean;
  /** Optional per-predicate TTL; null means never decays by time. */
  ttlDays(predicate: string): number | null;
}

const DEFAULT: Cardinality = 'one';

/** Multi-valued predicates emitted by deterministic codebase extractors. */
const EXTRACTOR_MULTI_VALUED_PREDICATES = new Set<string>([
  'defines_script',
  'imports_module',
  'exposes_route',
  'read_by',
  'uses_image',
  'publishes_port',
  'has_make_target',
  'has_section',
  'provides_command',
  'requires_runtime',
  'has_keyword',
  'enforces_invariant',
  'defines_rule',
  'has_guardrail',
  'has_constraint',
  'decides',
  'describes_issue',
]);

export function loadOntology(root: string): Ontology {
  const file = path.join(root, 'lore.ontology.yml');
  let predicates: Record<string, { cardinality?: Cardinality; ttl_days?: number }> = {};

  if (existsSync(file)) {
    try {
      const parsed = parse(readFileSync(file, 'utf8')) as {
        predicates?: Record<string, { cardinality?: Cardinality; ttl_days?: number }>;
      };
      predicates = parsed?.predicates ?? {};
    } catch {
      predicates = {};
    }
  }

  return {
    cardinality(predicate) {
      if (Object.prototype.hasOwnProperty.call(predicates, predicate)) {
        const entry = predicates[predicate];
        return entry?.cardinality === 'many' ? 'many' : DEFAULT;
      }
      if (EXTRACTOR_MULTI_VALUED_PREDICATES.has(predicate)) {
        return 'many';
      }
      return DEFAULT;
    },
    known(predicate) {
      return Object.prototype.hasOwnProperty.call(predicates, predicate);
    },
    ttlDays(predicate) {
      const value = predicates[predicate]?.ttl_days;
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    },
  };
}
