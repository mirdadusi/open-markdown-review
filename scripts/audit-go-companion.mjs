// Source and actual-binary gates. Plain output preserves nonzero vulnerability exits.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = `${process.platform}-${process.arch}`;
assert.ok(['darwin-arm64', 'linux-x64', 'win32-x64'].includes(target));
const go = process.env.OMR_GO ?? 'go';
const directory = path.join(root, 'clients/companion-go');
const env = { ...process.env, CGO_ENABLED: '0', GOTOOLCHAIN: 'local' };
const location = spawnSync(go, ['env', 'GOROOT'], { cwd: directory, env, encoding: 'utf8' });
assert.equal(location.status, 0, location.stderr);
const executable = path.join(location.stdout.trim(), 'bin', process.platform === 'win32' ? 'go.exe' : 'go');
assert.ok(path.isAbsolute(executable));
env.PATH = path.dirname(executable) + path.delimiter + (env.PATH ?? '');
env.GOOS = process.platform === 'win32' ? 'windows' : process.platform;
env.GOARCH = process.arch === 'x64' ? 'amd64' : process.arch;
const version = spawnSync(executable, ['version'], { cwd: directory, env, encoding: 'utf8' });
assert.equal(version.status, 0, version.stderr);
assert.ok(version.stdout.startsWith('go version go1.27.3 '), 'Use the exact production Go toolchain.');

const binary = path.join(root, 'dist/companion-go', target, process.platform === 'win32' ? 'StartReview.exe' : 'StartReview');
const receipt = JSON.parse(await readFile(binary + '.build.json', 'utf8'));
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
assert.equal(receipt.testFaults, false, 'Audit the distribution build.');
assert.equal(sha(await readFile(binary)), receipt.digest);
const output = path.join(root, 'output/companion-comparison', target);
await mkdir(output, { recursive: true });
const tool = 'golang.org/x/vuln/cmd/govulncheck@v1.9.0';
const results = [];
for (const [name, args] of [['source', ['./...']], ['binary', ['-mode=binary', binary]]]) {
  const result = spawnSync(executable, ['run', tool, ...args], {
    cwd: directory, env, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024,
  });
  const log = (result.stdout ?? '') + (result.stderr ?? '') + (result.error?.message ?? '');
  await writeFile(path.join(output, `go-audit-${name}.log`), log);
  results.push({ name, exitCode: result.status, signal: result.signal, logDigest: sha(log) });
  console.log(log);
}
await writeFile(path.join(output, 'go-audit.json'), JSON.stringify({
  schemaVersion: 'omr-go-audit/1', scannedAt: new Date().toISOString(), tool,
  toolchain: version.stdout.trim(), target, cgoEnabled: false, executableDigest: receipt.digest, results,
  passed: results.every(result => result.exitCode === 0),
  limitation: 'Known-vulnerability source and linked-symbol checks are not proof of absence of defects. Reflection limits source reachability; the binary gate checks the shipped build too.',
}, null, 2) + '\n');
assert.ok(results.every(result => result.exitCode === 0), 'Go source/binary vulnerability gate failed.');
