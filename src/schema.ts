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
  commit_id   TEXT,
  verified_at TEXT,
  status      TEXT NOT NULL DEFAULT 'valid',
  PRIMARY KEY (claim_id, kind, ref)
);

CREATE TABLE IF NOT EXISTS memory_commit (
  id        TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES memory_commit(id),
  merge_parent_id TEXT REFERENCES memory_commit(id),
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

CREATE TABLE IF NOT EXISTS merge_conflict (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ours_tip     TEXT,
  theirs_tip   TEXT,
  subject_id   TEXT NOT NULL,
  predicate    TEXT NOT NULL,
  ours_claim   TEXT,
  theirs_claim TEXT,
  base_claim   TEXT,
  reason       TEXT,
  ts           TEXT NOT NULL,
  resolved     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS file_hash (
  path       TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  mtime_ns   TEXT NOT NULL,
  ctime_ns   TEXT NOT NULL DEFAULT '',
  hash       TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS redaction (
  claim_id      TEXT PRIMARY KEY,
  original_hash TEXT NOT NULL,
  actor         TEXT NOT NULL,
  reason        TEXT,
  ts            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purge_audit (
  claim_id TEXT PRIMARY KEY,
  actor    TEXT NOT NULL,
  reason   TEXT,
  ts       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id           TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claim_read (
  claim_id   TEXT NOT NULL REFERENCES claim(id),
  session_id TEXT NOT NULL,
  ts         TEXT NOT NULL,
  PRIMARY KEY (claim_id, session_id)
);

CREATE TABLE IF NOT EXISTS resolution (
  subject_id TEXT NOT NULL,
  predicate  TEXT NOT NULL,
  take       TEXT NOT NULL CHECK (take IN ('ours','theirs','both')),
  reason     TEXT,
  ts         TEXT NOT NULL,
  applied    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject_id, predicate)
);
`;

export const ONTOLOGY_TEMPLATE = `# Lore ontology — decides which predicates may hold several values.
# cardinality: one  → two agents claiming different values is a conflict (merge must resolve)
# cardinality: many → both values coexist (no conflict)
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
