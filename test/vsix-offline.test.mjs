import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sealNativeExecutableModes, verifyOfflineVsix, extractVsix } from '../scripts/vsix-offline.mjs';

import {fixture,archive} from './vsix.fixture.mjs';

test('actual ZIP requires all three pinned binaries, receipts and locally executed Mac qualification', async () => {
  const f = fixture(), file = await archive(f.files); assert.deepEqual(await verifyOfflineVsix(file, f.catalog), f.catalog);
  assert.ok((await extractVsix(file)).endsWith('extension'));
});
test('actual ZIP rejects missing Mac, corrupt executable, unqualified Mac, changed client and experimental payloads', async t => {
  const mutations = {
    'missing Mac': files => files.delete('extension/dist/bundled-companions/darwin-arm64/StartReview'),
    corruption: files => files.set('extension/dist/bundled-companions/linux-x64/StartReview', Buffer.from('altered bytes')),
    'missing qualification': files => files.delete('extension/dist/bundled-companions/darwin-arm64/qualification.json'),
    'failed qualification': files => files.set('extension/dist/bundled-companions/darwin-arm64/qualification.json', Buffer.from('{}')),
    'altered toolbox': files => files.set('extension/dist/OpenMarkdownReview.html', Buffer.from('substituted')),
    'altered protocol core': files => files.set('extension/dist/companion-core.js', Buffer.from('substituted')),
    'legacy Node catalog': files => { const c = JSON.parse(files.get('extension/dist/companion-catalog.json')); c.runtime = 'node-legacy'; files.set('extension/dist/companion-catalog.json', Buffer.from(JSON.stringify(c))); },
    'test-only Go receipt': files => { const c = JSON.parse(files.get('extension/dist/companion-catalog.json')); c.targets[1].build.testFaults = true; files.set('extension/dist/companion-catalog.json', Buffer.from(JSON.stringify(c))); files.set('extension/dist/bundled-companions/linux-x64/build.json', Buffer.from(JSON.stringify(c.targets[1].build))); },
    'extra runtime': files => files.set('extension/dist/bundled-companions/linux-x64/GoReview', Buffer.from('not qualified')),
    experiment: files => files.set('extension/experiments/go/main.go', Buffer.from('not shipped')),
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const f = fixture(); mutate(f.files); await assert.rejects(verifyOfflineVsix(await archive(f.files)));
  });
});
test('actual ZIP rejects duplicate entries and filesystem links before extraction', async () => {
  const f = fixture();
  const duplicate = await archive(f.files, 'extension/package.json');
  await assert.rejects(verifyOfflineVsix(duplicate), /Duplicate/); await assert.rejects(extractVsix(duplicate), /Duplicate/);
  const linked = await archive(f.files, undefined, 'extension/dist/bundled-companions/darwin-arm64/StartReview');
  await assert.rejects(verifyOfflineVsix(linked), /Linked/); await assert.rejects(extractVsix(linked), /Linked/);
});
test('packaging refuses an archive above the bounded native updater budget', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omr-vsix-budget-')), file = path.join(directory, 'oversized.vsix');
  const handle = await open(file, 'wx'); try { await handle.truncate(256 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(verifyOfflineVsix(file), /updater budget/);
});
test('download/Windows executable modes are rejected; build-time sealing changes only bounded ZIP metadata', async () => {
  for (const mode of [0o100600, 0o100644, 0o100666, 0o104755]) {
    const f = fixture(), file = await archive(f.files, undefined, undefined, mode), before = await readFile(file);
    await assert.rejects(verifyOfflineVsix(file), /executable mode/);
    await assert.rejects(extractVsix(file), /must not repair/);
    await sealNativeExecutableModes(file);
    const after = await readFile(file); assert.equal(after.length, before.length);
    assert.ok(after.reduce((count, value, index) => count + Number(value !== before[index]), 0) <= 12, 'Never rewrite or recompress runtime bytes.');
    assert.deepEqual(await verifyOfflineVsix(file, f.catalog), f.catalog);
    await sealNativeExecutableModes(file); assert.deepEqual(await readFile(file), after, 'Mode sealing is idempotent.');
    const client = await extractVsix(file);
    if (process.platform !== 'win32') for (const target of ['linux-x64', 'darwin-arm64']) assert.ok((await stat(path.join(client, 'dist/bundled-companions', target, 'StartReview'))).mode & 0o100);
  }
});
test('build-time mode sealing refuses missing or linked companions without changing the archive', async () => {
  for (const linked of [false, true]) {
    const f = fixture(); if (!linked) f.files.delete('extension/dist/bundled-companions/linux-x64/StartReview');
    const file = await archive(f.files, undefined, linked ? 'extension/dist/bundled-companions/linux-x64/StartReview' : undefined), before = await readFile(file);
    await assert.rejects(sealNativeExecutableModes(file), linked ? /Linked/ : /Both known/);
    assert.deepEqual(await readFile(file), before);
  }
});
