import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function companionAssetNames(catalog) {
  return catalog.targets.flatMap(item => [item.executable.filename, `${item.executable.filename}.sha256`,
    `${item.executable.filename}.build.json`, item.notices.filename, `${item.notices.filename}.sha256`]).sort();
}

/** A staged draft holds a Mac-qualified authoring VSIX; a finished release has two variants. */
export function authoringAssetNames(catalog,phase='complete') {
  assert.ok(['staged','assembled','complete'].includes(phase));
  return [...(phase==='complete'?[]:['authoring-seed']),...(phase==='staged'?[]:['portable','win32-x64'])].flatMap(target=>{
    const name=`open-markdown-review-${catalog.version}-${target}.vsix`;
    return [name,`${name}.sha256`];
  }).sort();
}

export function verifyMacQualification(proof, catalog) {
  const mac = catalog.targets.find(item => item.target === 'darwin-arm64');
  assert.equal(proof.schemaVersion, 'omr-local-qualification/1');
  assert.equal(proof.version, catalog.version);
  assert.equal(proof.platform, 'darwin'); assert.equal(proof.arch, 'arm64');
  assert.equal(proof.executableDigest, mac.executable.digest);
  assert.equal(proof.toolboxDigest, catalog.toolboxDigest);
  assert.equal(proof.companionDigest, catalog.companionDigest);
  if(catalog.runtime==='go'){
    assert.equal(proof.runtime,'go');assert.equal(proof.toolchain,mac.build.toolchain);
    assert.equal(mac.build.runtime,'go');assert.equal(mac.build.testFaults,false);
  }else assert.equal(proof.nodeVersion, mac.build.nodeVersion);
  assert.ok(Number.isFinite(Date.parse(proof.executedAt)));
  assert.deepEqual(proof.suites.map(item => item.name).sort(), ['native-browser-and-launcher', 'vscode-native-creation']);
  for (const suite of proof.suites) {
    assert.equal(suite.exitCode, 0, 'A Mac qualification suite did not pass.');
    assert.match(suite.logDigest, /^sha256:[a-f0-9]{64}$/);
  }
}

export async function verifyCompanionAssets(directory, catalog, additionalNames = catalog.delivery === 'bundled-v1' ? ['qualification-darwin-arm64.json'] : []) {
  const names = companionAssetNames(catalog);
  assert.equal(names.length, 15, 'A release requires all three platform distributions.');
  assert.deepEqual((await readdir(directory)).sort(), [...names, ...additionalNames].sort(), 'Unexpected or missing companion release files.');
  for (const item of catalog.targets) {
    for (const artifact of [item.executable, item.notices]) {
      const file = path.join(directory, artifact.filename), info = await lstat(file);
      assert.ok(info.isFile() && !info.isSymbolicLink(), 'Release assets must be regular files.');
      assert.equal(info.size, artifact.byteLength, artifact.filename);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      assert.equal(`sha256:${hash.digest('hex')}`, artifact.digest, artifact.filename);
      const checksum = path.join(directory, `${artifact.filename}.sha256`), checksumInfo = await lstat(checksum);
      assert.ok(checksumInfo.isFile() && !checksumInfo.isSymbolicLink() && checksumInfo.size < 1024);
      assert.equal(await readFile(checksum, 'utf8'), `${artifact.digest.slice(7)}  ${artifact.filename}\n`);
    }
    const receipt = path.join(directory, `${item.executable.filename}.build.json`), info = await lstat(receipt);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size < 16384);
    assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), item.build, 'Build receipt differs from the pinned distribution.');
  }
  if (additionalNames.includes('qualification-darwin-arm64.json')) {
    const file = path.join(directory, 'qualification-darwin-arm64.json'), info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 65536);
    verifyMacQualification(JSON.parse(await readFile(file, 'utf8')), catalog);
  }
}

export function verifyEnterpriseDraft(record, tag, commit, catalog, phase = 'staged') {
  assert.equal(tag, `v${catalog.version}`);
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(record.isDraft, true, 'Refusing to modify an already published release.');
  assert.equal(record.tagName, tag);
  assert.equal(record.targetCommitish, commit, 'Draft release belongs to a different source commit.');
  const mode=phase===true?'complete':phase===false?'staged':phase;
  const names=record.assets.map(item=>item.name).sort();
  assert.equal(new Set(names).size,names.length,'Duplicate release asset.');
  if(mode==='staged') {
    const seed=authoringAssetNames(catalog,'staged'),final=authoringAssetNames(catalog,'complete'),allowed=new Set([...seed,...final]);
    assert.ok(names.every(name=>allowed.has(name))&&(seed.every(name=>names.includes(name))||final.every(name=>names.includes(name))),'Draft release has unexpected or missing assets.');
  } else assert.deepEqual(names,authoringAssetNames(catalog,mode),'Draft release has unexpected or missing assets.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const catalog = JSON.parse(await readFile('companions/catalog.json', 'utf8'));
  if (process.argv[2] === '--draft') {
    const [,, , metadata, tag, commit, phase] = process.argv;
    if (!['staged', 'assembled', 'complete'].includes(phase) || process.argv.length !== 7) throw new Error('Use --draft METADATA TAG COMMIT staged|assembled|complete.');
    verifyEnterpriseDraft(JSON.parse(await readFile(metadata, 'utf8')), tag, commit, catalog, phase);
  } else {
    if (process.argv.length !== 3) throw new Error('Provide the exact companion asset directory.');
    await verifyCompanionAssets(process.argv[2], catalog);
  }
  console.log('Verified pinned companion release artifacts.');
}
