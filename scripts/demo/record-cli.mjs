#!/usr/bin/env node
// Records the CLI demo used in the README.
// Runs the real commands in a throwaway repository, renders the transcript as
// frames, and assembles a GIF with ffmpeg. Requires macOS/Linux fonts + ffmpeg.
//
// Usage: node scripts/demo/record-cli.mjs [--keep]
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const OUT = path.join(ROOT, 'docs', 'assets', 'demo-cli.gif');

const WIDTH = 880;
const HEIGHT = 560;
const PAD = 28;
const LINE_HEIGHT = 23;
const FONT_SIZE = 14.5;
const FPS = 10;

const work = mkdtempSync(path.join(tmpdir(), 'lore-demo-'));
execFileSync('git', ['init', '-q'], { cwd: work });
mkdirSync(path.join(work, 'src'));
writeFileSync(
  path.join(work, 'package.json'),
  JSON.stringify(
    {
      name: 'demo-app',
      scripts: { dev: 'node src/server.ts', test: 'node tests/run.ts' },
      dependencies: { zod: '^4.0.0', pg: '^8.0.0', express: '^5.0.0' },
    },
    null,
    2,
  ),
);
writeFileSync(path.join(work, 'src', 'db.ts'), "import pg from 'pg';\nconst dsn = process.env.DATABASE_URL;\nexport const db = new pg.Pool({ connectionString: dsn });\n");
writeFileSync(path.join(work, 'src', 'server.ts'), "import express from 'express';\nimport { db } from './db';\nconst port = process.env.PORT;\nexport const app = express();\n");
writeFileSync(path.join(work, 'src', 'routes.ts'), "import { db } from './db';\nrouter.get('/health', () => db.ping());\nrouter.get('/users', () => db.users());\n");
writeFileSync(path.join(work, 'README.md'), '# Demo app\n\n## Overview\n\nA small service.\n\n## Usage\n\nRun it.\n');

function lore(args, { echo = true } = {}) {
  const output = execFileSync(process.execPath, [CLI, ...args], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  const lines = output.split('\n').filter((line) => line.trim());
  return { echo, command: `lore ${args.join(' ')}`, lines };
}

const steps = [];
steps.push(lore(['init']));
steps.push(lore(['ingest']));
steps.push(lore(['search', 'DATABASE_URL', '--files', 'src/db.ts']));

// Simulate drift with a real edit.
writeFileSync(path.join(work, 'src', 'db.ts'), `// drift\n${execFileSync('cat', [path.join(work, 'src', 'db.ts')], { encoding: 'utf8' })}`);
steps.push({ echo: true, command: 'echo "// drift" >> src/db.ts', lines: [] });
steps.push(lore(['status']));

const claim = execFileSync(process.execPath, [CLI, 'blame', 'env:DATABASE_URL'], {
  cwd: work,
  encoding: 'utf8',
  env: { ...process.env, NO_COLOR: '1' },
}).match(/c_[0-9a-f]{8,}/)?.[0];
if (claim) steps.push(lore(['verify', claim, '--accept']));

// ---------------------------------------------------------------- transcript
const MAX_LINES = 21;
const WIDTH_CHARS = 92;
const transcript = [];
const LIMITS = [2, 4, 4, 0, 3, 2];
const workReal = realpathSync(work);
steps.forEach((step, index) => {
  if (!step.echo) return;
  let clean = step.lines.map((line) =>
    line.split(workReal).join('~/demo-app').split(work).join('~/demo-app'),
  );
  if (index === 4) clean = clean.filter((line) => /claims|stale/.test(line));
  transcript.push({ kind: 'prompt', text: step.command });
  for (const line of clean.slice(0, LIMITS[index] ?? 4)) {
    transcript.push({ kind: 'out', text: line.length > WIDTH_CHARS ? `${line.slice(0, WIDTH_CHARS - 1)}…` : line });
  }
});
const visible = transcript.slice(0, MAX_LINES);

// ---------------------------------------------------------------- frames
const escapeXml = (value) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function frameSvg(lines, cursor) {
  const rows = lines
    .map((line, index) => {
      const y = PAD + 10 + index * LINE_HEIGHT;
      const isPrompt = line.kind === 'prompt';
      const colour = isPrompt ? '#e6edf3' : '#8b949e';
      const prefix = isPrompt ? '<tspan fill="#58a6ff">$ </tspan>' : '';
      return `<text x="${PAD}" y="${y}" font-family="Menlo, DejaVu Sans Mono, monospace" font-size="${FONT_SIZE}" fill="${colour}">${prefix}${escapeXml(line.text)}</text>`;
    })
    .join('');
  const cursorY = PAD + 10 + lines.length * LINE_HEIGHT;
  const cursorMark = cursor
    ? `<rect x="${PAD}" y="${cursorY - 12}" width="9" height="16" fill="#58a6ff"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" rx="12" fill="#0d1117"/>
  <rect width="${WIDTH}" height="34" rx="12" fill="#161b22"/>
  <circle cx="24" cy="17" r="5" fill="#30363d"/><circle cx="42" cy="17" r="5" fill="#30363d"/><circle cx="60" cy="17" r="5" fill="#30363d"/>
  <text x="${WIDTH - 24}" y="22" text-anchor="end" font-family="Menlo, monospace" font-size="11" fill="#484f58">lore</text>
  ${rows}${cursorMark}
</svg>`;
}

const framesDir = path.join(work, 'frames');
mkdirSync(framesDir);
let frame = 0;
const render = async (lines, cursor) => {
  const name = path.join(framesDir, `f${String(frame).padStart(4, '0')}.png`);
  await sharp(Buffer.from(frameSvg(lines, cursor))).png().toFile(name);
  frame += 1;
};

// Reveal two lines per step so the GIF stays small, then hold.
for (let index = 1; index <= visible.length; index += 2) {
  await render(visible.slice(0, index), true);
}
for (let hold = 0; hold < 12; hold += 1) {
  await render(visible, hold % 2 === 0);
}

const gif = path.join(work, 'out.gif');
const ffmpeg = spawnSync(
  'ffmpeg',
  [
    '-y',
    '-framerate', String(FPS),
    '-i', path.join(framesDir, 'f%04d.png'),
    '-vf', 'scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer',
    '-loop', '0',
    gif,
  ],
  { encoding: 'utf8' },
);
if (ffmpeg.status !== 0) {
  console.error(ffmpeg.stderr);
  process.exit(1);
}

mkdirSync(path.dirname(OUT), { recursive: true });
execFileSync('cp', [gif, OUT]);
const size = execFileSync('du', ['-h', OUT], { encoding: 'utf8' }).split('\t')[0];
console.log(`wrote ${path.relative(ROOT, OUT)} (${size}, ${frame} frames)`);

if (!process.argv.includes('--keep')) rmSync(work, { recursive: true, force: true });
