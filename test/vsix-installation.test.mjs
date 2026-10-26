import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installationCommand, installationSafetyFlags, resolveInstallationCli } from '../scripts/vsix-installation.mjs';

test('VSIX qualification invokes native VS Code CLI without a shell and isolates installation on every platform', () => {
  for (const [platform, executable, isolated, cli] of [
    ['win32', 'C:\\VS Code\\Code.exe', 'C:\\Tests with spaces\\isolated', 'C:\\VS Code\\resources\\app\\out\\cli.js'],
    ['darwin', '/Applications/Visual Studio Code.app/Contents/MacOS/Code', '/tmp/test with spaces', '/Applications/Visual Studio Code.app/Contents/Resources/app/out/cli.js'],
    ['linux', '/opt/VS Code/code', '/tmp/test with spaces', '/opt/VS Code/resources/app/out/cli.js'],
  ]) {
    const args = ['--install-extension', '/trusted/release with spaces.vsix', '--force'];
    const command = installationCommand(executable, isolated, args, platform);
    assert.equal(command.executable, executable); assert.equal(command.args[0], cli);
    assert.deepEqual(command.args.slice(-3), args);
    assert.equal(command.args.filter(value => value === '--user-data-dir').length, 1);
    assert.equal(command.args.filter(value => value === '--extensions-dir').length, 1);
    assert.ok(command.args[2].startsWith(isolated)); assert.ok(command.args[4].startsWith(isolated));
  }
  assert.throws(() => installationCommand('relative-code', '/tmp/private', [], 'linux'));
  assert.deepEqual(installationSafetyFlags({ CI: 'true', OMR_CI_CONTAINER: 'true' }, 'linux', 0), ['--no-sandbox']);
  for (const [environment, platform, uid] of [[{}, 'linux', 0], [{ CI: 'true' }, 'linux', 0], [{ CI: 'true', OMR_CI_CONTAINER: 'true' }, 'linux', 1000], [{ CI: 'true', OMR_CI_CONTAINER: 'true' }, 'win32', 0]]) {
    assert.deepEqual(installationSafetyFlags(environment, platform, uid), [], 'No sandbox exception on ordinary hosts or non-root test processes.');
  }
});

test('CLI lookup handles legacy and commit-versioned Windows archives using their own product metadata', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'omr-cli-layout-'))), commit = '1234567890' + 'a'.repeat(30);
  async function fixture(name, versioned) {
    const directory = path.join(root, name), base = path.join(directory, ...(versioned ? [commit.slice(0, 10)] : []), 'resources/app');
    await mkdir(path.join(base, 'out'), { recursive: true }); await writeFile(path.join(directory, 'Code.exe'), 'inert executable fixture');
    await writeFile(path.join(base, 'out/cli.js'), 'inert CLI fixture'); await writeFile(path.join(base, 'product.json'), JSON.stringify({ commit }));
    return { executable: path.join(directory, 'Code.exe'), cli: path.join(base, 'out/cli.js'), base, directory };
  }
  for (const versioned of [false, true]) {
    const f = await fixture(versioned ? 'Versioned VS Code' : 'Legacy VS Code', versioned);
    assert.equal(await resolveInstallationCli(f.executable, 'win32'), f.cli);
    assert.equal(await readFile(f.cli, 'utf8'), 'inert CLI fixture');
  }
  const bad = await fixture('Mismatched build', true);
  await writeFile(path.join(bad.base, 'product.json'), JSON.stringify({ commit: 'b'.repeat(40) }));
  await assert.rejects(resolveInstallationCli(bad.executable, 'win32'), /metadata/);
  const ambiguous = await fixture('Ambiguous build', true);
  const flat = path.join(ambiguous.directory, 'resources/app/out'); await mkdir(flat, { recursive: true }); await writeFile(path.join(flat, 'cli.js'), 'another CLI');
  await assert.rejects(resolveInstallationCli(ambiguous.executable, 'win32'), /exactly one/);
  const missing = path.join(root, 'Missing build'); await mkdir(missing);
  await assert.rejects(resolveInstallationCli(path.join(missing, 'Code.exe'), 'win32'), /exactly one/);
});
