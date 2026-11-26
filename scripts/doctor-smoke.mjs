// Scenario smoke for `lore doctor`: healthy repo, malformed TOML, branch parity.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');

const work = mkdtempSync(path.join(tmpdir(), 'lore-doctor-smoke-'));
const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };

function lore(args, cwd) {
  return spawnSync('node', [cli, ...args], { cwd, env, encoding: 'utf8' });
}

function fail(message, result) {
  const detail = result ? `\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}` : '';
  throw new Error(`${message}${detail}`);
}

function expectOk(label, result) {
  if (result.status !== 0) fail(`${label}: expected exit 0, got ${result.status}`, result);
  return result;
}

function parseJson(label, result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return fail(`${label}: stdout is not JSON`, result);
  }
}

function prepareRepo(name, session) {
  const repo = path.join(work, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ name, dependencies: { zod: '^4.0.0' }, scripts: { test: 'node test.js' } }),
    'utf8',
  );
  expectOk(`${name}: init`, lore(['init', '--root', repo], work));
  expectOk(`${name}: ingest`, lore(['ingest', '--session', session], repo));
  return repo;
}

function checkById(result, id) {
  return result.checks.find((item) => item.id === id);
}

try {
  const requiredIds = [
    'store.path',
    'store.wal',
    'store.integrity',
    'store.schema',
    'parity',
    'mcp:claude',
    'mcp:agy',
    'mcp:codex',
    'mcp:cursor',
    'mcp:gemini',
    'mcp:opencode',
    'mcp.binary',
    'ontology',
    'health.stale',
    'health.conflicts',
  ];

  // 1. Healthy repo: ingest promoted into main, so parity is clean and exit 0.
  const healthy = prepareRepo('doctor-healthy', 'ses_healthy');
  expectOk('healthy: promote', lore(['promote', '--session', 'ses_healthy'], healthy));
  const healthyRun = expectOk('healthy: doctor --json', lore(['doctor', '--json'], healthy));
  const healthyJson = parseJson('healthy: doctor --json', healthyRun);
  if (healthyJson.ok !== true) fail('healthy: expected ok true', healthyRun);
  for (const id of requiredIds) {
    const item = checkById(healthyJson, id);
    if (!item) fail(`healthy: missing check ${id}`, healthyRun);
    if (!['ok', 'warn', 'err'].includes(item.status)) fail(`healthy: invalid status for ${id}`, healthyRun);
    if (typeof item.message !== 'string' || !item.message) fail(`healthy: empty message for ${id}`, healthyRun);
  }
  if (checkById(healthyJson, 'parity').status !== 'ok') fail('healthy: parity is not ok', healthyRun);
  if (checkById(healthyJson, 'store.schema').status !== 'ok') fail('healthy: schema is not ok', healthyRun);
  const healthyText = expectOk('healthy: doctor text', lore(['doctor'], healthy));
  if (!healthyText.stdout.includes('[OK]')) fail('healthy: text output has no [OK]', healthyText);

  // 2. Malformed TOML must be [ERR] and non-zero, never a throw.
  const brokenToml = path.join(work, 'doctor-toml');
  mkdirSync(brokenToml, { recursive: true });
  writeFileSync(path.join(brokenToml, 'package.json'), '{"name":"doctor-toml"}', 'utf8');
  expectOk('toml: init', lore(['init', '--root', brokenToml], work));
  mkdirSync(path.join(brokenToml, '.codex'), { recursive: true });
  writeFileSync(
    path.join(brokenToml, '.codex', 'config.toml'),
    '[mcp_servers.lore\ncommand = "lore"\nargs = ["mcp"]\n',
    'utf8',
  );
  const brokenRun = lore(['doctor', '--json'], brokenToml);
  if (brokenRun.status === 0) fail('toml: expected non-zero exit for malformed .codex/config.toml', brokenRun);
  const brokenJson = parseJson('toml: doctor --json', brokenRun);
  if (brokenJson.ok !== false) fail('toml: expected ok false', brokenRun);
  const codexCheck = checkById(brokenJson, 'mcp:codex');
  if (!codexCheck || codexCheck.status !== 'err') fail('toml: mcp:codex is not err', brokenRun);
  if (!codexCheck.message.includes('not valid TOML')) fail('toml: mcp:codex message lacks TOML detail', brokenRun);
  const brokenText = lore(['doctor'], brokenToml);
  if (brokenText.status === 0) fail('toml: text run exited 0', brokenText);
  if (!brokenText.stdout.includes('[ERR]')) fail('toml: text output has no [ERR]', brokenText);

  // A valid TOML file with lore sections must be accepted by the narrow parser.
  writeFileSync(
    path.join(brokenToml, '.codex', 'config.toml'),
    [
      '# existing config',
      '[mcp_servers.github]',
      'command = "npx"',
      'args = ["-y", "server-github"]',
      '',
      '[mcp_servers.lore]',
      'command = "lore"',
      'args = ["mcp"]',
      '',
      '[mcp_servers.lore.env]',
      'LORE_SESSION = "codex"',
      '',
      '[projects."/tmp/example"]',
      'trust_level = "trusted"',
      '',
      '[[custom_entries]]',
      'name = "keep-me"',
      '',
    ].join('\n'),
    'utf8',
  );
  const validRun = lore(['doctor', '--json'], brokenToml);
  const validJson = parseJson('toml valid: doctor --json', validRun);
  if (checkById(validJson, 'mcp:codex').status !== 'ok') fail('toml valid: mcp:codex is not ok', validRun);

  // Duplicate table headers are invalid TOML and must not be reported as valid.
  writeFileSync(
    path.join(brokenToml, '.codex', 'config.toml'),
    '[mcp_servers.lore]\ncommand = "lore"\n\n[mcp_servers.lore]\ncommand = "other"\n',
    'utf8',
  );
  const duplicateRun = lore(['doctor', '--json'], brokenToml);
  if (duplicateRun.status === 0) fail('toml duplicate: expected non-zero exit', duplicateRun);
  const duplicateCheck = checkById(parseJson('toml duplicate: doctor --json', duplicateRun), 'mcp:codex');
  if (duplicateCheck.status !== 'err' || !duplicateCheck.message.includes('duplicate table')) {
    fail('toml duplicate: mcp:codex did not report the duplicate table', duplicateRun);
  }

  // OpenCode accepts JSONC: comments and trailing commas must not be [ERR].
  writeFileSync(
    path.join(brokenToml, 'opencode.json'),
    [
      '{',
      '  // local config',
      '  "mcp": {',
      '    "servers": {',
      '      "lore": { "type": "local", "command": ["lore", "mcp"], },',
      '    },',
      '  },',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  const jsoncRun = lore(['doctor', '--json'], brokenToml);
  const jsoncCheck = checkById(parseJson('jsonc: doctor --json', jsoncRun), 'mcp:opencode');
  if (jsoncCheck.status !== 'ok') fail('jsonc: opencode JSONC was not accepted', jsoncRun);

  // 3. Empty main with an ingested agent/* baseline: WARN, then --fix promotes it.
  const skew = prepareRepo('doctor-skew', 'ses_baseline');
  const skewRun = expectOk('skew: doctor --json', lore(['doctor', '--json'], skew));
  const skewJson = parseJson('skew: doctor --json', skewRun);
  const skewParity = checkById(skewJson, 'parity');
  if (skewParity.status !== 'warn') fail('skew: parity is not warn', skewRun);
  if (!skewParity.message.includes('main has 0 claims')) fail('skew: parity message lacks the empty-main detail', skewRun);
  if (!skewParity.message.includes('agent/ses_baseline')) fail('skew: parity message misses the baseline branch', skewRun);
  if (!skewParity.remediation || !skewParity.remediation.includes('lore promote')) {
    fail('skew: parity has no lore promote remediation', skewRun);
  }
  const skewText = expectOk('skew: doctor text', lore(['doctor'], skew));
  if (!skewText.stdout.includes('[WARN]') || !skewText.stdout.includes('parity')) {
    fail('skew: text output does not show the parity warning', skewText);
  }

  const fixRun = expectOk('skew: doctor --fix --json', lore(['doctor', '--fix', '--json'], skew));
  const fixJson = parseJson('skew: doctor --fix --json', fixRun);
  const fixedParity = checkById(fixJson, 'parity');
  if (fixedParity.status !== 'ok') fail('skew: --fix did not clear the parity warning', fixRun);
  if (!fixedParity.message.includes('promoted agent/ses_baseline')) fail('skew: --fix message lacks the promotion', fixRun);
  if (!/\d+ claims/.test(fixedParity.message)) fail('skew: --fix message lacks the claim count', fixRun);

  const afterFix = parseJson('skew: doctor after fix', expectOk('skew: doctor after fix', lore(['doctor', '--json'], skew)));
  if (checkById(afterFix, 'parity').status !== 'ok') fail('skew: parity regressed after fix');

  // --fix must not hide a malformed MCP config: restore the broken file, then repair nothing.
  writeFileSync(
    path.join(brokenToml, '.codex', 'config.toml'),
    '[mcp_servers.lore\ncommand = "lore"\nargs = ["mcp"]\n',
    'utf8',
  );
  const fixedThenBroken = lore(['doctor', '--fix', '--json'], brokenToml);
  if (fixedThenBroken.status === 0) fail('fix: --fix hid the malformed TOML ERR', fixedThenBroken);

  console.log('[OK] doctor-smoke: healthy exit 0, malformed TOML [ERR] non-zero, parity WARN fixed by --fix, JSON shape stable');
} finally {
  rmSync(work, { recursive: true, force: true });
}
