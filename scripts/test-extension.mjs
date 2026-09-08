import { runTests } from '@vscode/test-electron';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const isolated = await mkdtemp(path.join(os.tmpdir(), 'omr-vscode-test-'));
// Electron requires this when executed as root inside the dedicated trusted-test
// container. Never add it on the runner host or for an ordinary local launch.
const isolatedContainer = process.env.CI === 'true' && process.env.OMR_CI_CONTAINER === 'true' && process.platform === 'linux' && process.getuid?.() === 0;
await runTests({
  ...(process.env.OMR_TEST_VSCODE ? { vscodeExecutablePath: process.env.OMR_TEST_VSCODE } : { version: 'stable' }),
  extensionDevelopmentPath: process.cwd(),
  extensionTestsPath: path.resolve('out/test/extension.integration.js'),
  reuseMachineInstall: false,
  launchArgs: ['--user-data-dir', path.join(isolated, 'profile'), '--extensions-dir', path.join(isolated, 'extensions'), '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-gpu', ...(isolatedContainer ? ['--no-sandbox'] : [])],
});
