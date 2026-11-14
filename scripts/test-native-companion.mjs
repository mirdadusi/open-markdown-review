import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)), target = `${process.platform}-${process.arch}`;
if (!['win32-x64', 'linux-x64', 'darwin-arm64'].includes(target)) throw new Error(`Unsupported native qualification host: ${target}`);
const artifactRoot = process.env.OMR_TEST_CLIENT_ARTIFACT ? path.dirname(process.env.OMR_TEST_CLIENT_ARTIFACT) : path.join(root, 'dist');
const catalog = JSON.parse(await readFile(path.join(artifactRoot, 'companion-catalog.json'), 'utf8'));
const item = catalog.targets.find(item => item.target === target);
if (!item) throw new Error(`Missing ${target} catalog entry.`);
if(catalog.runtime!=='go')throw Error('Default native qualification requires Go; Node is legacy only.');
const executable = process.env.OMR_TEST_COMPANION ?? path.join(root, 'dist/companion-go', target, process.platform === 'win32' ? 'StartReview.exe' : 'StartReview');
const bytes = await readFile(executable);
if (bytes.length !== item.executable.byteLength || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== item.executable.digest) throw new Error('Native executable differs from the release-pinned catalog.');
const extension = process.argv[2] === 'extension';
if (process.argv.length > (extension ? 3 : 2) || process.argv[2] && !extension) throw new Error('Use no argument, or extension.');
const suites = extension ? [['scripts/test-extension.mjs', 'creation'], ['scripts/test-extension.mjs', 'reading'], ['scripts/test-extension.mjs', 'comments-export'], ['scripts/test-extension.mjs', 'finding-workflow']] : [['--test', 'out/test/companion.browser.integration.js', 'out/test/companion.launcher.integration.js', 'out/test/commentEdits.browser.integration.js', 'out/test/exportRevisions.browser.integration.js', 'out/test/documentOrder.browser.integration.js', 'out/test/findingPublicationDialog.browser.integration.js', 'out/test/findingScope.browser.integration.js', 'out/test/publishedFixes.browser.integration.js', 'out/test/findingFilters.browser.integration.js']];
console.log(`Qualifying actual ${target} distribution (${extension ? 'VS Code creation' : 'native browser collaboration, export and launcher'}).`);
for (const args of suites) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', shell: false, env: { ...process.env, OMR_TEST_COMPANION: executable } });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
