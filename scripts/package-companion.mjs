import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inject } from 'postject';

const repo = fileURLToPath(new URL('../', import.meta.url));
const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
if (process.argv.length > 3 || !/^(?:win32-x64|darwin-arm64|darwin-x64|linux-x64|linux-arm64)$/.test(target)) throw new Error('Choose win32-x64, darwin-arm64, darwin-x64, linux-x64 or linux-arm64.');
const [platform, arch] = target.split('-'), version = process.versions.node;
if (Number(version.split('.')[0]) < 22) throw new Error('Use Node.js 22+ to package the companion.');
const pkg = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
const stage = await mkdtemp(path.join(os.tmpdir(), 'omr-companion-build-'));
const output = path.join(repo, 'dist', 'companion', target); await mkdir(output, { recursive: true });
const sha = data => createHash('sha256').update(data).digest('hex');
async function download(url, maximum = 150 * 1024 * 1024) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Runtime download failed: ${response.status} ${url}`);
  const chunks = []; let length = 0;
  for await (const chunk of response.body) { length += chunk.length; if (length > maximum) throw new Error('Runtime download exceeded its limit.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: stage, stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) throw new Error(`Packaging command failed: ${command} (${result.status})`, { cause: result.error });
}
const base = `https://nodejs.org/dist/v${version}/`;
const artifact = platform === 'win32' ? `win-${arch}/node.exe` : `node-v${version}-${platform}-${arch}.tar.gz`;
const sums = (await download(`${base}SHASUMS256.txt`, 1048576)).toString('utf8');
const expected = sums.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1] === artifact)?.[0];
if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('The exact runtime is absent from the official checksum manifest.');
const runtime = await download(base + artifact);
if (sha(runtime) !== expected) throw new Error('The downloaded Node.js runtime failed checksum verification.');
const executable = path.join(output, platform === 'win32' ? 'StartReview.exe' : 'StartReview');
if (platform === 'win32') {
  const offset = runtime.readUInt32LE(0x3c);
  if (runtime.toString('ascii', 0, 2) !== 'MZ' || runtime.toString('ascii', offset, offset + 4) !== 'PE\0\0' || runtime.readUInt16LE(offset + 4) !== 0x8664 || runtime.readUInt16LE(offset + 24) !== 0x20b) throw new Error('Unexpected Windows x64 executable format.');
  // Injection invalidates the upstream Authenticode signature. Clear its PE
  // directory rather than ship a binary claiming that obsolete signature.
  runtime.fill(0, offset + 24 + 144, offset + 24 + 152);
  await writeFile(executable, runtime);
} else {
  const archive = path.join(stage, 'runtime.tar.gz'); await writeFile(archive, runtime);
  const member = `node-v${version}-${platform}-${arch}/bin/node`;
  run('tar', ['-xzf', archive, '-C', stage, member]);
  const extracted = path.join(stage, member), info = await lstat(extracted);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('The runtime is not a regular executable.');
  await writeFile(executable, await readFile(extracted));
}
await chmod(executable, 0o755);
if (platform === 'darwin') {
  if (process.platform !== 'darwin') throw new Error('macOS companion packaging requires a macOS signing host.');
  run('/usr/bin/codesign', ['--remove-signature', executable]);
}
const nodeLicense = await download(`https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`, 4 * 1024 * 1024);
const notices = Buffer.concat([await readFile(path.join(repo, 'dist/companion-NOTICES.txt')), Buffer.from(`\n\nNode.js ${version} and bundled components\n`), nodeLicense]);
const noticesPath = path.join(output, 'THIRD-PARTY-NOTICES.txt'); await writeFile(noticesPath, notices);
const config = path.join(stage, 'sea.json'), blob = path.join(stage, 'sea.blob');
await writeFile(config, JSON.stringify({ main: path.join(repo, 'dist/companion.js'), output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets: { toolbox: path.join(repo, 'dist/OpenMarkdownReview.html'), licenses: noticesPath } }));
// A cache/snapshot-free preparation blob is portable to the same Node.js
// version on another OS/architecture. Never mix runtime versions.
run(process.execPath, ['--experimental-sea-config', config]);
await inject(executable, 'NODE_SEA_BLOB', await readFile(blob), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', ...(platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}) });
if (platform === 'darwin') run('/usr/bin/codesign', ['--sign', '-', executable]);
const bytes = await readFile(executable);
await writeFile(path.join(output, 'LICENSE'), await readFile(path.join(repo, 'LICENSE')));
await writeFile(`${executable}.sha256`, `${sha(bytes)}  ${path.basename(executable)}\n`);
await writeFile(path.join(output, 'build.json'), JSON.stringify({ schemaVersion: 'omr-companion-build/1', version: pkg.version, target, nodeVersion: version, officialRuntimeSha256: expected, executableSha256: sha(bytes), companionSha256: sha(await readFile(path.join(repo, 'dist/companion.js'))), toolboxSha256: sha(await readFile(path.join(repo, 'dist/OpenMarkdownReview.html'))), codeSigning: platform === 'darwin' ? 'ad-hoc; not notarized' : 'unsigned; production signing is a separate release step', qualification: 'Packaging is not target-platform runtime qualification.' }, null, 2) + '\n');
await writeFile(path.join(output, 'START-HERE.txt'), `Open Markdown Review ${pkg.version} — ${target}\n\nPlace ${path.basename(executable)} next to the review's manifest.json. Run only a trusted, organization-approved executable. On macOS/Linux make it executable if your transport removed that permission.\nDouble-click to open the default browser, or run it with --store ABSOLUTE_REVIEW_FOLDER.\nKeep it running until saves finish. Stop from the browser toolbar or Ctrl+C.\nNo administrator rights, Node.js installation, central server or application registration are required by this software. Organizational application controls still apply.\nThe review folder remains the only source of truth; recovery/preferences are private to this OS user.\nThis build is not production code-signed/notarized. See build.json and verify the checksum.\n`);
console.log(`Packaged ${executable}\nSHA-256 ${sha(bytes)}\nBuild intermediates retained at ${stage}`);
