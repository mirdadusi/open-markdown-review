import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { releaseSourceCommit } from '../scripts/release-source.mjs';

test('container-owned checkout commit lookup is command-scoped and never changes global trust', async () => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'omr-release-owner-'))), root = path.join(temporary, 'checkout with spaces');
  const global = path.join(temporary, 'isolated.gitconfig'); await mkdir(root); await writeFile(global, '# isolated test configuration\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '', GIT_TEST_ASSUME_DIFFERENT_OWNER: '0', LANG: 'C', LC_ALL: 'C' };
  const command = args => spawnSync('git', args, { encoding: 'utf8', env });
  assert.equal(command(['init', '--object-format=sha1', root]).status, 0);
  const commit = command(['-C', root, '-c', 'user.name=Release Fixture', '-c', 'user.email=release@example.com', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(temporary, 'no-hooks')}`, 'commit', '--allow-empty', '-m', 'fixture']);
  assert.equal(commit.status, 0, commit.stderr);
  const expected = releaseSourceCommit(root, env), assumedForeign = { ...env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };
  const refused = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { env: assumedForeign, encoding: 'utf8' });
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /dubious ownership/);
  assert.equal(releaseSourceCommit(root, assumedForeign), expected);
  assert.equal(await readFile(global, 'utf8'), '# isolated test configuration\n');
  assert.notEqual(spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { env: assumedForeign }).status, 0, 'Trust must not leak to later commands.');
});
