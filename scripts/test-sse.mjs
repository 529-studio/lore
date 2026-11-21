#!/usr/bin/env node
import { startUi } from '../dist/ui/server.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(path.join(tmpdir(), 'lore-sse-test-'));

const CLI = path.join(ROOT, 'dist', 'cli.js');
spawnSync(process.execPath, [CLI, 'init'], { cwd: work });

mkdirSync(path.join(work, 'src'));
writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'sse-test' }));

const handle = await startUi(work, { port: 0 });

try {
  const eventsUrl = `${handle.url}/api/events`;
  console.log(`Connecting to ${eventsUrl}...`);
  const eventRes = await fetch(eventsUrl);
  
  if (!eventRes.ok || !eventRes.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error(`SSE endpoint failed: status ${eventRes.status}, content-type: ${eventRes.headers.get('content-type')}`);
  }

  const reader = eventRes.body.getReader();
  const decoder = new TextDecoder();
  let initialChunk = '';
  
  // Read first chunk to verify connection
  const { value, done } = await reader.read();
  if (done) throw new Error('SSE stream closed immediately');
  initialChunk = decoder.decode(value);
  
  if (!initialChunk.includes('event: connected')) {
    throw new Error(`SSE initial event missing or mismatch: ${initialChunk}`);
  }
  
  console.log('[OK] SSE connection verified');
  await reader.cancel();
} finally {
  await handle.close();
}
