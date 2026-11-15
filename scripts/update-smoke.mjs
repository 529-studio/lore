import assert from 'node:assert/strict';
import { isNewerVersion, checkNpmUpdate } from '../dist/update.js';

// 1. Semver comparison logic
assert.equal(isNewerVersion('0.4.0', '0.5.0'), true, '0.5.0 should be newer than 0.4.0');
assert.equal(isNewerVersion('0.5.0', '0.5.0'), false, 'same version should not be newer');
assert.equal(isNewerVersion('0.5.0', '0.4.9'), false, 'older version should not be newer');
assert.equal(isNewerVersion('0.5.0-beta.1', '0.5.0'), true, 'release should be newer than prerelease');
assert.equal(isNewerVersion('0.5.0', '1.0.0'), true, 'major bump should be newer');
assert.equal(isNewerVersion('0.5.0', '0.5.1'), true, 'patch bump should be newer');
assert.equal(isNewerVersion('1.2.3', '1.2.3-alpha.1'), false, 'prerelease should not be newer than release');

// 2. Timeout and error safety
const deadResult = await checkNpmUpdate('@529studio/non-existent-pkg-test-xyz', '0.1.0', { timeoutMs: 1000 });
assert.equal(deadResult.updateAvailable, false, 'failed/non-existent check must return updateAvailable: false');

console.log('[OK] update-smoke tests passed');
