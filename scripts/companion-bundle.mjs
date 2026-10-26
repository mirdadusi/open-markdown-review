import assert from 'node:assert/strict';
import { chmod, copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { verifyCompanionAssets, verifyMacQualification } from './verify-companion-assets.mjs';
export { verifyMacQualification } from './verify-companion-assets.mjs';

export const MAC_QUALIFICATION = 'qualification-darwin-arm64.json';
export const bundleName = (target) => target === 'win32-x64' ? 'StartReview.exe' : 'StartReview';
export async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return `sha256:${hash.digest('hex')}`;
}
export async function boundedJson(file, maximum = 65536) {
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= maximum, `Not a bounded regular JSON file: ${file}`);
  return JSON.parse(await readFile(file, 'utf8'));
}
export async function verifyBundle(root, catalog) {
  assert.equal(catalog.schemaVersion, 'omr-companion-catalog/2');
  assert.equal(catalog.runtime, 'go', 'The default authoring bundle requires Go, not a legacy runtime.');
  assert.equal(catalog.delivery, 'bundled-v1', 'Authoring VSIX requires offline companion delivery.');
  assert.deepEqual(catalog.targets.map(item => item.target).sort(), ['darwin-arm64', 'linux-x64', 'win32-x64']);
  const directory = path.join(root, 'bundled-companions');
  const info = await lstat(directory); assert.ok(info.isDirectory() && !info.isSymbolicLink());
  assert.deepEqual((await readdir(directory)).sort(), ['darwin-arm64', 'linux-x64', 'win32-x64']);
  for (const item of catalog.targets) {
    const base = path.join(directory, item.target), info = await lstat(base);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    const executable = bundleName(item.target);
    const names = [executable, 'THIRD-PARTY-NOTICES.txt', 'build.json', ...(item.target === 'darwin-arm64' ? ['qualification.json'] : [])];
    assert.deepEqual((await readdir(base)).sort(), names.sort(), `Unexpected/missing ${item.target} bundled files.`);
    for (const [filename, expected] of [[executable, item.executable], ['THIRD-PARTY-NOTICES.txt', item.notices]]) {
      const file = path.join(base, filename), stat = await lstat(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.size, expected.byteLength);
      assert.equal(await fileHash(file), expected.digest, `Bundled ${item.target}/${filename} checksum mismatch.`);
      if (filename === executable && item.target !== 'win32-x64' && process.platform !== 'win32') {
        assert.ok(stat.mode & 0o100, `Bundled ${item.target} companion is not executable.`);
      }
    }
    assert.deepEqual(await boundedJson(path.join(base, 'build.json')), item.build);
    if (item.target === 'darwin-arm64') verifyMacQualification(await boundedJson(path.join(base, 'qualification.json')), catalog);
  }
}
export async function stageBundle(source, root, catalog) {
  assert.equal(catalog.schemaVersion, 'omr-companion-catalog/2');
  assert.equal(catalog.runtime, 'go', 'The default authoring bundle requires Go, not a legacy runtime.');
  // The input is a trusted build artifact, never a received review package.
  const flat = await readdir(source);
  assert.ok(flat.includes(MAC_QUALIFICATION), 'The locally executed Mac qualification receipt is required.');
  // Verify the existing flat distribution without making a temporary copy of 340 MiB.
  await verifyCompanionAssets(source, catalog, [MAC_QUALIFICATION]);
  verifyMacQualification(await boundedJson(path.join(source, MAC_QUALIFICATION)), catalog);
  for (const directory of [source, root]) {
    const info = await lstat(directory); assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Use real artifact directories.');
  }
  const destination = path.join(root, 'bundled-companions');
  try { const info = await lstat(destination); assert.ok(info.isDirectory() && !info.isSymbolicLink()); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(destination); }
  for (const item of catalog.targets) {
    const base = path.join(destination, item.target);
    try { const info = await lstat(base); assert.ok(info.isDirectory() && !info.isSymbolicLink()); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(base); }
    const copies = [[item.executable.filename, bundleName(item.target)], [item.notices.filename, 'THIRD-PARTY-NOTICES.txt'], [`${item.executable.filename}.build.json`, 'build.json'], ...(item.target === 'darwin-arm64' ? [[MAC_QUALIFICATION, 'qualification.json']] : [])];
    for (const [from, to] of copies) {
      const input = path.join(source, from), output = path.join(base, to);
      try { await copyFile(input, output, constants.COPYFILE_EXCL); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const info = await lstat(output); assert.ok(info.isFile() && !info.isSymbolicLink());
        assert.equal(await fileHash(output), await fileHash(input), 'Refusing to overwrite a different staged companion. Use a new clean build checkout.');
      }
      // Downloaded assets deliberately start private/non-executable. Only the
      // verified, known Go payloads become executable in the authoring bundle.
      if (to === bundleName(item.target) && item.target !== 'win32-x64' && process.platform !== 'win32') await chmod(output, 0o755);
    }
  }
  await verifyBundle(root, catalog);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const catalog = await boundedJson('companions/catalog.json');
  if (process.argv[2] === 'stage' && process.argv.length === 4) { await mkdir('dist', { recursive: true }); await stageBundle(path.resolve(process.argv[3]), path.resolve('dist'), catalog); }
  else if (process.argv[2] === 'verify' && process.argv.length === 3) await verifyBundle(path.resolve('dist'), catalog);
  else throw new Error('Use companion-bundle.mjs stage TRUSTED_ASSET_DIRECTORY or verify.');
  console.log(`Verified offline authoring bundle ${catalog.version}: all three platforms and local Mac qualification.`);
}
