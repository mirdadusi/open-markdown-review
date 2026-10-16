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
if (mode === 'generate') {
  const catalog = { schemaVersion: 'omr-companion-catalog/1', version: pkg.version, companionDigest: hash(await readFile(path.join(root, 'dist/companion.js'))), toolboxDigest: hash(await readFile(path.join(root, 'dist/OpenMarkdownReview.html'))), targets: [] };
  await mkdir(path.join(root, 'dist/companion-release'), { recursive: true });
  for (const [target, filename] of targets) {
    const base = path.join(root, 'dist/companion', target), build = JSON.parse(await readFile(path.join(base, 'build.json'), 'utf8'));
    if (build.version !== pkg.version || `sha256:${build.toolboxSha256}` !== catalog.toolboxDigest || `sha256:${build.companionSha256}` !== catalog.companionDigest || build.target !== target) throw new Error(`Rebuild ${target}: its receipt is stale for this client.`);
    const item = { target, build };
    for (const [kind, source, name] of [['executable', target === 'win32-x64' ? 'StartReview.exe' : 'StartReview', filename], ['notices', 'THIRD-PARTY-NOTICES.txt', `${filename}.NOTICES.txt`]]) {
      const from = path.join(base, source), bytes = await readFile(from), digest = hash(bytes);
      if (kind === 'executable' && digest !== `sha256:${build.executableSha256}`) throw new Error(`Invalid executable checksum: ${target}`);
      item[kind] = { filename: name, byteLength: bytes.length, digest, url: `https://github.com/mirdadusi/open-markdown-review/releases/download/v${pkg.version}/${name}` };
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
if (catalog.schemaVersion !== 'omr-companion-catalog/1' || catalog.version !== pkg.version || catalog.targets.length !== targets.length) throw new Error('Prepare a matching three-platform companion catalog.');
if (mode === 'verify' && (hash(await readFile(path.join(root, 'dist/companion.js'))) !== catalog.companionDigest || hash(await readFile(path.join(root, 'dist/OpenMarkdownReview.html'))) !== catalog.toolboxDigest)) throw new Error('Companion catalog does not match the compiled client.');
await mkdir(path.join(root, 'dist'), { recursive: true });
await copyFile(catalogPath, path.join(root, 'dist/companion-catalog.json'));
console.log(`Companion catalog ${mode}: ${catalog.version}, ${catalog.targets.map(t => t.target).join(', ')}`);
