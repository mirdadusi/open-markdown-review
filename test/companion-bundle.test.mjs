import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MAC_QUALIFICATION, stageBundle, verifyBundle, verifyMacQualification } from '../scripts/companion-bundle.mjs';

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omr-bundle-unit-')), source = path.join(temporary, 'source'), output = path.join(temporary, 'dist');
  await mkdir(source); await mkdir(output);
  const catalog = { schemaVersion: 'omr-companion-catalog/2', runtime: 'go', version: '0.6.1', delivery: 'bundled-v1', toolboxDigest: `sha256:${'a'.repeat(64)}`, companionDigest: `sha256:${'b'.repeat(64)}`, targets: [] };
  for (const target of ['win32-x64', 'darwin-arm64', 'linux-x64']) {
    const filename = target === 'win32-x64' ? 'StartReview-windows-x64.exe' : target === 'darwin-arm64' ? 'StartReview-macos-arm64' : 'StartReview-linux-x64';
    const entry = { target, build: { schemaVersion: 'omr-go-build/1', runtime: 'go', version: catalog.version, target, toolchain: 'go1.27.3', testFaults: false } };
    for (const [kind, name] of [['executable', filename], ['notices', `${filename}.NOTICES.txt`]]) {
      const bytes = Buffer.from(`inert test payload ${name}`), digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      entry[kind] = { filename: name, byteLength: bytes.length, digest };
      await writeFile(path.join(source, name), bytes, { mode: 0o600 }); await writeFile(path.join(source, `${name}.sha256`), `${digest.slice(7)}  ${name}\n`);
    }
    await writeFile(path.join(source, `${filename}.build.json`), JSON.stringify(entry.build)); catalog.targets.push(entry);
  }
  const proof = { schemaVersion: 'omr-local-qualification/1', runtime: 'go', version: catalog.version, platform: 'darwin', arch: 'arm64', toolchain: 'go1.27.3', executedAt: '2026-10-18T08:00:00Z',
    executableDigest: catalog.targets[1].executable.digest, toolboxDigest: catalog.toolboxDigest, companionDigest: catalog.companionDigest,
    suites: ['native-browser-and-launcher', 'vscode-native-creation'].map(name => ({ name, exitCode: 0, logDigest: `sha256:${'c'.repeat(64)}` })) };
  await writeFile(path.join(source, MAC_QUALIFICATION), JSON.stringify(proof));
  return { source, output, catalog, proof };
}
test('complete offline bundle includes every platform and locally qualified Mac; restaging is idempotent', async () => {
  const f = await fixture(); await stageBundle(f.source, f.output, f.catalog); await verifyBundle(f.output, f.catalog);
  await stageBundle(f.source, f.output, f.catalog);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.output, 'bundled-companions/darwin-arm64/qualification.json'), 'utf8')), f.proof);
  if (process.platform !== 'win32') for (const target of ['darwin-arm64', 'linux-x64']) assert.equal((await stat(path.join(f.output, 'bundled-companions', target, 'StartReview'))).mode & 0o777, 0o755);
});
test('missing, tampered or substituted Mac qualification cannot authorize a bundle', async () => {
  const f = await fixture();
  for (const change of [{ version: '0.6.0' }, { runtime: 'node-legacy' }, { toolchain: 'go1.26.0' }, { platform: 'linux' }, { arch: 'x64' }, { executableDigest: `sha256:${'0'.repeat(64)}` }, { toolboxDigest: `sha256:${'0'.repeat(64)}` }, { suites: [] }, { suites: [{ ...f.proof.suites[0], exitCode: 1 }, f.proof.suites[1]] }]) {
    assert.throws(() => verifyMacQualification({ ...f.proof, ...change }, f.catalog));
  }
  await writeFile(path.join(f.source, MAC_QUALIFICATION), '{}'); await assert.rejects(stageBundle(f.source, f.output, f.catalog));
});
test('bundle staging refuses changed installed bytes instead of overwriting them', async () => {
  const f = await fixture(); await stageBundle(f.source, f.output, f.catalog);
  const executable = path.join(f.output, 'bundled-companions/win32-x64/StartReview.exe'); await writeFile(executable, 'unexpected user bytes');
  await assert.rejects(stageBundle(f.source, f.output, f.catalog), /overwrite/);
  assert.equal(await readFile(executable, 'utf8'), 'unexpected user bytes');
});
test('partial bundles and unexpected extra payloads fail packaging validation', async () => {
  const f = await fixture(); await assert.rejects(verifyBundle(f.output, f.catalog));
  await stageBundle(f.source, f.output, f.catalog);
  await writeFile(path.join(f.output, 'bundled-companions/linux-x64/ExperimentalGo.exe'), 'not a shipped client');
  await assert.rejects(verifyBundle(f.output, f.catalog), /Unexpected/);
});
test('POSIX verification detects a non-executable installation; trusted restaging restores only its mode', async t => {
  if (process.platform === 'win32') { t.diagnostic('Windows cannot represent POSIX execute bits; actual ZIP mode verification remains mandatory.'); return; }
  const f = await fixture(); await stageBundle(f.source, f.output, f.catalog);
  await chmod(path.join(f.output, 'bundled-companions/linux-x64/StartReview'), 0o600);
  await assert.rejects(verifyBundle(f.output, f.catalog), /not executable/);
  await stageBundle(f.source, f.output, f.catalog); await verifyBundle(f.output, f.catalog);
});
