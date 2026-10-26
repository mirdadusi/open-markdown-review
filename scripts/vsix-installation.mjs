import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { verifyBundle } from './companion-bundle.mjs';

export function installationSafetyFlags(environment, platform, uid) {
  // Match the existing trusted-test-container exception, never a runner host.
  return environment.CI === 'true' && environment.OMR_CI_CONTAINER === 'true' && platform === 'linux' && uid === 0 ? ['--no-sandbox'] : [];
}

/** Invoke Electron's bundled CLI directly, without cmd.exe or shell quoting. */
export function installationCommand(executable, isolated, parameters, platform = process.platform, resolvedCli) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  assert.ok(paths.isAbsolute(executable) && paths.isAbsolute(isolated));
  const cli = resolvedCli ?? (platform === 'darwin'
    ? paths.resolve(paths.dirname(executable), '../Resources/app/out/cli.js')
    : paths.join(paths.dirname(executable), 'resources/app/out/cli.js'));
  assert.ok(paths.isAbsolute(cli));
  return { executable, args: [cli, '--user-data-dir', paths.join(isolated, 'profile'), '--extensions-dir', paths.join(isolated, 'extensions'), ...parameters] };
}

/** Recent Windows archives keep resources under a ten-character commit folder.
 * Discover only within this trusted SDK installation; never execute a .cmd file
 * or choose a script from PATH, an unrelated checkout or the received review.
 */
export async function resolveInstallationCli(executable, platform = process.platform) {
  assert.ok(path.isAbsolute(executable));
  const root = await realpath(platform === 'darwin' ? path.resolve(path.dirname(executable), '../Resources/app') : path.dirname(executable));
  const relative = platform === 'darwin' ? 'out/cli.js' : 'resources/app/out/cli.js';
  const candidates = [path.join(root, relative)];
  if (platform === 'win32') for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!/^[a-f0-9]{10}$/.test(entry.name)) continue;
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), 'A versioned VS Code directory must be real.');
    const base = path.join(root, entry.name, 'resources/app'), file = path.join(base, 'out/cli.js');
    try { await lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const productPath = path.join(base, 'product.json'), info = await lstat(productPath);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024);
    assert.equal(await realpath(productPath), productPath);
    const product = JSON.parse(await readFile(productPath, 'utf8'));
    assert.ok(typeof product.commit === 'string' && /^[a-f0-9]{40}$/.test(product.commit) && product.commit.startsWith(entry.name), 'Versioned VS Code metadata does not match its commit directory.');
    candidates.push(file);
  }
  const found = [];
  for (const file of candidates) {
    try {
      const info = await lstat(file); assert.ok(info.isFile() && !info.isSymbolicLink());
      assert.equal(await realpath(file), file, 'CLI must stay inside the exact trusted installation, without redirected parents.');
      found.push(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.equal(found.length, 1, 'Expected exactly one verified VS Code CLI in the downloaded installation.');
  return found[0];
}

async function isolatedCli() {
  const isolated = await mkdtemp(path.join(os.tmpdir(), 'omr-vsix-install-'));
  const executable = process.env.OMR_TEST_VSCODE ?? await downloadAndUnzipVSCode({ version: 'stable' });
  const cli = await resolveInstallationCli(executable);
  const run = parameters => {
    const command = installationCommand(executable, isolated, [...installationSafetyFlags(process.env, process.platform, process.getuid?.()), ...parameters], process.platform, cli);
    const result = spawnSync(command.executable, command.args, { shell: false, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    assert.equal(result.error, undefined, 'VS Code CLI did not complete.');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  return { isolated, executable, run };
}

/** Install the actual VSIX in a disposable profile, never the user's main VS Code. */
export async function installVsixForTest(file, catalog) {
  assert.ok(path.isAbsolute(file));
  const { isolated, executable, run } = await isolatedCli();
  run(['--install-extension', file, '--force']);
  const expected = `mirdadusi.open-markdown-review@${catalog.version}`;
  assert.ok(run(['--list-extensions', '--show-versions']).split(/\r?\n/).some(line => line.trim() === expected), 'VS Code did not register the expected extension version.');
  const installed = [];
  for (const entry of await readdir(path.join(isolated, 'extensions'), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(isolated, 'extensions', entry.name);
    const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    if (`${pkg.publisher}.${pkg.name}@${pkg.version}` === expected) installed.push(directory);
  }
  assert.equal(installed.length, 1, 'Expected one registered installation, not an unpacked source substitute.');
  await verifyBundle(path.join(installed[0], 'dist'), catalog);
  console.log(`PASS: VS Code CLI installed ${expected}; all three installed Go companions and Mac qualification verify.`);
  return { directory: installed[0], executable };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3); assert.equal(process.argv[2], 'verify-cli');
  const { run } = await isolatedCli();
  assert.match(run(['--version']), /^\d+\.\d+\.\d+/m, 'The real isolated VS Code CLI must execute successfully.');
  console.log('PASS: native VS Code CLI layout and execution verified without a shell or the main user profile.');
}
