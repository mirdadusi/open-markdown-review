// Build-time acquisition only. The shipped extension never calls this script.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { downloadAuthoringBundle } from './authoring-bundle-source.mjs';
import { verifyEnterpriseDraft } from './verify-companion-assets.mjs';
import { releaseSourceCommit } from './release-source.mjs';

const source = JSON.parse(await readFile('release/companion-source.json', 'utf8'));
const catalog = JSON.parse(await readFile('companions/catalog.json', 'utf8'));
assert.equal(source.host, 'github.com'); assert.equal(source.owner, 'mirdadusi'); assert.equal(source.repository, 'open-markdown-review');
const staged = process.argv[2] === '--staged';
assert.ok(process.argv.length === 2 || staged && process.argv.length === 3);
function command(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 300000, shell: false, env: { ...process.env, GH_HOST: source.host } });
  assert.equal(result.status, 0, `${program} failed: ${result.stderr}`); return result.stdout;
}
const repository = `${source.owner}/${source.repository}`, tag = `v${catalog.version}`;
const token = process.env.GH_TOKEN || process.env.OMR_GITHUB_TOKEN || (staged && !process.env.CI ? command('gh', ['auth', 'token', '--hostname', source.host]).trim() : '');
if (staged) assert.ok(token, 'Draft build inputs require maintainer authentication.');
const api = `https://api.github.com/repos/${repository}`;
const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/vnd.github+json' };
async function metadata(url) {
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (response.status === 404) { await response.body?.cancel(); return; }
  assert.equal(response.status, 200, 'Could not read build-time companion release metadata.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; assert.ok(size <= 2 * 1024 * 1024, 'Excessive release metadata.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
// GET /releases/tags/:tag deliberately excludes drafts through the tag endpoint. Drafts must
// be discovered through the authenticated release listing, before tag push.
let release = staged ? undefined : await metadata(`${api}/releases/tags/${tag}`);
if (!release) {
  const matches = [];
  for (let page = 1; page <= 10; page++) {
    const records = await metadata(`${api}/releases?per_page=100&page=${page}`);
    assert.ok(Array.isArray(records), 'Cannot discover staged release inputs.');
    matches.push(...records.filter(item => item.tag_name === tag));
    if (records.length < 100) break;
  }
  assert.equal(matches.length, 1, 'Missing/ambiguous staged companion release.');
  release = matches[0];
}
const record = { isDraft: release.draft, tagName: release.tag_name, targetCommitish: release.target_commitish, assets: release.assets };
if (staged) {
  verifyEnterpriseDraft(record, tag, releaseSourceCommit(), catalog, 'staged');
} else assert.equal(record.tagName, tag);
const directory = await mkdtemp(path.join(os.tmpdir(), 'omr-build-bundle-'));
const resolved = await downloadAuthoringBundle({ source, catalog, record, directory, destination: path.resolve('dist'), token });
console.log(`Staged checksum-verified offline companions from ${resolved.filename}; no standalone release assets or authoring-time network dependency.`);
