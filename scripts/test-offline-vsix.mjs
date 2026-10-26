import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractVsix, verifyOfflineVsix } from './vsix-offline.mjs';
import { fileHash } from './companion-bundle.mjs';
import { installVsixForTest } from './vsix-installation.mjs';
import { releaseSourceCommit } from './release-source.mjs';

assert.equal(process.argv.length, 3, 'Provide the freshly packaged VSIX.');
const file = path.resolve(process.argv[2]), catalog = await verifyOfflineVsix(file);
const client = await extractVsix(file), temporary = await mkdtemp(path.join(os.tmpdir(), 'omr-offline-creation-'));
const source = path.join(temporary, 'source'), store = path.join(temporary, 'review'); await mkdir(source);
await writeFile(path.join(source, 'index.md'), '# Offline authoring\n\n| Requirement | State |\n|---|---|\n| All participant platforms | Bundled |\n');
const guard = fileURLToPath(new URL('../test/fixtures/no-network.cjs', import.meta.url));
const args = ['--require', guard, path.join(client, 'dist/cli.js'), 'review', 'create', '--source', source, '--store', store, '--root-document', 'index.md', '--actor-id', 'creator@example.com', '--operation-id', 'offline_package'];
for (const item of catalog.targets) args.push('--companion-target', item.target);
const created = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000, env: { ...process.env, OMR_GITHUB_TOKEN: '', GH_TOKEN: '', GH_ENTERPRISE_TOKEN: '', NODE_PATH: '', NODE_OPTIONS: '' } });
assert.equal(created.status, 0, created.stderr + created.stdout);
const result = JSON.parse(created.stdout); assert.equal(result.outcome, 'completed');
assert.deepEqual((await readdir(store)).filter(name => /(?:\.sha256|\.build\.json|\.NOTICES\.txt)$/.test(name) || ['build.json', 'THIRD-PARTY-NOTICES.txt'].includes(name)), [], 'Actual VSIX creation must not deliver companion sidecars.');
for (const item of catalog.targets) assert.equal(await fileHash(path.join(store, item.executable.filename)), item.executable.digest);
assert.equal((await readdir(path.join(store, 'events'))).length, 1, 'Executable delivery must not duplicate review evidence.');
assert.equal(JSON.parse(await readFile(path.join(store, 'manifest.json'))).protocolVersion, '0.6.0');
console.log('PASS: unpacked authoring VSIX creates all three participant platforms with network and authentication processes disabled.');
const native = catalog.targets.find(item => item.target === `${process.platform}-${process.arch}`);
assert.ok(native, 'Run offline E2E only on a supported native qualification host.');
const executable = path.join(client, 'dist/bundled-companions', native.target, native.target === 'win32-x64' ? 'StartReview.exe' : 'StartReview');
const checked = spawnSync(process.execPath, ['scripts/test-native-companion.mjs'], { stdio: 'inherit', env: { ...process.env, OMR_TEST_CLIENT_ARTIFACT: path.join(client, 'dist/OpenMarkdownReview.html'), OMR_TEST_COMPANION: executable } });
assert.equal(checked.status, 0, 'Actual VSIX-delivered native browser collaboration/PDF/launcher failed.');
const installed = await installVsixForTest(file, catalog);
const installedExecutable = path.join(installed.directory, 'dist/bundled-companions', native.target, native.target === 'win32-x64' ? 'StartReview.exe' : 'StartReview');
const extension = spawnSync(process.execPath, ['scripts/test-native-companion.mjs', 'extension'], { stdio: 'inherit', env: { ...process.env, OMR_TEST_VSCODE: installed.executable, OMR_TEST_EXTENSION_ROOT: installed.directory, OMR_TEST_CLIENT_ARTIFACT: path.join(installed.directory, 'dist/OpenMarkdownReview.html'), OMR_TEST_COMPANION: installedExecutable } });
assert.equal(extension.status, 0, 'Actual VS Code-installed VSIX creation interface/native launch failed.');
const proofDirectory = path.resolve('output/offline-vsix'); await mkdir(proofDirectory, { recursive: true });
await writeFile(path.join(proofDirectory, `${path.basename(file)}.${process.platform}-${process.arch}.json`), JSON.stringify({
  schemaVersion: 'omr-offline-vsix-qualification/1', version: catalog.version, sourceCommit: releaseSourceCommit(), artifact: path.basename(file), artifactDigest: await fileHash(file),
  platform: process.platform, arch: process.arch, installedClient: installed.directory, executedAt: new Date().toISOString(),
  offlineAllPlatformCreation: true, nativeBrowserAndLauncher: true, vscodeCliInstalled: true, installedExtensionCreationAndGoLaunch: true,
  companions: catalog.targets.map(item => ({ target: item.target, digest: item.executable.digest, byteLength: item.executable.byteLength })),
}, null, 2) + '\n');
