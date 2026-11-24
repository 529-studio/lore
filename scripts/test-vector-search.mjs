#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  dotProduct,
  magnitude,
  l2Normalize,
  cosineSimilarity,
  euclideanDistance,
  tokenizeCodeTerms,
  extractSemanticFeatures,
  generateLocalEmbedding,
  LocalSemanticEmbeddingProvider,
  getEmbeddingProvider,
  computeHybridSimilarity,
  ensureVectorCacheTable,
  saveCachedClaimVector,
  getCachedClaimVector,
  getOrComputeClaimVector,
  extractClaimText,
  DEFAULT_VECTOR_DIMS,
} from '../dist/search/vector.js';
import { createDb } from '../dist/db.js';
import { searchMemory } from '../dist/retrieval.js';
import { upsertClaim, makeCommit } from '../dist/model.js';

console.log('[TEST] 1. Vector math primitives...');
const v1 = [1, 2, 3];
const v2 = [4, 5, 6];
assert.equal(dotProduct(v1, v2), 4 + 10 + 18); // 32
assert.equal(magnitude([3, 4]), 5);

const normV1 = l2Normalize(v1);
assert.ok(Math.abs(magnitude(normV1) - 1.0) < 1e-6);

const zeroNorm = l2Normalize([0, 0, 0]);
assert.deepEqual(zeroNorm, [0, 0, 0]);

assert.ok(Math.abs(cosineSimilarity(normV1, normV1) - 1.0) < 1e-6);
assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
assert.equal(euclideanDistance([1, 2], [1, 2]), 0);
assert.equal(euclideanDistance([0, 0], [3, 4]), 5);
console.log('[OK] Vector math primitives passed');

console.log('[TEST] 2. Code tokenization & feature extraction...');
const tokens = tokenizeCodeTerms('refundOrder_handler-v2/checkout.ts');
assert.ok(tokens.includes('refund'));
assert.ok(tokens.includes('order'));
assert.ok(tokens.includes('handler'));
assert.ok(tokens.includes('checkout'));

const features = extractSemanticFeatures('sym:src/orders.ts#refundOrder requires_idempotency_key');
assert.ok(features.some((f) => f.feature.startsWith('w:refund')));
assert.ok(features.some((f) => f.feature.startsWith('c3:ide')));
assert.ok(features.some((f) => f.feature.startsWith('c4:idem')));
console.log('[OK] Code tokenization and features passed');

console.log('[TEST] 3. Deterministic embedding generation & semantic similarity...');
const emb1 = generateLocalEmbedding('requires_idempotency_key');
const emb2 = generateLocalEmbedding('requires_idempotency_key');
assert.equal(emb1.length, DEFAULT_VECTOR_DIMS);
assert.deepEqual(emb1, emb2, 'embedding must be strictly deterministic');
assert.ok(Math.abs(magnitude(emb1) - 1.0) < 1e-6);

// Morphological/stem variants should have strong cosine similarity
const simStem = cosineSimilarity(
  generateLocalEmbedding('requires_idempotency_key'),
  generateLocalEmbedding('idempotent token request'),
);
assert.ok(simStem > 0.3, `expected stem similarity > 0.3, got ${simStem}`);

const simDirectStem = cosineSimilarity(
  generateLocalEmbedding('requires_idempotency_key'),
  generateLocalEmbedding('idempotent_key'),
);
assert.ok(simDirectStem > 0.45, `expected direct stem similarity > 0.45, got ${simDirectStem}`);

const simCode = cosineSimilarity(
  generateLocalEmbedding('refundOrder payment refund'),
  generateLocalEmbedding('refund_order process payment'),
);
assert.ok(simCode > 0.6, `expected code similarity > 0.6, got ${simCode}`);

// Unrelated concepts should have low similarity
const simUnrelated = cosineSimilarity(
  generateLocalEmbedding('sqlite database wal journal checkpoint'),
  generateLocalEmbedding('strawberry chocolate baking recipe'),
);
assert.ok(simUnrelated < 0.25, `expected unrelated similarity < 0.25, got ${simUnrelated}`);
console.log('[OK] Deterministic embedding generation passed');

console.log('[TEST] 4. Embedding provider interface & hybrid similarity...');
const provider = new LocalSemanticEmbeddingProvider(64, 'test-fnv64');
assert.equal(provider.dimensions, 64);
assert.equal(provider.name, 'test-fnv64');
const emb64 = provider.embedSync('test phrase');
assert.equal(emb64.length, 64);

const batch = provider.embedBatch(['text a', 'text b']);
assert.equal(batch.length, 2);
assert.equal(batch[0].length, 64);

const defaultProv = getEmbeddingProvider();
assert.equal(defaultProv.name, 'local-fnv128');

const hybrid1 = computeHybridSimilarity(0.2, 0.8, 0.5);
assert.ok(Math.abs(hybrid1 - 0.5) < 1e-6);

const hybrid2 = computeHybridSimilarity(1.0, 0.0, 0.3);
assert.ok(Math.abs(hybrid2 - 0.7) < 1e-6);
console.log('[OK] Provider interface & hybrid similarity passed');

console.log('[TEST] 5. SQLite vector cache persistence...');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vec-test-'));
try {
  const db = createDb(tempDir);
  ensureVectorCacheTable(db);

  const testVec = [0.1, 0.2, 0.3, 0.4];
  saveCachedClaimVector(db, 'claim_123', testVec, 'test-model');

  const retrieved = getCachedClaimVector(db, 'claim_123', 'test-model');
  assert.ok(retrieved);
  assert.deepEqual(retrieved, testVec);

  const missing = getCachedClaimVector(db, 'non_existent', 'test-model');
  assert.equal(missing, null);

  const mockClaim = {
    id: 'claim_test',
    subject_id: 'sym:src/orders.ts#refundOrder',
    predicate: 'requires_idempotency_key',
    object_json: JSON.stringify(true),
    valid_from: null,
    valid_to: null,
    tx_from: new Date().toISOString(),
    authority: 1,
    confidence: 1.0,
    author: 'agent:test',
    state: 'active',
    supersedes: null,
    trust: 'canonical',
    ttl_days: null,
    last_verified_at: null,
    confirmations: 0,
    contradictions: 0,
    written_by: 'agent',
    agent_id: null,
    session_id: null,
    run_id: null,
    tags_json: '[]',
    invalidated_by_json: null,
  };

  const text = extractClaimText(mockClaim);
  assert.equal(text, 'sym:src/orders.ts#refundOrder requires_idempotency_key true');

  const computedVec = getOrComputeClaimVector(db, mockClaim);
  assert.equal(computedVec.length, DEFAULT_VECTOR_DIMS);

  // Second fetch should come from cache
  const cachedVec = getCachedClaimVector(db, 'claim_test', 'local-fnv128');
  assert.ok(cachedVec);
  assert.deepEqual(cachedVec, computedVec);

  console.log('[OK] SQLite vector cache persistence passed');

  console.log('[TEST] 6. End-to-end semantic hybrid searchMemory integration...');
  // Initialize repository with active canonical claims
  fs.mkdirSync(path.join(tempDir, '.lore'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, '.lore', 'config.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(tempDir, 'lore.ontology.yml'), 'predicates: {}\n');

  db.prepare(`
    INSERT INTO entity (id, kind, canonical, created_at)
    VALUES
      ('sym:src/orders.ts#refundOrder', 'symbol', 'sym:src/orders.ts#refundOrder', datetime('now')),
      ('file:src/auth.ts', 'file', 'file:src/auth.ts', datetime('now'))
  `).run();

  db.prepare(`
    INSERT INTO claim (id, subject_id, predicate, object_json, tx_from, authority, confidence, author, state, trust, written_by)
    VALUES
      ('c_order_1', 'sym:src/orders.ts#refundOrder', 'requires_idempotency_key', 'true', datetime('now'), 1, 1.0, 'tester', 'active', 'canonical', 'agent'),
      ('c_auth_1', 'file:src/auth.ts', 'exposes_route', '"/login"', datetime('now'), 1, 1.0, 'tester', 'active', 'canonical', 'agent')
  `).run();

  makeCommit(db, {
    ref: 'main',
    message: 'test commit',
    author: 'tester',
    kind: 'write',
    entries: [
      { claim_id: 'c_order_1', op: 'add' },
      { claim_id: 'c_auth_1', op: 'add' },
    ],
  });

  // Query: "idempotent payment"
  // A) Lexical search (default, without semantic):
  // "idempotent" does not match "requires_idempotency_key" verbatim via Jaccard.
  const lexicalRes = searchMemory(db, tempDir, {
    query: 'idempotent payment',
    semantic: false,
  });
  assert.equal(lexicalRes.hits.length, 0, 'lexical-only search should not find stem mismatch');

  // B) Semantic hybrid search:
  // Subwords and semantic embeddings recognize "idempotent" <-> "requires_idempotency_key"
  const semanticRes = searchMemory(db, tempDir, {
    query: 'idempotent payment',
    semantic: true,
    vectorWeight: 0.6,
  });

  assert.ok(semanticRes.hits.length > 0, 'semantic search must find the claim');
  const hit = semanticRes.hits[0];
  assert.equal(hit.claim.id, 'c_order_1');
  assert.ok(hit.reasons.some((r) => r.includes('hybrid text')), 'reasons must report hybrid text scoring');
  console.log('[OK] End-to-end semantic hybrid searchMemory passed');

  db.close();
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('[OK] All vector embeddings & semantic hybrid search tests passed cleanly!');
