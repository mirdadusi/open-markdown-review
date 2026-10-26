import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateUpdateSource, OMR_UPDATE_SOURCE } from '../src/updates/source';
import { isAllowedAssetApiUrl, isAllowedAssetRedirect } from '../src/updates/policy';

test('public Marketplace updates and bundled companion provenance have separate, matching identities', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const source = validateUpdateSource(JSON.parse(await readFile('release/companion-source.json', 'utf8')));
  assert.equal(pkg.publisher, 'mirdadusi'); assert.equal(pkg.license, 'MIT');
  assert.equal(OMR_UPDATE_SOURCE.channel, 'marketplace');
  assert.equal(OMR_UPDATE_SOURCE.extensionId, `${pkg.publisher}.${pkg.name}`);
  assert.equal(source.extensionId, OMR_UPDATE_SOURCE.extensionId);
  assert.equal(source.channel, 'github-release');
  if (source.channel !== 'github-release') throw Error('Expected a GitHub companion build source.');
  assert.equal(source.latestReleaseApiUrl, 'https://api.github.com/repos/mirdadusi/open-markdown-review/releases/latest');
  assert.ok(isAllowedAssetApiUrl('https://api.github.com/repos/mirdadusi/open-markdown-review/releases/assets/123', source));
  for (const value of ['https://api.github.com/repos/other/repository/releases/assets/123', 'https://github.com/api/v3/repos/mirdadusi/open-markdown-review/releases/assets/123', 'https://user:pass@api.github.com/repos/mirdadusi/open-markdown-review/releases/assets/123', 'https://api.github.com/repos/mirdadusi/open-markdown-review/releases/assets/123?extra=1']) assert.equal(isAllowedAssetApiUrl(value, source), false);
  assert.equal(isAllowedAssetRedirect('https://release-assets.githubusercontent.com/signed-file?signature=test', source), true);
  assert.equal(isAllowedAssetRedirect('https://untrusted.invalid/signed-file', source), false);
});

test('public creation UI describes the complete offline extension update, not a separate runtime download', async () => {
  const setup = await readFile('src/setupView.ts', 'utf8');
  const catalog = JSON.parse(await readFile('companions/catalog.json', 'utf8'));
  assert.match(setup, /All three platforms are bundled inside this extension and its updates/);
  assert.doesNotMatch(setup, /An uncached platform needs a download|roughly 90–120 MiB/);
  assert.equal(catalog.delivery, 'bundled-v1');
  assert.equal(catalog.runtime, 'go');
  assert.deepEqual(catalog.targets.map((item: { target: string }) => item.target).sort(), ['darwin-arm64', 'linux-x64', 'win32-x64']);
  assert.ok(catalog.targets.every((item: { executable: { url?: string } }) => item.executable.url === undefined));
});
