// Stage the runtime that ships inside the app: the Node binary, the built CLI and
// the native modules it needs. No Node installation is required on the user's Mac.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, copyFileSync, chmodSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// Stage all production dependencies from the root node_modules so that the
// packaged app has everything it needs without relying on external packages.
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const raw = execFileSync(npmCmd, ['list', '--omit=dev', '--parseable', '--all'], {
  cwd: ROOT,
  encoding: 'utf8',
});
const pkgPaths = raw.trim().split(/\r?\n/).slice(1);
const targetModules = path.join(STAGE, 'app', 'node_modules');
mkdirSync(targetModules, { recursive: true });
for (const pkgPath of pkgPaths) {
  if (!pkgPath) continue;
  const rel = path.relative(path.join(ROOT, 'node_modules'), pkgPath);
  cpSync(pkgPath, path.join(targetModules, rel), { recursive: true });
}

// The Node runtime itself. Windows needs the .exe suffix; the Rust shell looks
// for the matching name at runtime.
const runtime = path.join(STAGE, 'runtime');
mkdirSync(runtime, { recursive: true });
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
const nodeTarget = path.join(runtime, nodeName);
copyFileSync(process.execPath, nodeTarget);
if (process.platform !== 'win32') chmodSync(nodeTarget, 0o755);

// Verify that the staged CLI runs cleanly in an isolated directory (outside repo root)
// so missing runtime dependencies are caught at stage time rather than at app launch.
const tmp = mkdtempSync(path.join(tmpdir(), 'lore-stage-check-'));
try {
  cpSync(path.join(STAGE, 'app'), path.join(tmp, 'app'), { recursive: true });
  const checkOut = execFileSync(nodeTarget, [path.join(tmp, 'app', 'dist', 'cli.js'), '--version'], {
    cwd: tmp,
    encoding: 'utf8',
  });
  if (!checkOut.trim()) throw new Error('Staged CLI self-check failed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const mb = (file) => `${(statSync(file).size / 1024 / 1024).toFixed(0)} MB`;
console.log(`staged ${STAGE}`);
console.log(`  ${nodeName} ${mb(nodeTarget)}`);
