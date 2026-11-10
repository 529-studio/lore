import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export type Cardinality = 'one' | 'many';

export interface Ontology {
  cardinality(predicate: string): Cardinality;
  known(predicate: string): boolean;
}

const DEFAULT: Cardinality = 'one';

export function loadOntology(root: string): Ontology {
  const file = path.join(root, 'lore.ontology.yml');
  let predicates: Record<string, { cardinality?: Cardinality }> = {};

  if (existsSync(file)) {
    try {
      const parsed = parse(readFileSync(file, 'utf8')) as { predicates?: Record<string, { cardinality?: Cardinality }> };
      predicates = parsed?.predicates ?? {};
    } catch {
      predicates = {};
    }
  }

  return {
    cardinality(predicate) {
      const entry = predicates[predicate];
      return entry?.cardinality === 'many' ? 'many' : DEFAULT;
    },
    known(predicate) {
      return Object.prototype.hasOwnProperty.call(predicates, predicate);
    },
  };
}
