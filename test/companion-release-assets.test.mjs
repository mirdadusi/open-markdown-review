import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { authoringAssetNames, verifyCompanionAssets, verifyEnterpriseDraft } from '../scripts/verify-companion-assets.mjs';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omr-release-assets-'));
  const catalog = { version: '0.6.0', targets: [] };
  for (const target of ['windows', 'macos', 'linux']) {
    const item = { executable: undefined, notices: undefined, build: { target, version: '0.6.0' } };
    for (const kind of ['executable', 'notices']) {
      const filename = `StartReview-${target}${kind === 'notices' ? '.NOTICES.txt' : ''}`, bytes = Buffer.from(`inert test ${target} ${kind}`);
      const hex = createHash('sha256').update(bytes).digest('hex');
      item[kind] = { filename, digest: `sha256:${hex}`, byteLength: bytes.length };
      await writeFile(path.join(directory, filename), bytes);
      await writeFile(path.join(directory, `${filename}.sha256`), `${hex}  ${filename}\n`);
    }
    await writeFile(path.join(directory, `${item.executable.filename}.build.json`), JSON.stringify(item.build));
    catalog.targets.push(item);
  }
  return { directory, catalog };
}

test('release assets verify exact executables, notices, checksums and build receipts for all platforms', async () => {
  const { directory, catalog } = await fixture();
  await verifyCompanionAssets(directory, catalog);
  const file = path.join(directory, catalog.targets[0].executable.filename);
  await writeFile(file, Buffer.alloc(catalog.targets[0].executable.byteLength));
  await assert.rejects(verifyCompanionAssets(directory, catalog));
});

test('release asset verification refuses extra files, mismatched receipts and checksum labels', async () => {
  for (const kind of ['extra', 'receipt', 'checksum']) {
    const { directory, catalog } = await fixture(), name = catalog.targets[0].executable.filename;
    await writeFile(path.join(directory, kind === 'extra' ? 'unexpected.txt' : name + (kind === 'receipt' ? '.build.json' : '.sha256')), kind === 'receipt' ? '{}' : 'unexpected');
    await assert.rejects(verifyCompanionAssets(directory, catalog));
  }
});

test('publication only completes the matching draft and refuses published or unexpected assets', async () => {
  const { catalog } = await fixture(), commit = 'a'.repeat(40);
  const draft = { isDraft: true, tagName: 'v0.6.0', targetCommitish: commit, assets: authoringAssetNames(catalog,'staged').map(name => ({ name })) };
  verifyEnterpriseDraft(draft, 'v0.6.0', commit, catalog);
  for (const change of [{ isDraft: false }, { tagName: 'v0.5.6' }, { targetCommitish: 'b'.repeat(40) }, { assets: [] }, { assets: [...draft.assets, draft.assets[0]] }]) {
    assert.throws(() => verifyEnterpriseDraft({ ...draft, ...change }, 'v0.6.0', commit, catalog));
  }
  assert.throws(() => verifyEnterpriseDraft(draft, 'v0.6.0', commit, catalog, true));
  draft.assets = [];
  for (const target of ['portable', 'win32-x64']) {
    const name = `open-markdown-review-0.6.0-${target}.vsix`;
    draft.assets.push({ name }, { name: `${name}.sha256` });
  }
  verifyEnterpriseDraft(draft, 'v0.6.0', commit, catalog, true);
});

test('release workflow draft verifier CLI accepts exactly the staged source and rejects published records', async () => {
  const { directory } = await fixture(), catalog = JSON.parse(await readFile('companions/catalog.json', 'utf8'));
  const commit = 'c'.repeat(40), metadata = path.join(directory, 'draft.json');
  const record = { isDraft: true, tagName: `v${catalog.version}`, targetCommitish: commit, assets: authoringAssetNames(catalog,'staged').map(name => ({ name })) };
  await writeFile(metadata, JSON.stringify(record));
  const args = ['scripts/verify-companion-assets.mjs', '--draft', metadata, record.tagName, commit, 'staged'];
  const valid = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Verified pinned companion release artifacts/);
  await writeFile(metadata, JSON.stringify({ ...record, isDraft: false }));
  assert.notEqual(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 0);
});
