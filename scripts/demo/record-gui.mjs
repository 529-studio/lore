#!/usr/bin/env node
// Records the dashboard demo used in the README.
//
// Requires Playwright, which is deliberately not a project dependency:
//   npm i -D playwright && npx playwright install chromium
// Start the dashboard first:  lore ui --port 4181
// Then:                       node scripts/demo/record-gui.mjs
//
// Frames are written to a temp directory and assembled with ffmpeg into
// docs/assets/demo-gui.gif and ~/Movies/lore-ui-demo.mp4.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = process.env.LORE_UI_URL ?? 'http://127.0.0.1:4181';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright is not installed: npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

const frames = mkdtempSync(path.join(tmpdir(), 'lore-gui-'));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(BASE);
await page.waitForTimeout(600);

let index = 1;
const shot = async () => {
  await page.screenshot({ path: path.join(frames, `${String(index).padStart(2, '0')}.png`) });
  index += 1;
};

await shot();

await page.fill('#q', 'refund');
await page.waitForTimeout(700);
await shot();

await page.fill('#q', 'stripe');
await page.waitForTimeout(700);
await shot();

await page.fill('#q', '');
await page.selectOption('#state', 'draft');
await page.waitForTimeout(700);
await shot();

await page.selectOption('#state', '');
await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight }));
await page.waitForTimeout(500);
await shot();

await browser.close();

const gif = path.join(ROOT, 'docs', 'assets', 'demo-gui.gif');
const mp4 = path.join(process.env.HOME ?? '.', 'Movies', 'lore-ui-demo.mp4');
const input = path.join(frames, '%02d.png');

const run = (args) => {
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stderr);
    process.exit(1);
  }
};

run(['-y', '-framerate', '1/1.6', '-i', input, '-vf', 'scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse', '-loop', '0', gif]);
run(['-y', '-framerate', '1/1.6', '-i', input, '-vf', 'scale=1280:-2,format=yuv420p', '-r', '30', mp4]);

rmSync(frames, { recursive: true, force: true });
console.log(`wrote ${path.relative(ROOT, gif)} and ${mp4}`);
