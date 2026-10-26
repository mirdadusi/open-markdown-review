import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const target = process.argv[2] ?? 'portable';
assert.ok(['portable', 'win32-x64'].includes(target), 'Use portable or win32-x64.');
for (const args of [['scripts/verify-marketplace.mjs'], ['scripts/package-release.mjs', target, target]]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', shell: false, env: { ...process.env, OMR_RELEASE_CHANNEL: 'standard' } });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Public VSIX packaging failed.');
}
