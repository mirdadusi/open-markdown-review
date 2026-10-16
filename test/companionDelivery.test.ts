import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorReview } from '../src/professional/authoring';
import { COMPANION_TARGETS, companionTargets } from '../src/professional/companionTargets';
import { CompanionCatalog, companionFileDigest, prepareCompanions } from '../src/professional/companionDelivery';
import { digest, jsonBytes } from '../src/professional/bytes';
import { ReviewSession } from '../src/professional/session';
import { NativeStorage } from '../src/professional/nativeStorage';
import { inspectReviewPackage, relocateReviewPackage } from '../src/professional/relocation';
import { runCli } from '../src/professional/cli';

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omr-delivery-')), source = path.join(temporary, 'source'), built = path.join(temporary, 'client');
  await mkdir(source); await mkdir(built);
  await writeFile(path.join(source, 'index.md'), '# Creation workflow\n\nExact frozen text.\n');
  for (const file of ['OpenMarkdownReview.html', 'companion.js']) await copyFile(path.resolve('dist', file), path.join(built, file));
  const artifact = path.join(built, 'OpenMarkdownReview.html');
  const catalog: CompanionCatalog = { schemaVersion: 'omr-companion-catalog/1', version: '0.6.0', toolboxDigest: digest(await readFile(artifact)), companionDigest: digest(await readFile(path.join(built, 'companion.js'))), targets: [] };
  for (const target of COMPANION_TARGETS) {
    const binary = Buffer.from(`inert unit-test artifact: ${target.id}`), notices = Buffer.from(`inert test notices: ${target.id}`);
    const base = path.join(built, 'companion', target.id); await mkdir(base, { recursive: true });
    await writeFile(path.join(base, target.id === 'win32-x64' ? 'StartReview.exe' : 'StartReview'), binary);
    await writeFile(path.join(base, 'THIRD-PARTY-NOTICES.txt'), notices);
    const item = (filename: string, bytes: Uint8Array) => ({ filename, byteLength: bytes.length, digest: digest(bytes), url: `https://github.com/mirdadusi/open-markdown-review/releases/download/v0.6.0/${filename}` });
    catalog.targets.push({ target: target.id, executable: item(target.filename, binary), notices: item(`${target.filename}.NOTICES.txt`, notices), build: { schemaVersion: 'omr-companion-build/1', version: '0.6.0', target: target.id, nodeVersion: '22.23.1', officialRuntimeSha256: '0'.repeat(64), executableSha256: digest(binary).slice(7), companionSha256: catalog.companionDigest.slice(7), toolboxSha256: catalog.toolboxDigest.slice(7), codeSigning: 'unit-test fixture; not executable', qualification: 'Not platform qualification.' } });
  }
  await writeFile(path.join(built, 'companion-catalog.json'), jsonBytes(catalog));
  const request = { source, store: path.join(temporary, 'review'), rootDocument: 'index.md', title: 'Platform creation', actor: { id: 'creator@example.com' }, operationId: 'platform_creation', journalRoot: path.join(temporary, 'private'), clientArtifact: artifact };
  return { temporary, built, artifact, catalog, request };
}
test('companion platforms are explicit, unique and canonical; unsupported targets are refused', () => {
  assert.deepEqual(companionTargets(undefined), []);
  assert.deepEqual(companionTargets(['linux-x64', 'win32-x64']), ['win32-x64', 'linux-x64']);
  for (const value of [null, 'win32-x64', ['linux-arm64'], ['win32-x64', 'win32-x64'], ['../elsewhere']]) assert.throws(() => companionTargets(value));
});
test('creation installs exactly selected companions with distinct filenames, receipts and executable bits; evidence remains one shared review', async () => {
  const f = await fixture(), created = await authorReview({ ...f.request, companionTargets: ['win32-x64', 'darwin-arm64', 'linux-x64'] });
  assert.equal(created.outcome, 'completed'); assert.equal(created.companionPaths?.length, 13);
  for (const entry of f.catalog.targets) {
    assert.equal((await companionFileDigest(path.join(created.store, entry.executable.filename))).digest, entry.executable.digest);
    assert.equal((await readFile(path.join(created.store, `${entry.executable.filename}.sha256`), 'utf8')).trim(), `${entry.executable.digest.slice(7)}  ${entry.executable.filename}`);
    if (process.platform !== 'win32') assert.equal((await lstat(path.join(created.store, entry.executable.filename))).mode & 0o111, 0o111);
  }
  const session = new ReviewSession(new NativeStorage(created.store, f.request.journalRoot)); await session.open();
  assert.equal(session.events.length, 1); assert.equal(session.events[0].type, 'revision.created');
  assert.equal((await session.audit(session.context(f.request.actor))).diagnostics.length, 0);
  const before = await inspectReviewPackage(created.store), destination = path.join(f.temporary, 'transported');
  await relocateReviewPackage(created.store, destination);
  assert.equal((await inspectReviewPackage(destination)).fingerprint, before.fingerprint);
  const resumed = await authorReview({ ...f.request, companionTargets: ['win32-x64', 'darwin-arm64', 'linux-x64'], resume: true });
  assert.equal(resumed.outcome, 'completed'); assert.deepEqual(await readdir(path.join(created.store, 'events')), [path.basename(before.files.find(file => file.path.startsWith('events/'))!.path)]);
});
test('HTML-only creation never needs a companion catalog; selected subset excludes other executables', async () => {
  const f = await fixture();
  const plain = await authorReview({ ...f.request, store: path.join(f.temporary, 'plain'), operationId: 'plain' });
  assert.equal(plain.companionPaths, undefined); assert.equal((await readdir(plain.store)).some(name => name.startsWith('StartReview')), false);
  const selected = await authorReview({ ...f.request, companionTargets: ['linux-x64'] });
  assert.ok((await readdir(selected.store)).includes('StartReview-linux-x64'));
  assert.equal((await readdir(selected.store)).includes('StartReview-windows-x64.exe'), false);
});
test('stale catalog or altered runtime fails before creating review evidence; dry run neither resolves nor downloads', async () => {
  const f = await fixture();
  await writeFile(path.join(f.built, 'companion', 'win32-x64', 'StartReview.exe'), 'tampered');
  await assert.rejects(authorReview({ ...f.request, companionTargets: ['win32-x64'] }), /failed verification/);
  await assert.rejects(lstat(f.request.store), { code: 'ENOENT' });
  const dry = await authorReview({ ...f.request, companionTargets: ['win32-x64'], dryRun: true }); assert.equal(dry.outcome, 'planned');
  await assert.rejects(lstat(f.request.store), { code: 'ENOENT' });
  f.catalog.toolboxDigest = 'sha256:' + '0'.repeat(64); await writeFile(path.join(f.built, 'companion-catalog.json'), jsonBytes(f.catalog));
  await assert.rejects(authorReview({ ...f.request, companionTargets: ['linux-x64'] }), /stale/);
});
test('offline private cache supplies verified artifacts without a network download', async () => {
  const f = await fixture(), local = path.join(f.temporary, 'client-only'); await mkdir(local);
  for (const file of ['OpenMarkdownReview.html', 'companion.js', 'companion-catalog.json']) await copyFile(path.join(f.built, file), path.join(local, file));
  const entry = f.catalog.targets[0];
  for (const [item, from] of [[entry.executable, 'StartReview.exe'], [entry.notices, 'THIRD-PARTY-NOTICES.txt']] as const) {
    const cache = path.join(f.request.journalRoot, 'companion-cache', f.catalog.version, item.digest.slice(7)); await mkdir(cache, { recursive: true });
    await copyFile(path.join(f.built, 'companion', entry.target, from), path.join(cache, item.filename));
  }
  const prepared = await prepareCompanions({ targets: [entry.target], artifact: path.join(local, 'OpenMarkdownReview.html'), journalRoot: f.request.journalRoot });
  const canonicalCache = await realpath(f.request.journalRoot);
  assert.equal(prepared?.files.length, 2); assert.ok(prepared?.files.every(file => file.source.startsWith(canonicalCache + path.sep)));
});
test('catalogs reject untrusted URLs and mismatched build receipts; linked executables are not accepted', async () => {
  const f = await fixture(), catalogFile = path.join(f.built, 'companion-catalog.json');
  f.catalog.targets[0].executable.url = 'https://example.com/runtime.exe'; await writeFile(catalogFile, jsonBytes(f.catalog));
  await assert.rejects(prepareCompanions({ targets: ['win32-x64'], artifact: f.artifact, journalRoot: f.request.journalRoot }), /Invalid pinned/);
  f.catalog.targets[0].executable.url = 'https://github.com/mirdadusi/open-markdown-review/releases/download/v0.6.0/StartReview-windows-x64.exe';
  f.catalog.targets[0].build.executableSha256 = '0'.repeat(64); await writeFile(catalogFile, jsonBytes(f.catalog));
  await assert.rejects(prepareCompanions({ targets: ['win32-x64'], artifact: f.artifact, journalRoot: f.request.journalRoot }), /receipt/);
  if (process.platform !== 'win32') { const linked = path.join(f.temporary, 'linked'); await symlink(f.artifact, linked); await assert.rejects(companionFileDigest(linked), /regular file/); }
});
test('CLI creation accepts repeatable platform choices and rejects unsupported platforms before publication', async () => {
  const f = await fixture(), args = ['review', 'create', '--source', f.request.source, '--store', f.request.store, '--root-document', 'index.md', '--actor-id', 'creator@example.com', '--operation-id', 'cli_platform', '--companion-target', 'win32-x64', '--companion-target', 'linux-x64'];
  const created = await runCli(args, f.artifact); assert.equal(created.exitCode, 0, JSON.stringify(created.result));
  assert.equal((created.result as { companionPaths: string[] }).companionPaths.length, 9);
  assert.equal((await runCli([...args, '--companion-target', 'unsupported'], f.artifact)).exitCode, 2);
});
test('pinned downloads are cached once, streamed and verified; altered bytes fail before evidence publication', async () => {
  const f = await fixture(), local = path.join(f.temporary, 'download-client'); await mkdir(local);
  for (const file of ['OpenMarkdownReview.html', 'companion.js', 'companion-catalog.json']) await copyFile(path.join(f.built, file), path.join(local, file));
  const entry = f.catalog.targets[0], original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls++; const url = String(input), executable = url === entry.executable.url;
      assert.ok(executable || url === entry.notices.url);
      const bytes = await readFile(path.join(f.built, 'companion', entry.target, executable ? 'StartReview.exe' : 'THIRD-PARTY-NOTICES.txt'));
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    }) as typeof fetch;
    const options = { targets: [entry.target], artifact: path.join(local, 'OpenMarkdownReview.html'), journalRoot: f.request.journalRoot };
    assert.equal((await prepareCompanions(options))?.files.length, 2); assert.equal(calls, 2);
    await prepareCompanions(options); assert.equal(calls, 2, 'Verified private cache avoids repeated runtime downloads.');
    globalThis.fetch = (async () => new Response(new Uint8Array(entry.executable.byteLength).fill(1), { status: 200 })) as typeof fetch;
    await assert.rejects(authorReview({ ...f.request, clientArtifact: options.artifact, journalRoot: path.join(f.temporary, 'bad-cache'), companionTargets: [entry.target] }), /checksum/);
    await assert.rejects(lstat(f.request.store), { code: 'ENOENT' });
  } finally { globalThis.fetch = original; }
});
