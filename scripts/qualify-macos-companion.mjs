import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileHash, verifyMacQualification } from './companion-bundle.mjs';

assert.equal(process.platform, 'darwin', 'Mac qualification must execute locally on macOS.');
assert.equal(process.arch, 'arm64', 'Mac qualification requires an Apple Silicon host.');
const catalog = JSON.parse(await readFile('companions/catalog.json', 'utf8'));
const mac = catalog.targets.find(item => item.target === 'darwin-arm64');
assert.equal(catalog.runtime, 'go');
assert.equal(mac.build.toolchain, 'go1.27.3');
assert.equal(mac.build.testFaults, false);
assert.equal(await fileHash('dist/companion-go/darwin-arm64/StartReview'), mac.executable.digest);
const logs = path.resolve('output/macos-qualification', catalog.version); await mkdir(logs, { recursive: true });
const suites = [];
for (const [name, args] of [['native-browser-and-launcher', ['scripts/test-native-companion.mjs']], ['vscode-native-creation', ['scripts/test-native-companion.mjs', 'extension']]]) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300000 });
  const log = path.join(logs, `${name}.log`); await writeFile(log, (result.stdout ?? '') + (result.stderr ?? ''));
  assert.equal(result.status, 0, `Mac suite ${name} failed. Inspect ${log}; no qualification was issued.`);
  suites.push({ name, exitCode: result.status, logDigest: await fileHash(log) });
  console.log(`PASS local macOS arm64: ${name}`);
}
const proof = { schemaVersion: 'omr-local-qualification/1', version: catalog.version, platform: process.platform, arch: process.arch,
  runtime: 'go', toolchain: mac.build.toolchain, nodeVersion: process.versions.node, executedAt: new Date().toISOString(), executableDigest: mac.executable.digest,
  companionDigest: catalog.companionDigest, toolboxDigest: catalog.toolboxDigest, suites,
  limitation: 'Publisher-recorded local execution, not independent certification, production signing or notarization.' };
verifyMacQualification(proof, catalog);
await writeFile('dist/companion-release/qualification-darwin-arm64.json', JSON.stringify(proof, null, 2) + '\n');
console.log('Issued local Mac qualification bound to the exact distributed executable and shared client digests.');
