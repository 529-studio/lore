import type { DB } from '../db.js';
import type { ClaimRow } from '../model.js';

export const DEFAULT_VECTOR_DIMS = 128;
export const DEFAULT_VECTOR_MODEL = 'local-fnv128';

/** FNV-1a 32-bit hash algorithm for deterministic feature hashing. */
export function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Vector dot product. */
export function dotProduct(a: number[] | Float32Array, b: number[] | Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

/** Vector magnitude (L2 Euclidean norm). */
export function magnitude(vec: number[] | Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum);
}

/** L2-normalizes a vector so its magnitude is 1.0 (or zero vector if magnitude is 0). */
export function l2Normalize(vec: number[] | Float32Array): number[] {
  const mag = magnitude(vec);
  if (mag === 0) return new Array(vec.length).fill(0);
  const out = new Array<number>(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = (vec[i] ?? 0) / mag;
  }
  return out;
}

/**
 * Cosine similarity between two vectors.
 * Returns values clamped to [-1, 1], or 0 if either vector has magnitude 0.
 */
export function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  const sim = dotProduct(a, b) / (magA * magB);
  if (Number.isNaN(sim)) return 0;
  return Math.max(-1, Math.min(1, sim));
}

/** Euclidean distance between two vectors. */
export function euclideanDistance(a: number[] | Float32Array, b: number[] | Float32Array): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/** Split camelCase, snake_case, kebab-case, paths, and punctuation into words. */
export function tokenizeCodeTerms(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .split(/[\s_]+/)
    .filter((w) => w.length >= 2);
}

/** Generate character n-grams (subwords) for morphological and stem similarity. */
export function extractCharNgrams(term: string, n = 3): string[] {
  if (term.length < n) return [term];
  const ngrams: string[] = [];
  for (let i = 0; i <= term.length - n; i++) {
    ngrams.push(term.slice(i, i + n));
  }
  return ngrams;
}

export interface FeatureWeight {
  feature: string;
  weight: number;
}

/**
 * Extracts weighted semantic features from code/memory text:
 * - Word unigrams (weight: 1.0)
 * - Word bigrams (weight: 1.2)
 * - Character 3-grams and 4-grams (weight: 0.4)
 */
export function extractSemanticFeatures(text: string): FeatureWeight[] {
  const terms = tokenizeCodeTerms(text);
  const termCounts = new Map<string, number>();
  for (const t of terms) {
    termCounts.set(t, (termCounts.get(t) ?? 0) + 1);
  }

  const features: FeatureWeight[] = [];

  // 1. Unigrams with sub-linear term frequency
  for (const [term, count] of termCounts) {
    const tf = 1 + Math.log(count);
    features.push({ feature: `w:${term}`, weight: tf * 1.0 });

    // 2. Subword character 3-grams & 4-grams
    const trigrams = extractCharNgrams(term, 3);
    for (const tri of trigrams) {
      features.push({ feature: `c3:${tri}`, weight: tf * 0.35 });
    }
    if (term.length >= 4) {
      const quadgrams = extractCharNgrams(term, 4);
      for (const quad of quadgrams) {
        features.push({ feature: `c4:${quad}`, weight: tf * 0.45 });
      }
      // Morphological prefix stems (length 4 to 8)
      for (let len = 4; len <= Math.min(term.length, 8); len++) {
        features.push({ feature: `p:${term.slice(0, len)}`, weight: tf * 0.5 });
      }
    }
  }

  // 3. Word bigrams
  for (let i = 0; i < terms.length - 1; i++) {
    const t1 = terms[i];
    const t2 = terms[i + 1];
    if (t1 && t2) {
      features.push({ feature: `b:${t1}_${t2}`, weight: 1.2 });
    }
  }

  return features;
}

/**
 * Deterministic local semantic embedding generator.
 * Uses feature hashing with alternating signed projection into N dimensions,
 * followed by L2 unit normalization.
 */
export function generateLocalEmbedding(text: string, dims = DEFAULT_VECTOR_DIMS): number[] {
  const vector = new Array<number>(dims).fill(0);
  const features = extractSemanticFeatures(text);

  if (!features.length) return vector;

  for (const { feature, weight } of features) {
    const h = fnv1a(feature);
    const index = (h >>> 1) % dims;
    const sign = (h & 1) === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign * weight;
  }

  return l2Normalize(vector);
}

/** Abstract vector embedding provider interface. */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]> | number[];
  embedBatch(texts: string[]): Promise<number[][]> | number[][];
}

/** Built-in zero-dependency deterministic local semantic embedding provider. */
export class LocalSemanticEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;

  constructor(dimensions = DEFAULT_VECTOR_DIMS, name = DEFAULT_VECTOR_MODEL) {
    this.dimensions = dimensions;
    this.name = name;
  }

  embedSync(text: string): number[] {
    return generateLocalEmbedding(text, this.dimensions);
  }

  embed(text: string): number[] {
    return this.embedSync(text);
  }

  embedBatch(texts: string[]): number[][] {
    return texts.map((t) => this.embedSync(t));
  }
}

/**
 * Optional HTTP embedding provider for external endpoints (e.g. Ollama, OpenAI-compatible).
 * Automatically falls back to LocalSemanticEmbeddingProvider on failure or missing config.
 */
export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  readonly endpoint: string;
  readonly apiKey?: string;
  private readonly fallback: LocalSemanticEmbeddingProvider;

  constructor(opts: { endpoint: string; name?: string; dimensions?: number; apiKey?: string }) {
    this.endpoint = opts.endpoint;
    this.name = opts.name ?? 'http-embedding';
    this.dimensions = opts.dimensions ?? 1536;
    this.apiKey = opts.apiKey;
    this.fallback = new LocalSemanticEmbeddingProvider(this.dimensions, this.name);
  }

  async embed(text: string): Promise<number[]> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.name,
          input: text,
        }),
      });

      if (!res.ok) {
        return this.fallback.embedSync(text);
      }

      const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
      const vec = data.data?.[0]?.embedding;
      if (Array.isArray(vec) && vec.length > 0) {
        return l2Normalize(vec);
      }
      return this.fallback.embedSync(text);
    } catch {
      return this.fallback.embedSync(text);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}

let activeProvider: EmbeddingProvider | null = null;

/** Returns the active embedding provider based on environment or options. */
export function getEmbeddingProvider(opts?: {
  provider?: string;
  endpoint?: string;
  model?: string;
  dims?: number;
}): EmbeddingProvider {
  if (activeProvider && !opts) return activeProvider;

  const endpoint = opts?.endpoint ?? process.env.LORE_EMBEDDING_ENDPOINT;
  const model = opts?.model ?? process.env.LORE_EMBEDDING_MODEL ?? DEFAULT_VECTOR_MODEL;
  const dims = opts?.dims ?? (Number(process.env.LORE_EMBEDDING_DIMS) || DEFAULT_VECTOR_DIMS);

  if (endpoint) {
    return new HttpEmbeddingProvider({
      endpoint,
      name: model,
      dimensions: dims,
      apiKey: process.env.LORE_EMBEDDING_API_KEY,
    });
  }

  return new LocalSemanticEmbeddingProvider(dims, model);
}

export function setActiveEmbeddingProvider(provider: EmbeddingProvider | null): void {
  activeProvider = provider;
}

/** Formats a claim into searchable text for vector embedding. */
export function extractClaimText(claim: ClaimRow): string {
  let objectText = claim.object_json;
  try {
    objectText = String(JSON.parse(claim.object_json));
  } catch {
    // keep raw json
  }
  return `${claim.subject_id} ${claim.predicate} ${objectText}`.trim();
}

/** Ensure the vector_cache table exists in the database. */
export function ensureVectorCacheTable(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vector_cache (
      claim_id   TEXT NOT NULL,
      model      TEXT NOT NULL,
      dims       INTEGER NOT NULL,
      vector     TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (claim_id, model)
    );
    CREATE INDEX IF NOT EXISTS vector_cache_model ON vector_cache(model);
  `);
}

/** Retrieve a cached claim vector if available. */
export function getCachedClaimVector(
  db: DB,
  claimId: string,
  model = DEFAULT_VECTOR_MODEL,
): number[] | null {
  try {
    const row = db
      .prepare('SELECT vector FROM vector_cache WHERE claim_id = ? AND model = ?')
      .get(claimId, model) as { vector: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.vector) as number[];
  } catch {
    return null;
  }
}

/** Save a claim vector into SQLite cache. */
export function saveCachedClaimVector(
  db: DB,
  claimId: string,
  vector: number[],
  model = DEFAULT_VECTOR_MODEL,
): void {
  try {
    ensureVectorCacheTable(db);
    db.prepare(
      `INSERT OR REPLACE INTO vector_cache (claim_id, model, dims, vector, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(claimId, model, vector.length, JSON.stringify(vector), new Date().toISOString());
  } catch {
    // Gracefully ignore cache write failures
  }
}

/**
 * Gets or computes the vector embedding for a claim, using the SQLite cache when present.
 */
export function getOrComputeClaimVector(
  db: DB,
  claim: ClaimRow,
  provider = getEmbeddingProvider(),
): number[] {
  const cached = getCachedClaimVector(db, claim.id, provider.name);
  if (cached && cached.length === provider.dimensions) {
    return cached;
  }

  const text = extractClaimText(claim);
  const vector =
    provider instanceof LocalSemanticEmbeddingProvider
      ? provider.embedSync(text)
      : generateLocalEmbedding(text, provider.dimensions);

  saveCachedClaimVector(db, claim.id, vector, provider.name);
  return vector;
}

/**
 * Hybrid similarity computation: combines sparse lexical similarity (e.g. Jaccard token overlap)
 * and dense semantic vector similarity.
 *
 * formula: (1 - vectorWeight) * lexicalSim + vectorWeight * vectorSim
 */
export function computeHybridSimilarity(
  lexicalSim: number,
  vectorSim: number,
  vectorWeight = 0.5,
): number {
  const clampedWeight = Math.max(0, Math.min(1, vectorWeight));
  const clampedLexical = Math.max(0, Math.min(1, lexicalSim));
  const clampedVector = Math.max(0, Math.min(1, vectorSim));
  return (1 - clampedWeight) * clampedLexical + clampedWeight * clampedVector;
}
