// Publish a markdown file to the Outline wiki (docs.529studio.site).
// Usage: OUTLINE_API_TOKEN=... node scripts/publish-outline.mjs docs/lore-plan.md
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.OUTLINE_URL ?? 'https://docs.529studio.site';
const COLLECTION = process.env.OUTLINE_COLLECTION_ID ?? '4a71c40f-f845-4820-b49f-4fde02fc53e3';
const file = process.argv[2] ?? 'docs/lore-plan.md';

function token() {
  if (process.env.OUTLINE_API_TOKEN) return process.env.OUTLINE_API_TOKEN.trim();
  try {
    return readFileSync(path.join(os.homedir(), '.config', 'outline.token'), 'utf8').trim();
  } catch {
    throw new Error('no token: set OUTLINE_API_TOKEN or ~/.config/outline.token');
  }
}

async function api(method, body = {}) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) {
    throw new Error(`${method} failed: ${res.status} ${json.message ?? JSON.stringify(json)}`);
  }
  return json.data;
}

let text = readFileSync(file, 'utf8');
const heading = text.match(/^#\s+(.+)$/m);
const title = process.env.OUTLINE_TITLE ?? heading?.[1]?.trim() ?? path.basename(file, '.md');
text = text.replace(/^#\s+.+\r?\n/, '');

const existing = await api('documents.list', { collectionId: COLLECTION, limit: 100 });
const found = (existing ?? []).find((d) => d.title === title);

const doc = found
  ? await api('documents.update', { id: found.id, title, text, publish: true })
  : await api('documents.create', { title, text, collectionId: COLLECTION, publish: true });

console.log(`${found ? 'updated' : 'created'}: ${title}`);
console.log(`${BASE}${doc.url}`);
