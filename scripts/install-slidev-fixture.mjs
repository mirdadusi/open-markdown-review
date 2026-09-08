import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// An isolated trusted author project, not an application/runtime dependency.
// npm's platform executable is resolved explicitly; shell input is all constant.
const cwd = path.resolve('examples/slidev');
const invoke = args => spawnSync(process.platform === 'win32' ? process.execPath : 'npm', process.platform === 'win32' ? [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args] : args, { cwd, shell: false, encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
const install = invoke(['ci', '--ignore-scripts']);
process.stdout.write(install.stdout ?? ''); process.stderr.write(install.stderr ?? '');
if (install.error || install.status !== 0) throw install.error ?? new Error('Slidev fixture installation failed.');
const audited = invoke(['audit', '--json']);
if (audited.error) throw audited.error;
let audit; try { audit = JSON.parse(audited.stdout); } catch { throw new Error('Slidev fixture dependency audit did not return JSON.'); }
if (audit.error || !audit.vulnerabilities) throw new Error('Slidev fixture audit is unavailable.');
const accepted = JSON.parse(await readFile('examples/slidev/audit-exceptions.json', 'utf8'));
if (new Date().toISOString().slice(0, 10) > accepted.reviewAfter) throw new Error('The isolated author-fixture audit exceptions require review.');
const allowedPackages = new Set(accepted.propagatedPackages), acceptedIds = new Set(accepted.advisories);
for (const [name, entry] of Object.entries(audit.vulnerabilities)) {
  if (!['high', 'critical'].includes(entry.severity)) continue;
  if (entry.severity !== 'high' || !allowedPackages.has(name) || entry.via.some(item => typeof item === 'string' ? !allowedPackages.has(item) : !acceptedIds.has(item.url))) throw new Error(`Unaccepted Slidev author-fixture vulnerability: ${name}`);
}
console.log('Slidev author fixture checked. Known image-size/PPTX-only exceptions are recorded separately; the shipped-client audit has no exception.');
