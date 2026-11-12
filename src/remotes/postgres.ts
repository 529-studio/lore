import { Client } from 'pg';
import type { Bundle, ImportResult } from '../sync.js';

const TABLE = `CREATE TABLE IF NOT EXISTS lore_bundles (
  repo_id    text PRIMARY KEY,
  bundle     jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

function connect(url: string): Client {
  return new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
}

export async function pgFetch(
  url: string,
  repoId: string,
  importFn: (bundle: Bundle) => ImportResult,
): Promise<ImportResult> {
  const client = connect(url);
  await client.connect();
  try {
    await client.query(TABLE);
    const { rows } = await client.query('SELECT bundle FROM lore_bundles WHERE repo_id = $1', [repoId]);
    if (!rows[0]) throw new Error(`no bundle for repo ${repoId} in postgres; push one first`);
    return importFn(rows[0].bundle as Bundle);
  } finally {
    await client.end();
  }
}

/**
 * Read-modify-write under a per-repository advisory lock, so two people pushing at
 * the same time cannot drop each other's commits.
 */
export async function pgPush(
  url: string,
  repoId: string,
  importFn: (bundle: Bundle) => ImportResult,
  buildFn: () => Bundle,
): Promise<ImportResult> {
  const client = connect(url);
  await client.connect();
  try {
    await client.query(TABLE);
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [repoId]);
    const { rows } = await client.query('SELECT bundle FROM lore_bundles WHERE repo_id = $1', [repoId]);

    let imported: ImportResult = { entities: 0, claims: 0, commits: 0, merge: 'none' };
    if (rows[0]) imported = importFn(rows[0].bundle as Bundle);

    await client.query(
      `INSERT INTO lore_bundles(repo_id, bundle) VALUES ($1, $2)
       ON CONFLICT (repo_id) DO UPDATE SET bundle = excluded.bundle, updated_at = now()`,
      [repoId, buildFn()],
    );
    await client.query('COMMIT');
    return imported;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may be gone */
    }
    throw error;
  } finally {
    await client.end();
  }
}
