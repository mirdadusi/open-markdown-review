import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { downloadVerifiedVsix, MAX_VSIX_BYTES } from '../src/updates/githubReleaseClient';
import { stageVerifiedVsix } from '../src/updates/stagedDownload';
import { GitHubReleaseUpdateSource, UpdateRelease } from '../src/updates/types';

// Exercise the optional GitHub transport independently of the installed
// extension's native Marketplace distribution channel.
const source: GitHubReleaseUpdateSource = {
  schemaVersion: 1, channel: 'github-release',
  extensionId: 'mirdadusi.open-markdown-review',
  host: 'github.com', owner: 'mirdadusi', repository: 'open-markdown-review',
  releasesUrl: 'https://github.com/mirdadusi/open-markdown-review/releases',
  latestReleaseApiUrl: 'https://api.github.com/repos/mirdadusi/open-markdown-review/releases/latest',
  artifactBaseName: 'open-markdown-review',
  assetRedirectHosts: ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'],
};
const name = 'open-markdown-review-0.6.1-portable.vsix';
const release: UpdateRelease = { version: '0.6.1', tag: 'v0.6.1', releaseUrl: source.releasesUrl + '/tag/v0.6.1', artifact: { name, checksumName: name + '.sha256', target: 'portable', apiUrl: source.latestReleaseApiUrl.replace('/releases/latest', '/releases/assets/10'), checksumApiUrl: source.latestReleaseApiUrl.replace('/releases/latest', '/releases/assets/11') } };
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function fetcher(hash: string, response: () => Response) {
  return (async (input: string | URL | Request) => String(input) === release.artifact.checksumApiUrl ? new Response(`${hash}  ${name}\n`) : response()) as typeof fetch;
}
test('native update streaming accepts a 129 MiB VSIX without buffering the archive', async () => {
  assert.equal(MAX_VSIX_BYTES, 256 * 1024 * 1024);
  const chunk = new Uint8Array(1024 * 1024).fill(37), hash = createHash('sha256');
  for (let i = 0; i < 129; i++) hash.update(chunk);
  let delivered = 0, writes = 0, total = 0;
  const fetchImpl = fetcher(hash.digest('hex'), () => new Response(new ReadableStream({ pull(controller) { if (delivered++ < 129) controller.enqueue(chunk); else controller.close(); } }), { headers: { 'content-length': String(129 * chunk.length) } }));
  const result = await downloadVerifiedVsix({ source, release, fetchImpl, writeChunk: async bytes => { writes++; total += bytes.length; assert.ok(bytes.length <= chunk.length); } });
  assert.equal(result.kind, 'streamed'); assert.equal(writes, 129); assert.equal(total, 129 * chunk.length); assert.equal('bytes' in result, false);
});
test('a real native private file stages and verifies an archive above the old 128 MiB cap', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omr-large-update-')), chunk = Buffer.alloc(1024 * 1024, 41), expected = createHash('sha256');
  for (let i = 0; i < 129; i++) expected.update(chunk);
  const checksum = expected.digest('hex'); let sent = 0;
  const fetchImpl = fetcher(checksum, () => new Response(new ReadableStream({ pull(controller) { if (sent++ < 129) controller.enqueue(chunk); else controller.close(); } })));
  const staged = await stageVerifiedVsix(directory, { source, release, fetchImpl });
  assert.equal(staged.result.kind, 'streamed'); assert.ok(staged.file);
  t.after(async () => { await unlink(staged.file!); await rmdir(path.dirname(staged.file!)); await rmdir(directory); });
  const actual = createHash('sha256'); let length = 0;
  for await (const bytes of createReadStream(staged.file)) { actual.update(bytes); length += bytes.length; }
  assert.equal(actual.digest('hex'), checksum); assert.equal(length, 129 * chunk.length);
});
test('streaming rejects over-budget, truncated and mismatched bytes; no failure is verified', async () => {
  const bytes = Buffer.from('small verified update');
  for (const [fetchImpl, maxBytes] of [
    [fetcher(sha(bytes), () => new Response(bytes, { headers: { 'content-length': String(MAX_VSIX_BYTES + 1) } })), undefined],
    [fetcher(sha(bytes), () => new Response(bytes, { headers: { 'content-length': String(bytes.length + 1) } })), undefined],
    [fetcher('0'.repeat(64), () => new Response(bytes)), undefined],
    [fetcher(sha(bytes), () => new Response(bytes)), 4],
  ] as const) {
    const result = await downloadVerifiedVsix({ source, release, fetchImpl, maxBytes, writeChunk: async () => {} });
    assert.equal(result.kind, 'invalid-metadata');
  }
});
test('cancellation after the last chunk and a failing disk sink cannot return a verified update', async () => {
  const bytes = Buffer.from('cancelled update'), fetchImpl = fetcher(sha(bytes), () => new Response(bytes)), controller = new AbortController();
  const cancelled = await downloadVerifiedVsix({ source, release, fetchImpl, signal: controller.signal, writeChunk: async () => controller.abort() });
  assert.equal(cancelled.kind, 'unavailable');
  const failed = await downloadVerifiedVsix({ source, release, fetchImpl, writeChunk: async () => { throw new Error('Disk is full.'); } });
  assert.deepEqual(failed, { kind: 'unavailable', reason: 'storage' });
});
test('private update staging exposes only exact verified bytes and cleans refused/cancelled partial files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omr-update-stream-')), bytes = Buffer.from('verified staged update');
  const ready = await stageVerifiedVsix(directory, { source, release, fetchImpl: fetcher(sha(bytes), () => new Response(bytes)) });
  assert.equal(ready.result.kind, 'streamed'); assert.ok(ready.file); assert.deepEqual(await readFile(ready.file), bytes);
  const before = await readdir(directory);
  for (const bad of [fetcher('0'.repeat(64), () => new Response(bytes)), (async () => new Response(null, { status: 401 })) as typeof fetch]) {
    const result = await stageVerifiedVsix(directory, { source, release, fetchImpl: bad }); assert.equal(result.file, undefined); assert.notEqual(result.result.kind, 'streamed');
    assert.deepEqual(await readdir(directory), before);
  }
  const controller = new AbortController(); controller.abort();
  const cancelled = await stageVerifiedVsix(directory, { source, release, signal: controller.signal, fetchImpl: fetcher(sha(bytes), () => new Response(bytes)) });
  assert.equal(cancelled.file, undefined); assert.deepEqual(await readdir(directory), before);
  await assert.rejects(stageVerifiedVsix('relative/path', { source, release }));
});
