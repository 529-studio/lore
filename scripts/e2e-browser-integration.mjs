#!/usr/bin/env node
// E2E test using Playwright and Chrome DevTools
import { chromium } from 'playwright';
import { startUi } from '../dist/ui/server.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const work = mkdtempSync(path.join(tmpdir(), 'lore-e2e-'));
const CLI = path.resolve(process.env.LORE_ROOT || process.cwd(), 'dist/cli.js');
console.log('CLI path:', CLI);
// Initialize repository first
const initResult = spawnSync(process.execPath, [CLI, 'init'], { cwd: work });
console.log('Init status:', initResult.status);
console.log('Init stderr:', initResult.stderr.toString());
const ingestResult = spawnSync(process.execPath, [CLI, 'ingest'], { cwd: work });
console.log('Ingest status:', ingestResult.status);

console.log('Work dir:', work);
console.log('LS work dir:', spawnSync('ls', ['-a', work]).stdout.toString());
console.log('LS .lore dir:', spawnSync('ls', ['-a', path.join(work, '.lore')]).stdout.toString());

const handle = await startUi(work, { port: 0 });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  console.log(`Navigating to ${handle.url}`);
  await page.goto(handle.url);

  // Example verification using Playwright
  const title = await page.title();
  console.log(`Page title: ${title}`);

  // Example integration with chrome-devtools (via CDP if needed, here simple check)
  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push(msg.text()));

  await page.waitForLoadState('networkidle');

  if (consoleLogs.length > 0) {
    console.warn('Console logs found:', consoleLogs);
  }

  await page.waitForLoadState('networkidle');

  // Debugging: Print page content if component not found
  await page.waitForSelector('#graph-cluster-mode', { timeout: 10000, state: 'attached' });
  const hasLoreGraph = await page.locator('#graph-cluster-mode').count();
  if (hasLoreGraph === 0) {
    const content = await page.content();
    console.log('Page content snippet:', content.substring(0, 500));
    throw new Error('Lore graph component not found');
  }

  console.log('[OK] E2E browser smoke test passed');
} catch (error) {
  console.error('[ERR] E2E test failed:', error);
  process.exit(1);
} finally {
  await browser.close();
  await handle.close();
}
