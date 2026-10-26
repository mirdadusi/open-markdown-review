import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createVSIX } from '@vscode/vsce';
import { sealNativeExecutableModes, verifyOfflineVsix } from './vsix-offline.mjs';

const options = { rewriteRelativeLinks: true }, seen = new Set();
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  assert.ok(!seen.has(flag), `Duplicate packaging argument: ${flag}`); seen.add(flag);
  if (flag === '--pre-release') options.preRelease = true;
  else {
    assert.ok(['--target', '--out'].includes(flag), `Unsupported packaging argument: ${flag}`);
    const value = process.argv[++index]; assert.ok(value && !value.startsWith('--'));
    if (flag === '--target') { assert.equal(value, 'win32-x64'); options.target = value; }
    else options.packagePath = path.resolve(value);
  }
}
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
options.githubBranch = `v${pkg.version}`;
options.packagePath ??= path.resolve(`${pkg.name}-${options.target ? options.target + '-' : ''}${pkg.version}.vsix`);
assert.equal(path.extname(options.packagePath), '.vsix');
await createVSIX(options);
await sealNativeExecutableModes(options.packagePath);
await verifyOfflineVsix(options.packagePath, JSON.parse(await readFile('companions/catalog.json', 'utf8')));
console.log('Verified VSIX payloads and host-independent POSIX companion executable permissions.');
