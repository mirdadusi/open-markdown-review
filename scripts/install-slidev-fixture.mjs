import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyFixtureAudit } from './fixture-audit-policy.mjs';

// An isolated trusted author project, not an application/runtime dependency.
// npm's platform executable is resolved explicitly; shell input is all constant.
const cwd = path.resolve('examples/slidev');
const invoke = args => spawnSync(process.platform === 'win32' ? process.execPath : 'npm', process.platform === 'win32' ? [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args] : args, { cwd, shell: false, encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
const install = invoke(['ci', '--ignore-scripts']);
process.stdout.write(install.stdout ?? ''); process.stderr.write(install.stderr ?? '');
if (install.error || install.status !== 0) throw install.error ?? new Error('Slidev fixture installation failed.');
const audited = invoke(['audit', '--include=dev', '--json']);
if (audited.error) throw audited.error;
let audit; try { audit = JSON.parse(audited.stdout); } catch { throw new Error('Slidev fixture dependency audit did not return JSON.'); }
const accepted = JSON.parse(await readFile('examples/slidev/audit-exceptions.json', 'utf8'));
const exceptions = verifyFixtureAudit({ audit, policy: accepted, lockBytes: await readFile('examples/slidev/package-lock.json') });
console.log(`Slidev author fixture checked: ${exceptions.length} accepted high/critical package entries. The current public fixture and shipped-client policies permit no advisory exceptions.`);
