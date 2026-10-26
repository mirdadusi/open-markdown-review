import { runTests } from '@vscode/test-electron';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:net';

const isolated = await mkdtemp(path.join(os.tmpdir(), 'omr-vscode-test-'));
const workspace = path.join(isolated, 'workspace');
await mkdir(workspace);
await mkdir(path.join(isolated, 'profile', 'User'), { recursive: true });
await writeFile(path.join(isolated, 'profile', 'User', 'settings.json'), JSON.stringify({
  'workbench.colorTheme': 'Default Light Modern', 'workbench.startupEditor': 'none',
  'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
}));
const suite = process.argv[2] ?? 'full';
if (!['full', 'creation', 'interoperability'].includes(suite) || process.argv.length > 3) throw new Error('Use full, creation or interoperability.');
let debugPort;
if (suite === 'interoperability') {
  const server=createServer(); await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  debugPort=server.address().port; await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
const interoperabilityOutput=path.resolve('output/interoperability',`${process.platform}-${process.arch}`);
// Electron requires this when executed as root inside the dedicated trusted-test
// container. Never add it on the runner host or for an ordinary local launch.
const isolatedContainer = process.env.CI === 'true' && process.env.OMR_CI_CONTAINER === 'true' && process.platform === 'linux' && process.getuid?.() === 0;
await runTests({
  ...(process.env.OMR_TEST_VSCODE ? { vscodeExecutablePath: process.env.OMR_TEST_VSCODE } : { version: suite==='interoperability'?'1.142.0':'stable' }),
  extensionDevelopmentPath: process.env.OMR_TEST_EXTENSION_ROOT ?? process.cwd(),
  extensionTestsPath: path.resolve(suite === 'creation' ? 'out/test/creation.host.integration.js' : suite === 'interoperability' ? 'out/test/interoperability.extension.integration.js' : 'out/test/extension.integration.js'),
  extensionTestsEnv: { ...process.env, OMR_TEST_NODE:process.execPath, ...(debugPort?{ OMR_TEST_CDP_PORT:String(debugPort), OMR_INTEROP_OUTPUT:interoperabilityOutput, OMR_NODE_COMPANION:process.env.OMR_NODE_COMPANION??path.resolve('dist/legacy-node',`${process.platform}-${process.arch}`,process.platform==='win32'?'StartReview.exe':'StartReview') }:{}) },
  reuseMachineInstall: false,
  launchArgs: ['--user-data-dir', path.join(isolated, 'profile'), '--extensions-dir', path.join(isolated, 'extensions'), '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-gpu', ...(debugPort?[`--remote-debugging-port=${debugPort}`,'--remote-debugging-address=127.0.0.1']:[]), ...(isolatedContainer ? ['--no-sandbox','--enable-logging=stderr','--vmodule=*service_worker*=2,*quota*=2,*leveldb*=2'] : []), workspace],
});
if(suite==='interoperability') {
  const { verifyInteropExport }=await import('./verify-interop-export.mjs');
  await verifyInteropExport(interoperabilityOutput);
}
