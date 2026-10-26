import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2] ?? 'copy';
const targets = [['win32-x64', 'StartReview-windows-x64.exe'], ['darwin-arm64', 'StartReview-macos-arm64'], ['linux-x64', 'StartReview-linux-x64']];
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const catalogPath = path.join(root, 'companions', 'catalog.json');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const releaseSource = JSON.parse(await readFile(path.join(root, 'release/companion-source.json'), 'utf8'));
if (releaseSource.channel !== 'github-release' || releaseSource.releasesUrl !== `https://${releaseSource.host}/${releaseSource.owner}/${releaseSource.repository}/releases`) throw new Error('Use the trusted companion release provider.');
if (mode === 'generate') {
  const catalog = { schemaVersion: 'omr-companion-catalog/2', runtime:'go', version: pkg.version, delivery: 'bundled-v1', companionDigest: hash(await readFile(path.join(root, 'dist/companion-core.js'))), toolboxDigest: hash(await readFile(path.join(root, 'dist/OpenMarkdownReview.html'))), targets: [] };
  await mkdir(path.join(root, 'dist/companion-release'), { recursive: true });
  for (const [target, filename] of targets) {
    const base = path.join(root, 'dist/companion-go', target), executable=target==='win32-x64'?'StartReview.exe':'StartReview', build = JSON.parse(await readFile(path.join(base, executable+'.build.json'), 'utf8'));
    if (build.runtime!=='go'||build.testFaults!==false||build.toolchain!=='go1.27.3'||build.version !== pkg.version || build.inputs.toolbox !== catalog.toolboxDigest || build.inputs.core !== catalog.companionDigest || build.target !== target) throw new Error(`Rebuild ${target}: its Go production receipt is stale for this client.`);
    const item = { target, build };
    for (const [kind, source, name] of [['executable', path.join(base, executable), filename], ['notices', path.join(root,'clients/companion-go/assets/THIRD-PARTY-NOTICES.txt'), `${filename}.NOTICES.txt`]]) {
      const from = source, bytes = await readFile(from), digest = hash(bytes);
      if (kind === 'executable' && digest !== build.digest || kind==='notices'&&digest!==build.inputs.notices) throw new Error(`Invalid Go artifact checksum: ${target}`);
      item[kind] = { filename: name, byteLength: bytes.length, digest };
      await copyFile(from, path.join(root, 'dist/companion-release', name));
      await writeFile(path.join(root, 'dist/companion-release', `${name}.sha256`), `${digest.slice(7)}  ${name}\n`);
    }
    await writeFile(path.join(root, 'dist/companion-release', `${filename}.build.json`), JSON.stringify(build, null, 2) + '\n');
    catalog.targets.push(item);
  }
  await mkdir(path.dirname(catalogPath), { recursive: true });
  await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
} else if (!['copy', 'verify'].includes(mode)) throw new Error('Use copy, generate or verify.');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
if (catalog.schemaVersion !== 'omr-companion-catalog/2' || catalog.runtime!=='go'||catalog.version !== pkg.version || catalog.targets.length !== targets.length) throw new Error('Prepare a matching three-platform Go companion catalog.');
for (const item of catalog.targets) for (const kind of mode === 'copy' ? [] : ['executable', 'notices']) {
  if (!(catalog.delivery === 'bundled-v1' && item[kind]?.url === undefined) && item[kind]?.url !== `${releaseSource.releasesUrl}/download/v${pkg.version}/${item[kind]?.filename}`) throw new Error('Companion catalog must use the trusted release provider.');
}
if (mode === 'verify') {
  const actual = { companionDigest: hash(await readFile(path.join(root, 'dist/companion-core.js'))), toolboxDigest: hash(await readFile(path.join(root, 'dist/OpenMarkdownReview.html'))) };
  if (actual.companionDigest !== catalog.companionDigest || actual.toolboxDigest !== catalog.toolboxDigest) throw new Error(`Companion catalog does not match the compiled client: ${JSON.stringify({ expected: { companionDigest: catalog.companionDigest, toolboxDigest: catalog.toolboxDigest }, actual })}`);
}
await mkdir(path.join(root, 'dist'), { recursive: true });
await copyFile(catalogPath, path.join(root, 'dist/companion-catalog.json'));
console.log(`Companion catalog ${mode}: ${catalog.version}, ${catalog.targets.map(t => t.target).join(', ')}`);
