export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS entity (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  canonical  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claim (
  id          TEXT PRIMARY KEY,
  subject_id  TEXT NOT NULL REFERENCES entity(id),
  predicate   TEXT NOT NULL,
  object_json TEXT NOT NULL,
  valid_from  TEXT,
  valid_to    TEXT,
  tx_from     TEXT NOT NULL,
  authority   INTEGER NOT NULL CHECK (authority BETWEEN 0 AND 4),
  confidence  REAL NOT NULL,
  author      TEXT NOT NULL,
  supersedes  TEXT REFERENCES claim(id),
  state       TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','active','retracted'))
);
CREATE INDEX IF NOT EXISTS claim_key   ON claim(subject_id, predicate);
CREATE INDEX IF NOT EXISTS claim_state ON claim(state);
CREATE INDEX IF NOT EXISTS claim_author ON claim(author);

CREATE TABLE IF NOT EXISTS evidence (
  claim_id    TEXT NOT NULL REFERENCES claim(id),
  kind        TEXT NOT NULL,
  ref         TEXT NOT NULL,
  hash        TEXT,
  verified_at TEXT,
  status      TEXT NOT NULL DEFAULT 'valid',
  PRIMARY KEY (claim_id, kind, ref)
);

CREATE TABLE IF NOT EXISTS memory_commit (
  id        TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES memory_commit(id),
  tree_hash TEXT NOT NULL,
  message   TEXT NOT NULL,
  author    TEXT NOT NULL,
  ts        TEXT NOT NULL,
  kind      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commit_entry (
  commit_id TEXT NOT NULL REFERENCES memory_commit(id),
  claim_id  TEXT NOT NULL REFERENCES claim(id),
  op        TEXT NOT NULL CHECK (op IN ('add','supersede','retract','restore')),
  PRIMARY KEY (commit_id, claim_id, op)
);

CREATE TABLE IF NOT EXISTS ref (
  name      TEXT PRIMARY KEY,
  commit_id TEXT NOT NULL REFERENCES memory_commit(id)
);

CREATE TABLE IF NOT EXISTS merge_decision (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  commit_id  TEXT NOT NULL REFERENCES memory_commit(id),
  subject_id TEXT NOT NULL,
  predicate  TEXT NOT NULL,
  winner     TEXT,
  loser      TEXT,
  rule       TEXT NOT NULL,
  reason     TEXT,
  ts         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const ONTOLOGY_TEMPLATE = `# Lore ontology — quyết định predicate nào được phép có nhiều giá trị.
# cardinality: one  → hai agent nói hai giá trị khác nhau = conflict (merge phải giải)
# cardinality: many → hai giá trị cùng tồn tại (không conflict)
predicates:
  declared_dependency:  { cardinality: one,  domain: pkg }
  defines_script:       { cardinality: many, domain: file }
  imports_module:       { cardinality: many, domain: file }
  exposes_route:        { cardinality: many, domain: file }
  read_by:              { cardinality: many, domain: env }
  uses_image:           { cardinality: many, domain: file }
  publishes_port:       { cardinality: many, domain: file }
  has_make_target:      { cardinality: many, domain: file }
  has_section:          { cardinality: many, domain: doc }
  main_entry:           { cardinality: one,  domain: pkg }
  package_name:         { cardinality: one,  domain: pkg }
  requires_idempotency_key: { cardinality: one, domain: symbol }
  uses_library:         { cardinality: many, domain: symbol }
  has_known_bug:        { cardinality: many, domain: symbol }
  entrypoint:           { cardinality: one,  domain: file }
`;
