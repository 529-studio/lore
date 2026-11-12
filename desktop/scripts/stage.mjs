// Stage the runtime that ships inside the app: the Node binary, the built CLI and
// the native modules it needs. No Node installation is required on the user's Mac.
import { cpSync, mkdirSync, rmSync, copyFileSync, chmodSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(DESKTOP, '..');
const STAGE = path.join(DESKTOP, 'stage');

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(path.join(STAGE, 'app'), { recursive: true });

// CLI + metadata (dist/cli.js reads ../package.json for --version).
cpSync(path.join(ROOT, 'dist'), path.join(STAGE, 'app', 'dist'), { recursive: true });
copyFileSync(path.join(ROOT, 'package.json'), path.join(STAGE, 'app', 'package.json'));

// better-sqlite3 ships prebuilt binaries and has no runtime dependencies.
cpSync(
  path.join(ROOT, 'node_modules', 'better-sqlite3'),
  path.join(STAGE, 'app', 'node_modules', 'better-sqlite3'),
  { recursive: true },
);

// The Node runtime itself.
const node = process.execPath;
copyFileSync(node, path.join(STAGE, 'node'));
chmodSync(path.join(STAGE, 'node'), 0o755);

const mb = (file) => `${(statSync(file).size / 1024 / 1024).toFixed(0)} MB`;
console.log(`staged ${STAGE}`);
console.log(`  node ${mb(path.join(STAGE, 'node'))}`);
