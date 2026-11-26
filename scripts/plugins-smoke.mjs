#!/usr/bin/env node
// Plugin scopes: personal plugins resolve context and add hosts; repository
// plugins add deterministic extractors; capabilities cannot cross scopes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const work = mkdtempSync(path.join(tmpdir(), 'lore-plugin-smoke-'));
const home = path.join(work, 'home');
const configDir = path.join(home, '.config', 'lore');
const repo = path.join(work, 'repo');
const marker = path.join(work, 'before-session.txt');
const repoId = '1f0c2f7e-4f0a-4a8f-9f0d-2b6f7c9e1a33';

function lore(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), ...env },
  });
}

function ok(args, env = {}) {
  const run = lore(args, env);
  assert.equal(run.status, 0, `lore ${args.join(' ')} failed:\n${run.stdout}\n${run.stderr}`);
  return `${run.stdout}\n${run.stderr}`;
}

function git(args) {
  return spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
}

try {
  mkdirSync(configDir, { recursive: true });
  mkdirSync(repo, { recursive: true });

  // A personal plugin: context override, custom host, hook, and an extractor
  // that the personal scope must reject.
  writeFileSync(
    path.join(configDir, 'personal.mjs'),
    `import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
export default {
  name: 'personal-test',
  resolveContext() { return { session: 'plugin_sess' }; },
  agentHosts: [{
    name: 'myhost',
    displayName: 'My Personal Host',
    defaultSession: 'myhost',
    getConfigFile(root, scope) { return path.join(root, '.myhost', scope === 'global' ? 'global.json' : 'mcp.json'); },
    isInstalled() { return true; },
    applyConfig(file, cmd, session) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ command: cmd.command, args: cmd.args, session }, null, 2));
    },
  }],
  hooks: {
    beforeSession(ctx) { writeFileSync(${JSON.stringify(marker)}, ctx.session); },
  },
  extractors: [{ name: 'personal-extractor', extract() { return [{ subject: 'doc:PERSONAL.md', predicate: 'has_section', object: 'Personal marker', evidenceRef: 'README.md' }]; } }],
};
`,
    'utf8',
  );
  writeFileSync(path.join(configDir, 'config.yml'), 'plugins:\n  - ./personal.mjs\n', 'utf8');

  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'smoke@lore.test']);
  git(['config', 'user.name', 'Lore Smoke']);
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'plugin-smoke' }), 'utf8');
  writeFileSync(path.join(repo, 'README.md'), '# Plugin smoke\n', 'utf8');
  mkdirSync(path.join(repo, 'tools'), { recursive: true });
  writeFileSync(
    path.join(repo, 'tools', 'lore-ext.mjs'),
    `export default {
  name: 'repo-ext',
  agentHosts: [{ name: 'sneaky', displayName: 'Sneaky', defaultSession: 'sneaky',
    getConfigFile() { return ''; }, isInstalled() { return true; }, applyConfig() {} }],
  extractors: [{
    name: 'plugin-marker',
    extract() { return [{ subject: 'doc:PLUGIN.md', predicate: 'has_section', object: 'Plugin marker', evidenceRef: 'README.md' }]; },
  }],
};
`,
    'utf8',
  );
  writeFileSync(
    path.join(repo, '.lore.yml'),
    `repo_id: ${repoId}\nplugins:\n  - tools/lore-ext.mjs\n`,
    'utf8',
  );
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'plugin fixtures']);

  ok(['init']);

  // Personal host: `lore setup myhost` writes the adapter without core edits.
  const setupOut = ok(['setup', 'myhost', '--no-rules']);
  assert.match(setupOut, /My Personal Host/);
  const hostConfig = path.join(repo, '.myhost', 'mcp.json');
  assert.ok(existsSync(hostConfig), 'custom host config must be written');
  assert.match(readFileSync(hostConfig, 'utf8'), /"session": "myhost"/);

  // Context override applies to every command before dispatch.
  assert.match(ok(['session', 'status']), /session: plugin_sess/);
  ok(['write', '--subject', 'rule:plugin-ctx', '--predicate', 'enforces_invariant', '--object', 'docs/x.md', '--kind', 'human', '--ref', 'README.md']);
  assert.equal(readFileSync(marker, 'utf8'), 'plugin_sess', 'beforeSession hook must see the resolved session');

  // Repository extractor runs in ingest; a repo plugin cannot add hosts.
  const dry = ok(['ingest', '--dry-run']);
  assert.match(dry, /doc:PLUGIN\.md \| has_section \| Plugin marker/);
  assert.doesNotMatch(dry, /doc:PERSONAL\.md/, 'personal extractors must never reach ingest');
  const first = ok(['ingest']);
  assert.match(first, /cannot register agentHosts/);
  const diff = ok(['diff', 'main..agent/plugin_sess']);
  assert.match(diff, /doc:PLUGIN\.md/);
  assert.match(ok(['ingest']), /memory already up to date/);

  // Personal extractors are rejected in the scope where ingest reads them.
  const listRun = lore(['plugins', 'list', '--json']);
  assert.equal(listRun.status, 0, `plugins list failed:\n${listRun.stdout}\n${listRun.stderr}`);
  const summary = JSON.parse(listRun.stdout);
  const personal = summary.plugins.find((entry) => entry.name === 'personal-test');
  assert.ok(personal, 'personal plugin must be listed');
  assert.ok(!personal.capabilities.includes('extractors'), 'personal extractor must be dropped');
  assert.ok(personal.warnings.some((warning) => /cannot register extractors/.test(warning)));
  const repoPlugin = summary.plugins.find((entry) => entry.name === 'repo-ext');
  assert.ok(repoPlugin.capabilities.includes('extractors'));
  assert.ok(!repoPlugin.capabilities.includes('agentHosts'));

  console.log('[OK] plugins: personal context/host/hook, repo extractor, strict scope rejection, deterministic ingest');
} finally {
  rmSync(work, { recursive: true, force: true });
}
