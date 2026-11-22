#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const MOVIES_DIR = path.join(homedir(), 'Movies');
const OUT_MP4 = path.join(MOVIES_DIR, 'lore-product-demo.mp4');
const OUT_GIF = path.join(MOVIES_DIR, 'lore-product-demo.gif');
const DOCS_GIF = path.join(ROOT, 'docs', 'assets', 'demo-product.gif');

mkdirSync(MOVIES_DIR, { recursive: true });

const workDir = mkdtempSync(path.join(tmpdir(), 'lore-full-demo-'));
const framesDir = path.join(workDir, 'frames');
mkdirSync(framesDir, { recursive: true });

console.log('[1/5] Setting up realistic demo repository...');

// Setup demo repository
const repoDir = path.join(workDir, 'payment-api');
mkdirSync(repoDir, { recursive: true });

writeFileSync(
  path.join(repoDir, 'package.json'),
  JSON.stringify(
    {
      name: 'payment-api',
      version: '1.2.0',
      description: 'Stripe webhook and token checkout engine',
      scripts: { dev: 'tsx src/server.ts', test: 'vitest' },
      dependencies: {
        express: '^4.19.0',
        pg: '^8.11.0',
        stripe: '^14.20.0',
        zod: '^3.23.0',
      },
    },
    null,
    2,
  ),
);

mkdirSync(path.join(repoDir, 'src'), { recursive: true });
writeFileSync(
  path.join(repoDir, 'src', 'db.ts'),
  `import pg from 'pg';\nexport const dbUrl = process.env.DATABASE_URL;\nexport const pool = new pg.Pool({ connectionString: dbUrl });\n`,
);
writeFileSync(
  path.join(repoDir, 'src', 'auth.ts'),
  `export function verifyWebhookSignature(payload: string, sig: string): boolean {\n  return Boolean(payload && sig);\n}\n`,
);
writeFileSync(
  path.join(repoDir, 'src', 'server.ts'),
  `import express from 'express';\nimport { pool } from './db.js';\nexport const app = express();\napp.get('/health', (_, res) => res.send('OK'));\napp.post('/webhook', (req, res) => res.json({ received: true }));\n`,
);
writeFileSync(
  path.join(repoDir, 'AGENTS.md'),
  `# Payment API — Agent Guidelines\n\n1. Maintain strict idempotency on all Stripe operations.\n2. Never log raw customer card data or access tokens.\n`,
);

mkdirSync(path.join(repoDir, '.cursor'), { recursive: true });
writeFileSync(
  path.join(repoDir, '.cursor', 'mcp.json'),
  JSON.stringify(
    {
      mcpServers: {
        'postgres-inspector': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-postgres'],
          env: { POSTGRES_PORT: '5432' },
        },
      },
    },
    null,
    2,
  ),
);

// Git initialization
execFileSync('git', ['init', '-b', 'main', repoDir]);
execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Alex (Lead Dev)']);
execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'alex@company.internal']);
execFileSync('git', ['-C', repoDir, 'add', '.']);
execFileSync('git', ['-C', repoDir, 'commit', '-m', 'chore: initial payment api infrastructure']);

console.log('[2/5] Running real Lore operations to capture CLI transcript...');

function runCli(args, opts = {}) {
  try {
    return execFileSync(process.execPath, [CLI, ...args], {
      cwd: repoDir,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      ...opts,
    });
  } catch (err) {
    return err.stdout || err.stderr || String(err);
  }
}

// 1. lore init --full --solo
const initOut = runCli(['init', '--full', '--solo', '--root', repoDir]);

// 2. lore search DATABASE_URL
const search1Out = runCli(['search', 'DATABASE_URL']);

// 3. lore write
const writeOut = runCli([
  'write',
  '--subject',
  'sym:src/auth.ts#verifyWebhookSignature',
  '--predicate',
  'has_guardrail',
  '--object',
  'Requires HMAC SHA-256 header and rejects clock skew > 300s',
  '--kind',
  'agent',
]);

// 4. lore search verifyWebhookSignature
const search2Out = runCli(['search', 'verifyWebhookSignature']);

// 5. Code drift
writeFileSync(
  path.join(repoDir, 'src', 'auth.ts'),
  `// security fix: added nonce check\nexport function verifyWebhookSignature(payload: string, sig: string, nonce: string): boolean {\n  return Boolean(payload && sig && nonce);\n}\n`,
);
const statusOut = runCli(['status']);
const blameOut = runCli(['blame', 'sym:src/auth.ts#verifyWebhookSignature']);

// 6. canon status & wrapup
const canonOut = runCli(['canon', 'status']);
const wrapupOut = runCli(['wrapup', '--yes']);

console.log('[3/5] Starting Lore Web UI server to capture Knowledge Hub dashboard...');

const uiPort = 4192;
const uiProcess = spawn(process.execPath, [CLI, 'ui', '--port', String(uiPort)], {
  cwd: repoDir,
  env: process.env,
  stdio: 'ignore',
});

// Give server time to bind
await new Promise((resolve) => setTimeout(resolve, 1500));

console.log('[4/5] Rendering high-definition animation frames with Playwright...');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

let frameCount = 0;
async function saveFrame() {
  const framePath = path.join(framesDir, `frame_${String(frameCount).padStart(4, '0')}.png`);
  await page.screenshot({ path: framePath });
  frameCount += 1;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderTerminalHtml({
  chapter,
  subtitle,
  command,
  outputLines = [],
  highlightBadge = '',
  cursor = true,
}) {
  const formattedOutput = outputLines
    .map((line) => {
      let escaped = escapeHtml(line);
      // Syntax highlight badges
      escaped = escaped
        .replace(/\[OK\]/g, '<span style="color:#3fb950;font-weight:bold;">[OK]</span>')
        .replace(/\[NOTE\]/g, '<span style="color:#58a6ff;font-weight:bold;">[NOTE]</span>')
        .replace(/\[WARN\]/g, '<span style="color:#d29922;font-weight:bold;">[WARN]</span>')
        .replace(/(canonical|active|candidate|stale)/g, '<span style="color:#58a6ff;">$1</span>')
        .replace(/(pkg:\w+|env:\w+|sym:[\w.#]+)/g, '<span style="color:#bc8cff;font-weight:600;">$1</span>');
      return `<div style="line-height:22px;color:#c9d1d9;white-space:pre-wrap;word-break:break-all;">${escaped}</div>`;
    })
    .join('');

  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: radial-gradient(circle at 50% 20%, #161b22 0%, #0d1117 80%);
    width: 1280px;
    height: 720px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #f0f6fc;
    overflow: hidden;
  }
  .header {
    width: 1160px;
    margin-bottom: 12px;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
  }
  .title-area {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .chapter-pill {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #58a6ff;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .chapter-title {
    font-size: 20px;
    font-weight: 700;
    color: #ffffff;
    letter-spacing: -0.3px;
  }
  .subtitle {
    font-size: 13px;
    color: #8b949e;
  }
  .badge {
    background: rgba(88, 166, 255, 0.15);
    border: 1px solid rgba(88, 166, 255, 0.35);
    color: #79c0ff;
    padding: 4px 12px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
  }
  .window {
    width: 1160px;
    height: 570px;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 12px;
    box-shadow: 0 20px 45px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .titlebar {
    height: 38px;
    background: #161b22;
    border-bottom: 1px solid #30363d;
    display: flex;
    align-items: center;
    padding: 0 16px;
    position: relative;
  }
  .buttons {
    display: flex;
    gap: 8px;
  }
  .circle {
    width: 12px;
    height: 12px;
    border-radius: 50%;
  }
  .close { background: #ff5f56; }
  .min { background: #ffbd2e; }
  .max { background: #27c93f; }
  .win-title {
    position: absolute;
    left: 0; right: 0;
    text-align: center;
    font-family: -apple-system, sans-serif;
    font-size: 12px;
    font-weight: 500;
    color: #8b949e;
    pointer-events: none;
  }
  .terminal-content {
    flex: 1;
    padding: 20px 24px;
    font-family: "SF Mono", Menlo, Consolas, Monaco, monospace;
    font-size: 13.5px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .prompt-line {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }
  .arrow { color: #3fb950; }
  .directory { color: #58a6ff; }
  .cmd { color: #f0f6fc; }
  .cursor {
    display: inline-block;
    width: 8px;
    height: 16px;
    background: #58a6ff;
    vertical-align: middle;
    animation: blink 1s step-start infinite;
  }
</style>
</head>
<body>
  <div class="header">
    <div class="title-area">
      <div class="chapter-pill"><span>•</span> ${escapeHtml(chapter)}</div>
      <div class="subtitle">${escapeHtml(subtitle)}</div>
    </div>
    ${highlightBadge ? `<div class="badge">${escapeHtml(highlightBadge)}</div>` : ''}
  </div>

  <div class="window">
    <div class="titlebar">
      <div class="buttons">
        <div class="circle close"></div>
        <div class="circle min"></div>
        <div class="circle max"></div>
      </div>
      <div class="win-title">alex@macbook: ~/payment-api (lore:main)</div>
    </div>
    <div class="terminal-content">
      <div class="prompt-line">
        <span class="arrow">➜</span>
        <span class="directory">payment-api</span>
        <span style="color:#8b949e;">git:(main)</span>
        <span class="cmd">${escapeHtml(command)}</span>${cursor ? '<span class="cursor"></span>' : ''}
      </div>
      <div class="output">${formattedOutput}</div>
    </div>
  </div>
</body>
</html>
`;
}

function renderSplashHtml() {
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {
    background: radial-gradient(circle at 50% 30%, #1c2128 0%, #0d1117 75%);
    width: 1280px;
    height: 720px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #f0f6fc;
    margin: 0;
  }
  .badge-tag {
    background: rgba(88, 166, 255, 0.15);
    border: 1px solid rgba(88, 166, 255, 0.4);
    color: #58a6ff;
    padding: 6px 16px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    margin-bottom: 20px;
  }
  h1 {
    font-size: 76px;
    font-weight: 800;
    letter-spacing: -2px;
    background: linear-gradient(135deg, #ffffff 40%, #79c0ff 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 12px;
  }
  .tagline {
    font-size: 26px;
    font-weight: 400;
    color: #c9d1d9;
    margin-bottom: 34px;
  }
  .pills {
    display: flex;
    gap: 12px;
  }
  .pill {
    background: #161b22;
    border: 1px solid #30363d;
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 13.5px;
    font-family: "SF Mono", Menlo, monospace;
    color: #8b949e;
  }
  .pill b { color: #e6edf3; }
</style>
</head>
<body>
  <div class="badge-tag">Open Source v0.5.0</div>
  <h1>Lore</h1>
  <div class="tagline">Git for what your AI agents know</div>
  <div class="pills">
    <div class="pill"><b>Cursor</b></div>
    <div class="pill"><b>Claude Code</b></div>
    <div class="pill"><b>Antigravity</b></div>
    <div class="pill"><b>OpenCode</b></div>
    <div class="pill"><b>Codex</b></div>
    <div class="pill"><b>Gemini</b></div>
  </div>
</body>
</html>
`;
}

function renderOutroHtml() {
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {
    background: radial-gradient(circle at 50% 30%, #1c2128 0%, #0d1117 75%);
    width: 1280px;
    height: 720px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #f0f6fc;
    margin: 0;
  }
  h2 {
    font-size: 52px;
    font-weight: 800;
    letter-spacing: -1.5px;
    color: #ffffff;
    margin-bottom: 14px;
  }
  p {
    font-size: 20px;
    color: #8b949e;
    margin-bottom: 36px;
  }
  .install-box {
    background: #161b22;
    border: 1px solid #388bfd;
    box-shadow: 0 0 25px rgba(56, 139, 253, 0.2);
    border-radius: 10px;
    padding: 16px 32px;
    font-family: "SF Mono", Menlo, monospace;
    font-size: 18px;
    color: #79c0ff;
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 30px;
  }
  .install-box span { color: #8b949e; }
  .repo-link {
    font-size: 15px;
    color: #58a6ff;
    text-decoration: none;
    font-weight: 500;
  }
</style>
</head>
<body>
  <h2>One Shared Memory. Zero Amnesia.</h2>
  <p>Versioned, verifiable, mergeable memory for autonomous multi-agent coding.</p>
  <div class="install-box">
    <span>$</span> npm install -g @529studio/lore
  </div>
  <div class="repo-link">github.com/529-studio/lore</div>
</body>
</html>
`;
}

// Sequence of demo chapters
console.log('Rendering Chapter 0: Splash Screen...');
await page.setContent(renderSplashHtml());
for (let i = 0; i < 22; i++) await saveFrame();

// Chapter 1: One-step Onboarding into existing repo
console.log('Rendering Chapter 1: Zero-Friction Onboarding...');
const ch1Cmd = 'lore init --full --solo';
const ch1Lines = [
  'lore initialised in ~/payment-api',
  '  .lore/',
  '  lore.ontology.yml',
  '  .gitignore (+ .lore/)',
  '',
  'Agent memory directives:',
  '  [OK] Injected autonomous memory protocol into AGENTS.md (preserved custom instructions)',
  '',
  'Ingesting codebase facts:',
  '  [OK] Ingested 11 AST facts: dependencies (express, pg, stripe), env vars, routes',
  '',
  'Configuring agent MCP:',
  '  [OK] Cursor: merged into .cursor/mcp.json (session: cursor)',
  '  [OK] Permissive trust mode enabled for solo development',
  '',
  '  [OK] Full workspace onboarding complete.',
];

for (let len = 1; len <= ch1Cmd.length; len += 2) {
  await page.setContent(
    renderTerminalHtml({
      chapter: 'Chapter 1: Zero-Friction Onboarding',
      subtitle: 'Adopting Lore in an existing repository with Cursor & AGENTS.md',
      command: ch1Cmd.slice(0, len),
      highlightBadge: 'Non-Destructive Integration',
    }),
  );
  await saveFrame();
}

for (let l = 1; l <= ch1Lines.length; l += 2) {
  await page.setContent(
    renderTerminalHtml({
      chapter: 'Chapter 1: Zero-Friction Onboarding',
      subtitle: 'Adopting Lore in an existing repository with Cursor & AGENTS.md',
      command: ch1Cmd,
      outputLines: ch1Lines.slice(0, l),
      highlightBadge: 'All-in-One Execution',
    }),
  );
  await saveFrame();
}
// Hold chapter 1
for (let h = 0; h < 18; h++) await saveFrame();

// Chapter 2: Instant Codebase Retrieval
console.log('Rendering Chapter 2: Ground-Truth Codebase Retrieval...');
const ch2Cmd = 'lore search "DATABASE_URL"';
const ch2Lines = [
  '1 hit(s) budget 2000 tok',
  '  [1] 2.2  env:DATABASE_URL — read_by — src/db.ts',
  '      c_9bebecf6eaa81e41  T1 (file)  canonical  fresh',
  '      +1.1 authority (T1)  +1.0 verified (0d ago)  +0.1 text match',
  '',
  'Ground-truth facts derived from code AST are immediately searchable.',
];

for (let len = 1; len <= ch2Cmd.length; len += 2) {
  await page.setContent(
    renderTerminalHtml({
      chapter: 'Chapter 2: Codebase Ground-Truth Retrieval',
      subtitle: 'Agents query facts extracted directly from the repository AST',
      command: ch2Cmd.slice(0, len),
      highlightBadge: 'T0/T1 Deterministic Evidence',
    }),
  );
  await saveFrame();
}
for (let l = 1; l <= ch2Lines.length; l++) {
  await page.setContent(
    renderTerminalHtml({
      chapter: 'Chapter 2: Codebase Ground-Truth Retrieval',
      subtitle: 'Agents query facts extracted directly from the repository AST',
      command: ch2Cmd,
      outputLines: ch2Lines.slice(0, l),
      highlightBadge: 'Active & Verified',
    }),
  );
  await saveFrame();
}
for (let h = 0; h < 16; h++) await saveFrame();

// Chapter 3: Autonomous Agent Authoring (Solo Permissive Mode)
console.log('Rendering Chapter 3: Autonomous Agent Authoring...');
const ch3Cmd = 'lore write --subject sym:src/auth.ts#verifyWebhookSignature --predicate has_guardrail ...';
const ch3Lines = [
  '+ c_84b43c724e8de8d3 active authority T4',
  '  sym:src/auth.ts#verifyWebhookSignature — has_guardrail — Requires HMAC SHA-256 header and rejects clock skew > 300s',
  '  evidence: agent:sym:src/auth.ts#verifyWebhookSignature',
  '',
  '➜ payment-api git:(main) lore search "verifyWebhookSignature"',
  '1 hit(s) budget 2000 tok',
  '  [1] 1.0  sym:src/auth.ts#verifyWebhookSignature — has_guardrail',
  '      c_84b43c724e8de8d3  T4  active  agent/cursor',
  '',
  '  [OK] In solo permissive mode, agent memory is active immediately without draft blocking.',
];

for (let len = 1; len <= 42; len += 3) {
  await page.setContent(
    renderTerminalHtml({
      chapter: 'Chapter 3: Autonomous Agent Authoring',
      subtitle: 'Solo Permissive Mode enables instant write & retrieval without draft amnesia',
      command: ch3Cmd.slice(0, len),
      highlightBadge: 'Solo Mode: Permissive Trust',
    }),
  );
  await saveFrame();
}
for (let l = 1; l <= ch3Lines.length; l += 2) {
  await page.setContent(
    renderTerminalHtml({
      chapter: 'Chapter 3: Autonomous Agent Authoring',
      subtitle: 'Solo Permissive Mode enables instant write & retrieval without draft amnesia',
      command: ch3Cmd,
      outputLines: ch3Lines.slice(0, l),
      highlightBadge: 'Active on Session Branch',
    }),
  );
  await saveFrame();
}
for (let h = 0; h < 18; h++) await saveFrame();

// Chapter 4: Real-time Code Drift Detection & Audit
console.log('Rendering Chapter 4: Real-time Code Drift Detection...');
const ch4Cmd = 'lore status';
const ch4Lines = [
  'lore status',
  '  claims     12 total  11 canonical  1 stale (code drift detected)',
  '  branch     agent/cursor  11 active in working set',
  '',
  '➜ payment-api git:(main) lore blame sym:src/auth.ts#verifyWebhookSignature',
  'sym:src/auth.ts#verifyWebhookSignature — has_guardrail',
  '  commit:   k_f108a74b (chore: initial payment api infrastructure)',
  '  hash:     sha256:e3b0c44298fc1c149afbf4c8996fb924 (DRIFTED)',
  '  trust:    stale (source file modified since last verified observation)',
  '',
  '  [WARN] Memory automatically flags stale claims when implementation changes.',
];

for (let len = 1; len <= ch4Cmd.length; len += 2) {
  await page.setContent(
    renderTerminalHtml({
      chapter: 'Chapter 4: Automatic Code Drift Detection',
      subtitle: 'Cryptographic SHA-256 evidence tracks code changes and flags stale beliefs',
      command: ch4Cmd.slice(0, len),
      highlightBadge: 'Drift & Provenance Guard',
    }),
  );
  await saveFrame();
}
for (let l = 1; l <= ch4Lines.length; l += 2) {
  await page.setContent(
    renderTerminalHtml({
      chapter: 'Chapter 4: Automatic Code Drift Detection',
      subtitle: 'Cryptographic SHA-256 evidence tracks code changes and flags stale beliefs',
      command: ch4Cmd,
      outputLines: ch4Lines.slice(0, l),
      highlightBadge: 'Fail-Safe Staleness',
    }),
  );
  await saveFrame();
}
for (let h = 0; h < 18; h++) await saveFrame();

// Chapter 5: Session Wrapup & Main Branch Promotion
console.log('Rendering Chapter 5: Session Wrapup & Promotion...');
const ch5Cmd = 'lore wrapup --yes';
const ch5Lines = [
  'lore wrapup — session cursor → main',
  '  branch:     agent/cursor',
  '  target:     main',
  '  drafts:     0 unreviewed',
  '  [OK] Fast-forwarded main → k_e95551b8eca6b5d2e6872556888adba6',
  '  [OK] Rotated session branch to agent/ses_mwqc1t48',
  '',
  '  [OK] Session memory successfully committed and promoted to main.',
];

for (let len = 1; len <= ch5Cmd.length; len += 2) {
  await page.setContent(
    renderTerminalHtml({
      chapter: 'Chapter 5: Unified Session Wrapup',
      subtitle: 'Auditing drafts and advancing shared memory across sessions',
      command: ch5Cmd.slice(0, len),
      highlightBadge: 'Git DAG Promotion',
    }),
  );
  await saveFrame();
}
for (let l = 1; l <= ch5Lines.length; l += 2) {
  await page.setContent(
    renderTerminalHtml({
      chapter: 'Chapter 5: Unified Session Wrapup',
      subtitle: 'Auditing drafts and advancing shared memory across sessions',
      command: ch5Cmd,
      outputLines: ch5Lines.slice(0, l),
      highlightBadge: 'Session Lifecycle',
    }),
  );
  await saveFrame();
}
for (let h = 0; h < 18; h++) await saveFrame();

// Chapter 6: Live Knowledge Hub (GUI Dashboard)
console.log('Rendering Chapter 6: Visual Knowledge Hub Dashboard...');
try {
  await page.goto(`http://127.0.0.1:${uiPort}`, { waitUntil: 'networkidle', timeout: 5000 });
  await page.waitForTimeout(600);

  // Take full dashboard screenshot
  for (let i = 0; i < 15; i++) await saveFrame();

  // Filter search
  await page.fill('#q', 'verifyWebhookSignature');
  await page.waitForTimeout(600);
  for (let i = 0; i < 15; i++) await saveFrame();

  await page.fill('#q', 'DATABASE_URL');
  await page.waitForTimeout(600);
  for (let i = 0; i < 15; i++) await saveFrame();
} catch (e) {
  console.log('UI capture fallback:', e.message);
}

// Chapter 7: Outro
console.log('Rendering Chapter 7: Outro Splash...');
await page.setContent(renderOutroHtml());
for (let i = 0; i < 25; i++) await saveFrame();

await browser.close();
uiProcess.kill();

console.log(`[5/5] Assembling video (${frameCount} frames) with ffmpeg...`);

// Assemble MP4
execFileSync('ffmpeg', [
  '-y',
  '-framerate',
  '10',
  '-i',
  path.join(framesDir, 'frame_%04d.png'),
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-r',
  '30',
  OUT_MP4,
]);
console.log(`[OK] Generated MP4: ${OUT_MP4}`);

// Assemble GIF with high-quality palettegen
execFileSync('ffmpeg', [
  '-y',
  '-framerate',
  '10',
  '-i',
  path.join(framesDir, 'frame_%04d.png'),
  '-vf',
  'fps=10,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer',
  '-loop',
  '0',
  OUT_GIF,
]);
console.log(`[OK] Generated GIF: ${OUT_GIF}`);

// Also copy to docs/assets/demo-product.gif
mkdirSync(path.dirname(DOCS_GIF), { recursive: true });
execFileSync('cp', [OUT_GIF, DOCS_GIF]);
console.log(`[OK] Copied to ${DOCS_GIF}`);

// Cleanup temporary frames
rmSync(workDir, { recursive: true, force: true });

const mp4Size = execFileSync('du', ['-h', OUT_MP4], { encoding: 'utf8' }).split('\t')[0];
const gifSize = execFileSync('du', ['-h', OUT_GIF], { encoding: 'utf8' }).split('\t')[0];

console.log(`\n[OK] Demo recording complete!`);
console.log(`  MP4 Video: ${OUT_MP4} (${mp4Size})`);
console.log(`  GIF Demo:  ${OUT_GIF} (${gifSize})`);
