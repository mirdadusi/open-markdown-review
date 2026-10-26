import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authorReview } from '../src/professional/authoring';
import { COMPANION_TARGETS, companionTargets } from '../src/professional/companionTargets';
import { CompanionCatalog, companionFileDigest, prepareCompanions } from '../src/professional/companionDelivery';
import { decode, digest, jsonBytes, pointAt } from '../src/professional/bytes';
import { ReviewSession } from '../src/professional/session';
import { NativeStorage } from '../src/professional/nativeStorage';
import { inspectReviewPackage, relocateReviewPackage } from '../src/professional/relocation';
import { runCli } from '../src/professional/cli';
import { companionReleaseBase, companionReleaseResolver } from '../src/professional/companionRelease';
import { goExecutable } from '../src/professional/goCompanion';
import { inspectClientUpgrade, upgradeReviewClient } from '../src/professional/clientUpgrade';

const releaseApi = 'https://api.github.com/repos/mirdadusi/open-markdown-review/releases';
function releaseMetadata(catalog: CompanionCatalog) {
  return { tag_name: `v${catalog.version}`, draft: false, prerelease: false, html_url: `${companionReleaseBase}/tag/v${catalog.version}`,
    assets: catalog.targets.flatMap(entry => [entry.executable, entry.notices]).map((item, index) => ({ name: item.filename, size: item.byteLength, url: `${releaseApi}/assets/${index + 1}` })) };
}

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omr-delivery-')), source = path.join(temporary, 'source'), built = path.join(temporary, 'client');
  await mkdir(source); await mkdir(built);
  await writeFile(path.join(source, 'index.md'), '# Creation workflow\n\nExact frozen text.\n');
  for (const file of ['OpenMarkdownReview.html', 'companion-core.js']) await copyFile(path.resolve('dist', file), path.join(built, file));
  const artifact = path.join(built, 'OpenMarkdownReview.html');
  const catalog: CompanionCatalog = { schemaVersion: 'omr-companion-catalog/2', runtime: 'go', version: '0.6.0', toolboxDigest: digest(await readFile(artifact)), companionDigest: digest(await readFile(path.join(built, 'companion-core.js'))), targets: [] };
  for (const target of COMPANION_TARGETS) {
    const binary = Buffer.from(`inert unit-test artifact: ${target.id}`), notices = Buffer.from(`inert test notices: ${target.id}`);
    const base = path.join(built, 'companion-go', target.id); await mkdir(base, { recursive: true });
    await writeFile(path.join(base, target.id === 'win32-x64' ? 'StartReview.exe' : 'StartReview'), binary);
    await writeFile(path.join(base, 'THIRD-PARTY-NOTICES.txt'), notices);
    const item = (filename: string, bytes: Uint8Array) => ({ filename, byteLength: bytes.length, digest: digest(bytes), url: `${companionReleaseBase}/download/v0.6.0/${filename}` });
    catalog.targets.push({ target: target.id, executable: item(target.filename, binary), notices: item(`${target.filename}.NOTICES.txt`, notices), build: { schemaVersion: 'omr-go-build/1', runtime: 'go', version: '0.6.0', target: target.id, toolchain:'go1.27.3', testFaults:false, digest:digest(binary), byteLength:binary.length, qualified:false, inputs:{hostSource:'sha256:'+'0'.repeat(64),core:catalog.companionDigest,toolbox:catalog.toolboxDigest,notices:digest(notices),goMod:'sha256:'+'1'.repeat(64),goSum:'sha256:'+'2'.repeat(64)}, codeSigning: 'unit-test fixture; not executable', qualification: 'Not platform qualification.' } });
  }
  await writeFile(path.join(built, 'companion-catalog.json'), jsonBytes(catalog));
  const request = { source, store: path.join(temporary, 'review'), rootDocument: 'index.md', title: 'Platform creation', actor: { id: 'creator@example.com' }, operationId: 'platform_creation', journalRoot: path.join(temporary, 'private'), clientArtifact: artifact };
  return { temporary, built, artifact, catalog, request };
}
async function assertNoReviewSidecars(root: string) {
  const names = await readdir(root);
  assert.deepEqual(names.filter(name => /(?:\.sha256|\.build\.json|\.NOTICES\.txt)$/.test(name) || ['build.json', 'THIRD-PARTY-NOTICES.txt'].includes(name)), []);
}
test('companion platforms are explicit, unique and canonical; unsupported targets are refused', () => {
  assert.deepEqual(companionTargets(undefined), []);
  assert.deepEqual(companionTargets(['linux-x64', 'win32-x64']), ['win32-x64', 'linux-x64']);
  for (const value of [null, 'win32-x64', ['linux-arm64'], ['win32-x64', 'win32-x64'], ['../elsewhere']]) assert.throws(() => companionTargets(value));
});
test('obsolete Go toolchains are refused before creation or launcher selection', async () => {
  const f = await fixture();
  for (const entry of f.catalog.targets) entry.build.toolchain = 'go1.27.2';
  await writeFile(path.join(f.built, 'companion-catalog.json'), jsonBytes(f.catalog));
  await assert.rejects(authorReview({ ...f.request, companionTargets: ['win32-x64'] }), /production distribution/);
  await assert.rejects(lstat(f.request.store), { code: 'ENOENT' });
  await assert.rejects(goExecutable(f.artifact, true), /production distribution/);
});
test('Go selection never falls back to a legacy catalog, received launcher, development artifact or network', async () => {
  const f = await fixture(), target = `${process.platform}-${process.arch}`, entry = f.catalog.targets.find(t => t.target === target)!;
  const candidate = path.join(f.built, 'companion-go', target, process.platform === 'win32' ? 'StartReview.exe' : 'StartReview');
  await assert.rejects(goExecutable(f.artifact), /missing/);
  assert.equal(await goExecutable(f.artifact, true), candidate, 'Development fallback is explicit and still pinned.');
  const installed = path.join(f.built, 'bundled-companions', target, path.basename(candidate)); await mkdir(path.dirname(installed), { recursive: true });
  await copyFile(candidate, installed); assert.equal(await goExecutable(f.artifact), installed);
  await writeFile(installed, 'tampered launcher'); await assert.rejects(goExecutable(f.artifact, true), /differs from/);
  await writeFile(installed, await readFile(candidate));
  await writeFile(path.join(f.built, 'companion-catalog.json'), jsonBytes({ ...f.catalog, runtime: 'node-legacy' }));
  await assert.rejects(goExecutable(f.artifact), /Legacy Node/);
  entry.build.testFaults = true as false; await writeFile(path.join(f.built, 'companion-catalog.json'), jsonBytes(f.catalog));
  await assert.rejects(goExecutable(f.artifact), /production distribution/);
});
test('tooling upgrade backs up legacy Node, installs Go and preserves all existing review evidence', async () => {
  const f = await fixture(), created = await authorReview(f.request), store = new NativeStorage(created.store, f.request.journalRoot);
  await writeFile(path.join(store.root, 'StartReview.exe'), 'inert old Node launcher');
  await writeFile(path.join(store.root, 'build.json'), '{"runtime":"node-legacy"}');
  const before = await inspectClientUpgrade(store), options = { store, artifact: f.artifact, targets: COMPANION_TARGETS.map(t => t.id), expectManifestDigest: before.manifestDigest, expectClientDigest: before.clientDigest, expectToolingFingerprint: before.toolingFingerprint };
  const result = await upgradeReviewClient(options);
  assert.equal(result.reviewId, created.reviewId); assert.equal(result.preservedEvidenceFiles, before.evidence.length);
  assert.equal(await readFile(path.join(result.backupPath, 'legacy-node/StartReview.exe'), 'utf8'), 'inert old Node launcher');
  assert.equal(await readFile(path.join(result.backupPath, 'retired-sidecars/build.json'), 'utf8'), '{"runtime":"node-legacy"}');
  await assert.rejects(lstat(path.join(store.root, 'StartReview.exe')), { code: 'ENOENT' });
  await assertNoReviewSidecars(store.root);
  for (const file of before.evidence) assert.equal(digest(await readFile(path.join(store.root, file.path))), file.digest);
  for (const entry of f.catalog.targets) assert.equal(digest(await readFile(path.join(store.root, entry.executable.filename))), entry.executable.digest);
  assert.match(await readFile(path.join(store.root, 'START-HERE.txt'), 'utf8'), /Go companion/);
  assert.equal(JSON.parse(await readFile(path.join(result.backupPath, 'completed.json'), 'utf8')).runtime, 'go');
  const cli = await runCli(['client', 'inspect', '--store', store.root], f.artifact); assert.equal(cli.exitCode, 0);
});
test('Go tooling upgrade retires every historical sidecar recoverably and a repeated upgrade keeps the root clean', async () => {
  const f = await fixture(), created = await authorReview({ ...f.request, companionTargets: COMPANION_TARGETS.map(t => t.id) });
  const store = new NativeStorage(created.store, f.request.journalRoot);
  const names = ['StartReview.exe.sha256', 'StartReview.sha256', 'build.json', 'THIRD-PARTY-NOTICES.txt', ...f.catalog.targets.flatMap(entry => [entry.executable.filename + '.sha256', entry.executable.filename + '.build.json', entry.notices.filename])];
  const license = 'Retained package license'; await writeFile(path.join(store.root, 'LICENSE'), license);
  for (const name of names) await writeFile(path.join(store.root, name), `historical bytes: ${name}`);
  const before = await inspectClientUpgrade(store);
  const result = await upgradeReviewClient({ store, artifact: f.artifact, targets: COMPANION_TARGETS.map(t => t.id), expectManifestDigest: before.manifestDigest, expectClientDigest: before.clientDigest, expectToolingFingerprint: before.toolingFingerprint });
  await assertNoReviewSidecars(store.root);
  assert.equal(result.companionPaths.length, 4);
  for (const name of names) {
    assert.equal(await readFile(path.join(result.backupPath, 'retired-sidecars', name), 'utf8'), `historical bytes: ${name}`);
    assert.equal(await readFile(path.join(result.backupPath, 'previous', name), 'utf8'), `historical bytes: ${name}`);
  }
  for (const file of before.evidence) assert.equal(digest(await readFile(path.join(store.root, file.path))), file.digest);
  assert.equal(await readFile(path.join(store.root, 'LICENSE'), 'utf8'), license);
  const again = await inspectClientUpgrade(store);
  const repeated = await upgradeReviewClient({ store, artifact: f.artifact, targets: COMPANION_TARGETS.map(t => t.id), expectManifestDigest: again.manifestDigest, expectClientDigest: again.clientDigest, expectToolingFingerprint: again.toolingFingerprint });
  await assertNoReviewSidecars(store.root);
  assert.notEqual(repeated.backupPath, result.backupPath);
  assert.deepEqual((await inspectClientUpgrade(store)).evidence, before.evidence);
});
test('changed sidecar is not retired after confirmation; the original backup and review evidence remain', async () => {
  const f = await fixture(), created = await authorReview(f.request), store = new NativeStorage(created.store, f.request.journalRoot);
  const name = 'StartReview-windows-x64.exe.sha256'; await writeFile(path.join(store.root, name), 'original checksum');
  const before = await inspectClientUpgrade(store);
  await assert.rejects(upgradeReviewClient({ store, artifact: f.artifact, targets: ['win32-x64'], expectManifestDigest: before.manifestDigest, expectClientDigest: before.clientDigest, expectToolingFingerprint: before.toolingFingerprint, progress: message => { if (message.startsWith('Installing Go')) writeFileSync(path.join(store.root, name), 'modified checksum'); } }), /did not complete.*changed/s);
  assert.equal(await readFile(path.join(store.root, name), 'utf8'), 'modified checksum');
  const [backup] = await readdir(path.join(store.root, 'client-backups'));
  assert.equal(await readFile(path.join(store.root, 'client-backups', backup, 'previous', name), 'utf8'), 'original checksum');
  await assert.rejects(lstat(path.join(store.root, 'client-backups', backup, 'completed.json')), { code: 'ENOENT' });
  for (const file of before.evidence) assert.equal(digest(await readFile(path.join(store.root, file.path))), file.digest);
});
test('tooling upgrade preflight refuses changed identity/tooling, omitted existing platforms and corrupt Go without touching the review', async () => {
  const f = await fixture(), created = await authorReview(f.request), store = new NativeStorage(created.store, f.request.journalRoot);
  await writeFile(path.join(store.root, 'StartReview.exe'), 'old Node');
  const before = await inspectClientUpgrade(store), options = { store, artifact: f.artifact, targets: COMPANION_TARGETS.map(t => t.id), expectManifestDigest: before.manifestDigest, expectClientDigest: before.clientDigest, expectToolingFingerprint: before.toolingFingerprint };
  await assert.rejects(upgradeReviewClient({ ...options, expectManifestDigest: digest('wrong review') }), /since confirmation/);
  await assert.rejects(upgradeReviewClient({ ...options, targets: ['linux-x64'] }), /every currently installed/);
  await writeFile(path.join(f.built, 'companion-go/win32-x64/StartReview.exe'), 'tampered Go');
  await assert.rejects(upgradeReviewClient(options), /failed verification/);
  assert.deepEqual(await inspectClientUpgrade(store), before);
  assert.equal((await readdir(store.root)).includes('client-backups'), false, 'Preflight creates no backup or partial tooling.');
});
test('interrupted tooling upgrade reports retained backups and never changes evidence or claims completion', async () => {
  const f = await fixture(), created = await authorReview(f.request), store = new NativeStorage(created.store, f.request.journalRoot), before = await inspectClientUpgrade(store);
  await assert.rejects(upgradeReviewClient({ store, artifact: f.artifact, targets: ['win32-x64'], expectManifestDigest: before.manifestDigest, expectClientDigest: before.clientDigest, expectToolingFingerprint: before.toolingFingerprint, progress: message => { if (message.startsWith('Installing Go')) throw Error('simulated interruption'); } }), /did not complete.*Backups/s);
  const after = await inspectClientUpgrade(store); assert.deepEqual(after.evidence, before.evidence); assert.deepEqual(after.tooling, before.tooling);
  const backups = await readdir(path.join(store.root, 'client-backups')); assert.equal(backups.length, 1);
  await assert.rejects(lstat(path.join(store.root, 'client-backups', backups[0], 'completed.json')), { code: 'ENOENT' });
});
test('a valid new peer comment during tooling upgrade is retained, not treated as immutable evidence loss', async () => {
  const f = await fixture(), created = await authorReview(f.request), store = new NativeStorage(created.store, f.request.journalRoot), before = await inspectClientUpgrade(store);
  const peer = new ReviewSession(store); await peer.open();
  const context = peer.context({ id: 'peer@example.com' }), doc = context.revision.documents[0], text = decode(await peer.content(doc)), exact = 'Exact frozen text.', start = text.indexOf(exact);
  const event = peer.makeEvent(context, { type: 'comment.created', threadId: 'peer_thread', commentId: 'peer_comment', anchor: { document: doc.path, documentDigest: doc.digest, range: { start: pointAt(text, start), end: pointAt(text, start + exact.length) }, quote: { exact }, target: { kind: 'text' } }, body: { format: 'markdown', text: 'Arrived while tooling was being upgraded.' } });
  const bytes = jsonBytes(event), filename = path.join(store.root, 'events', `${digest(bytes).slice(7)}.json`);
  let published = false;
  await upgradeReviewClient({ store, artifact: f.artifact, targets: ['win32-x64'], expectManifestDigest: before.manifestDigest, expectClientDigest: before.clientDigest, expectToolingFingerprint: before.toolingFingerprint, progress: message => { if (message.startsWith('Installing Go')) { writeFileSync(filename, bytes, { flag: 'wx' }); published = true; } } });
  assert.equal(published, true); assert.equal(digest(await readFile(filename)), digest(bytes));
  const after = new ReviewSession(store); await after.open(); assert.equal(after.diagnostics.length, 0); assert.ok(after.events.some(e => e.id === event.id));
  for (const file of before.evidence) assert.equal(digest(await readFile(path.join(store.root, file.path))), file.digest);
});
test('creation installs only selected executables and instructions, without sidecars; evidence remains one shared review', async () => {
  const f = await fixture(), created = await authorReview({ ...f.request, companionTargets: ['win32-x64', 'darwin-arm64', 'linux-x64'] });
  assert.equal(created.outcome, 'completed'); assert.equal(created.companionPaths?.length, 4);
  assert.deepEqual(created.companionPaths?.map(file => path.basename(file)).sort(), ['START-HERE.txt', ...COMPANION_TARGETS.map(target => target.filename)].sort());
  await assertNoReviewSidecars(created.store);
  const instructions = await readFile(path.join(created.store, 'START-HERE.txt'), 'utf8');
  assert.match(instructions, /--licenses/); assert.match(instructions, /trusted authoring distribution\/release, not this review folder/);
  for (const entry of f.catalog.targets) {
    assert.equal((await companionFileDigest(path.join(created.store, entry.executable.filename))).digest, entry.executable.digest);
    assert.equal(digest(await readFile(path.join(f.built, 'companion-go', entry.target, 'THIRD-PARTY-NOTICES.txt'))), entry.notices.digest, 'Trusted distribution notices are retained.');
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
  await assertNoReviewSidecars(created.store);
});
test('HTML-only creation never needs a companion catalog; selected subset excludes other executables', async () => {
  const f = await fixture();
  const plain = await authorReview({ ...f.request, store: path.join(f.temporary, 'plain'), operationId: 'plain' });
  assert.equal(plain.companionPaths, undefined); assert.equal((await readdir(plain.store)).some(name => name.startsWith('StartReview')), false);
  const selected = await authorReview({ ...f.request, companionTargets: ['linux-x64'] });
  assert.ok((await readdir(selected.store)).includes('StartReview-linux-x64'));
  assert.equal((await readdir(selected.store)).includes('StartReview-windows-x64.exe'), false);
});
test('bundled authoring creates all platforms without network or credentials; an incomplete installed bundle fails closed', async () => {
  const f = await fixture(), installed = path.join(f.temporary, 'installed-vsix'); await mkdir(installed);
  for (const file of ['OpenMarkdownReview.html', 'companion-core.js']) await copyFile(path.join(f.built, file), path.join(installed, file));
  f.catalog.delivery = 'bundled-v1'; await writeFile(path.join(installed, 'companion-catalog.json'), jsonBytes(f.catalog));
  for (const item of f.catalog.targets) {
    const root = path.join(installed, 'bundled-companions', item.target); await mkdir(root, { recursive: true });
    for (const file of [item.target === 'win32-x64' ? 'StartReview.exe' : 'StartReview', 'THIRD-PARTY-NOTICES.txt']) await copyFile(path.join(f.built, 'companion-go', item.target, file), path.join(root, file));
  }
  const original = globalThis.fetch; globalThis.fetch = (async () => { throw new Error('Network access is forbidden.'); }) as typeof fetch;
  try {
    const created = await authorReview({ ...f.request, clientArtifact: path.join(installed, 'OpenMarkdownReview.html'), companionTargets: ['win32-x64', 'darwin-arm64', 'linux-x64'], companionToken: async () => { throw new Error('Authentication is forbidden.'); } });
    assert.equal(created.outcome, 'completed');
    for (const item of f.catalog.targets) assert.equal((await companionFileDigest(path.join(created.store, item.executable.filename))).digest, item.executable.digest);
    // A different installation has no payloads, and must not fall back to a cache or download.
    const partial = path.join(f.temporary, 'partial-vsix'); await mkdir(partial);
    for (const file of ['OpenMarkdownReview.html', 'companion-core.js', 'companion-catalog.json']) await copyFile(path.join(installed, file), path.join(partial, file));
    await assert.rejects(authorReview({ ...f.request, store: path.join(f.temporary, 'not-created'), clientArtifact: path.join(partial, 'OpenMarkdownReview.html'), companionTargets: ['win32-x64'] }), /missing its bundled/);
    await assert.rejects(lstat(path.join(f.temporary, 'not-created')), { code: 'ENOENT' });
  } finally { globalThis.fetch = original; }
});
test('stale catalog or altered runtime fails before creating review evidence; dry run neither resolves nor downloads', async () => {
  const f = await fixture();
  await writeFile(path.join(f.built, 'companion-go', 'win32-x64', 'StartReview.exe'), 'tampered');
  await assert.rejects(authorReview({ ...f.request, companionTargets: ['win32-x64'] }), /failed verification/);
  await assert.rejects(lstat(f.request.store), { code: 'ENOENT' });
  const dry = await authorReview({ ...f.request, companionTargets: ['win32-x64'], dryRun: true }); assert.equal(dry.outcome, 'planned');
  await assert.rejects(lstat(f.request.store), { code: 'ENOENT' });
  f.catalog.toolboxDigest = 'sha256:' + '0'.repeat(64); await writeFile(path.join(f.built, 'companion-catalog.json'), jsonBytes(f.catalog));
  await assert.rejects(authorReview({ ...f.request, companionTargets: ['linux-x64'] }), /stale/);
});
test('notices are still hash-verified before creation and upgrade even though they are not copied to the review', async () => {
  const f = await fixture(), created = await authorReview(f.request), store = new NativeStorage(created.store, f.request.journalRoot);
  const before = await inspectClientUpgrade(store);
  await writeFile(path.join(f.built, 'companion-go', 'win32-x64', 'THIRD-PARTY-NOTICES.txt'), 'altered distribution notices');
  const fresh = path.join(f.temporary, 'not-published');
  await assert.rejects(authorReview({ ...f.request, store: fresh, operationId: 'notices_integrity', companionTargets: ['win32-x64'] }), /failed verification/);
  await assert.rejects(lstat(fresh), { code: 'ENOENT' });
  await assert.rejects(upgradeReviewClient({ store, artifact: f.artifact, targets: ['win32-x64'], expectManifestDigest: before.manifestDigest, expectClientDigest: before.clientDigest, expectToolingFingerprint: before.toolingFingerprint }), /failed verification/);
  assert.deepEqual(await inspectClientUpgrade(store), before);
  await assert.rejects(lstat(path.join(store.root, 'client-backups')), { code: 'ENOENT' });
});
test('offline private cache supplies verified artifacts without a network download', async () => {
  const f = await fixture(), local = path.join(f.temporary, 'client-only'); await mkdir(local);
  for (const file of ['OpenMarkdownReview.html', 'companion-core.js', 'companion-catalog.json']) await copyFile(path.join(f.built, file), path.join(local, file));
  const entry = f.catalog.targets[0];
  for (const [item, from] of [[entry.executable, 'StartReview.exe'], [entry.notices, 'THIRD-PARTY-NOTICES.txt']] as const) {
    const cache = path.join(f.request.journalRoot, 'companion-cache', f.catalog.version, item.digest.slice(7)); await mkdir(cache, { recursive: true });
    await copyFile(path.join(f.built, 'companion-go', entry.target, from), path.join(cache, item.filename));
  }
  const prepared = await prepareCompanions({ targets: [entry.target], artifact: path.join(local, 'OpenMarkdownReview.html'), journalRoot: f.request.journalRoot });
  const canonicalCache = await realpath(f.request.journalRoot);
  assert.equal(prepared?.files.length, 1); assert.ok(prepared?.files.every(file => file.source.startsWith(canonicalCache + path.sep)));
});
test('catalogs reject untrusted URLs and mismatched build receipts; linked executables are not accepted', async () => {
  const f = await fixture(), catalogFile = path.join(f.built, 'companion-catalog.json');
  f.catalog.targets[0].executable.url = 'https://example.com/runtime.exe'; await writeFile(catalogFile, jsonBytes(f.catalog));
  await assert.rejects(prepareCompanions({ targets: ['win32-x64'], artifact: f.artifact, journalRoot: f.request.journalRoot }), /Invalid pinned/);
  f.catalog.targets[0].executable.url = `${companionReleaseBase}/download/v0.6.0/StartReview-windows-x64.exe`;
  f.catalog.targets[0].build.digest = 'sha256:'+'0'.repeat(64); await writeFile(catalogFile, jsonBytes(f.catalog));
  await assert.rejects(prepareCompanions({ targets: ['win32-x64'], artifact: f.artifact, journalRoot: f.request.journalRoot }), /receipt/);
  if (process.platform !== 'win32') { const linked = path.join(f.temporary, 'linked'); await symlink(f.artifact, linked); await assert.rejects(companionFileDigest(linked), /regular file/); }
});
test('CLI creation accepts repeatable platform choices and rejects unsupported platforms before publication', async () => {
  const f = await fixture(), args = ['review', 'create', '--source', f.request.source, '--store', f.request.store, '--root-document', 'index.md', '--actor-id', 'creator@example.com', '--operation-id', 'cli_platform', '--companion-target', 'win32-x64', '--companion-target', 'linux-x64'];
  const created = await runCli(args, f.artifact); assert.equal(created.exitCode, 0, JSON.stringify(created.result));
  assert.equal((created.result as { companionPaths: string[] }).companionPaths.length, 3);
  await assertNoReviewSidecars(f.request.store);
  assert.equal((await runCli([...args, '--companion-target', 'unsupported'], f.artifact)).exitCode, 2);
});
test('pinned downloads are cached once, streamed and verified; altered bytes fail before evidence publication', async () => {
  const f = await fixture(), local = path.join(f.temporary, 'download-client'); await mkdir(local);
  for (const file of ['OpenMarkdownReview.html', 'companion-core.js', 'companion-catalog.json']) await copyFile(path.join(f.built, file), path.join(local, file));
  const entry = f.catalog.targets[0], original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls++; const url = String(input);
      if (url === `${releaseApi}/tags/v0.6.0`) return Response.json(releaseMetadata(f.catalog));
      const executable = url === `${releaseApi}/assets/1`;
      assert.ok(executable || url === `${releaseApi}/assets/2`);
      const bytes = await readFile(path.join(f.built, 'companion-go', entry.target, executable ? 'StartReview.exe' : 'THIRD-PARTY-NOTICES.txt'));
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    }) as typeof fetch;
    const options = { targets: [entry.target], artifact: path.join(local, 'OpenMarkdownReview.html'), journalRoot: f.request.journalRoot, companionToken: async () => undefined };
    assert.equal((await prepareCompanions(options))?.files.length, 1); assert.equal(calls, 3);
    await prepareCompanions(options); assert.equal(calls, 3, 'Verified private cache avoids repeated runtime downloads.');
    globalThis.fetch = (async (input: string | URL | Request) => String(input).endsWith('/tags/v0.6.0') ? Response.json(releaseMetadata(f.catalog)) : new Response(new Uint8Array(entry.executable.byteLength).fill(1), { status: 200 })) as typeof fetch;
    await assert.rejects(authorReview({ ...f.request, clientArtifact: options.artifact, journalRoot: path.join(f.temporary, 'bad-cache'), companionTargets: [entry.target], companionToken: options.companionToken }), /checksum/);
    await assert.rejects(lstat(f.request.store), { code: 'ENOENT' });
  } finally { globalThis.fetch = original; }
});

test('authenticated enterprise download strips credentials on CDN redirects and never records tokens', async () => {
  const f = await fixture(), local = path.join(f.temporary, 'cold-client'); await mkdir(local);
  for (const file of ['OpenMarkdownReview.html', 'companion-core.js', 'companion-catalog.json']) await copyFile(path.join(f.built, file), path.join(local, file));
  const original = globalThis.fetch, entry = f.catalog.targets[0], secret = 'unit-test-only-secret'; let tokenCalls = 0;
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input), headers = new Headers(init?.headers);
      assert.equal(init?.credentials, 'omit');
      if (url.startsWith(releaseApi)) {
        assert.equal(headers.get('Authorization'), `Bearer ${secret}`);
        if (url.endsWith('/tags/v0.6.0')) return Response.json(releaseMetadata(f.catalog));
        return new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/files/${url.endsWith('/1') ? 'exe' : 'notices'}` } });
      }
      assert.equal(headers.get('Authorization'), null, 'Credentials never reach the asset CDN.');
      assert.ok(url.startsWith('https://release-assets.githubusercontent.com/files/'));
      return new Response(await readFile(path.join(f.built, 'companion-go', entry.target, url.endsWith('/exe') ? 'StartReview.exe' : 'THIRD-PARTY-NOTICES.txt')));
    }) as typeof fetch;
    const result = await authorReview({ ...f.request, clientArtifact: path.join(local, 'OpenMarkdownReview.html'), companionTargets: [entry.target], companionToken: async () => { tokenCalls++; return secret; } });
    assert.equal(result.outcome, 'completed'); assert.equal(tokenCalls, 1);
    const evidence = JSON.stringify(await inspectReviewPackage(result.store));
    assert.ok(!evidence.includes(secret));
    for (const file of await readdir(path.join(result.store, 'events'))) assert.ok(!(await readFile(path.join(result.store, 'events', file), 'utf8')).includes(secret));
  } finally { globalThis.fetch = original; }
});

test('enterprise release identity, asset scope, duplicates, authentication and hostile redirects fail closed', async () => {
  const f = await fixture(), original = globalThis.fetch, entry = f.catalog.targets[0], signal = AbortSignal.timeout(10000);
  try {
    for (const value of [
      { ...releaseMetadata(f.catalog), tag_name: 'v0.5.6' },
      { ...releaseMetadata(f.catalog), draft: true },
      { ...releaseMetadata(f.catalog), prerelease: true },
      { ...releaseMetadata(f.catalog), html_url: 'https://example.com/release' },
      { ...releaseMetadata(f.catalog), assets: [{ name: entry.executable.filename, size: entry.executable.byteLength, url: 'https://example.com/runtime' }] },
      { ...releaseMetadata(f.catalog), assets: [releaseMetadata(f.catalog).assets[0], releaseMetadata(f.catalog).assets[0]] },
      { ...releaseMetadata(f.catalog), assets: [{ ...releaseMetadata(f.catalog).assets[0], size: 1 }] },
    ]) {
      globalThis.fetch = (async () => Response.json(value)) as typeof fetch;
      await assert.rejects(companionReleaseResolver(async () => undefined)('0.6.0', entry.executable.filename, entry.executable.byteLength, signal), /identity|asset/);
    }
    for (const status of [401, 403, 404]) {
      globalThis.fetch = (async () => new Response(null, { status })) as typeof fetch;
      await assert.rejects(companionReleaseResolver(async () => undefined)('0.6.0', entry.executable.filename, entry.executable.byteLength, signal), /authentication/);
    }
    globalThis.fetch = (async () => new Response('x'.repeat(1024 * 1024 + 1))) as typeof fetch;
    await assert.rejects(companionReleaseResolver(async () => undefined)('0.6.0', entry.executable.filename, entry.executable.byteLength, signal), /limit/);
    const local = path.join(f.temporary, 'hostile-client'); await mkdir(local);
    for (const file of ['OpenMarkdownReview.html', 'companion-core.js', 'companion-catalog.json']) await copyFile(path.join(f.built, file), path.join(local, file));
    for (const redirect of ['https://attacker.example/runtime', 'http://release-assets.githubusercontent.com/files/exe', 'https://github.com:444/files/exe', 'https://user:pass@release-assets.githubusercontent.com/files/exe']) {
      let calls = 0;
      globalThis.fetch = (async (input: string | URL | Request) => { calls++; return String(input).endsWith('/tags/v0.6.0') ? Response.json(releaseMetadata(f.catalog)) : new Response(null, { status: 302, headers: { location: redirect } }); }) as typeof fetch;
      await assert.rejects(prepareCompanions({ targets: [entry.target], artifact: path.join(local, 'OpenMarkdownReview.html'), journalRoot: f.request.journalRoot, companionToken: async () => 'not-forwarded' }), /Unexpected companion download host/);
      assert.equal(calls, 2, 'Disallowed redirect is rejected before any network request.');
    }
  } finally { globalThis.fetch = original; }
});
