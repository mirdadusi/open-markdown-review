import assert from 'node:assert/strict';
import { realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Trusted build checkout only; no persistent or wildcard safe.directory entry. */
export function releaseSourceCommit(root = process.cwd(), env = process.env) {
  const directory = realpathSync(root);
  assert.notEqual(directory, path.parse(directory).root);
  const git = lstatSync(path.join(directory, '.git'));
  assert.ok(git.isFile() || git.isDirectory(), 'Use an actual build checkout.');
  const safe = process.platform === 'win32' ? directory.replaceAll('\\', '/') : directory;
  const result = spawnSync('git', ['-c', `safe.directory=${safe}`, '-C', directory, 'rev-parse', '--verify', 'HEAD'], { env, encoding: 'utf8', timeout: 10000, maxBuffer: 4096, shell: false });
  assert.equal(result.status, 0, `Cannot read build source commit: ${result.stderr}`);
  const commit = result.stdout.trim(); assert.match(commit, /^[a-f0-9]{40}$/); return commit;
}
