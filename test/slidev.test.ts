import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectSlidev, importedPath, parseSlidev, redactNotes } from '../src/professional/profiles/slidevSource';
import { digest, encode, jsonBytes, pointAt, stableId } from '../src/professional/bytes';
import { SlidevProfile, SLIDEV_ID, SLIDEV_SCHEMA_BYTES, slidevDeclaration, slideIdentity, validateSlidev, loadSlidev } from '../src/professional/profiles/slidev';
import { sourceView, renderSlide } from '../src/professional/profiles/slidevView';
import { runCli } from '../src/professional/cli';
import { Revision, CAPABILITIES, Manifest } from '../src/professional/types';
import { validate, validateAnchorEvent } from '../src/professional/validation';
import { loadProfiles } from '../src/professional/profiles/registry';
import { captureSlidev } from '../src/professional/profiles/slidevCapture';

test('published Slidev schema bytes exactly match the retained schema evidence', async () => {
  assert.equal(digest(await readFile('protocol/profiles/slidev/v1.schema.json')), digest(SLIDEV_SCHEMA_BYTES));
});

test('Slidev parser preserves CRLF/emoji offsets, fences, frontmatter and trailing notes', () => {
  const source = '---\r\ntheme: default\r\nbackground: /cover.svg\r\n---\r\n# Deck 😀\r\n\r\n```md\r\n---\r\n```\r\n\r\n<!-- private 😀\r\n--- not a slide\r\n-->\r\n\r\n---\r\n\r\n# Last\r\n';
  const parsed = parseSlidev(source, 'slides.md');
  assert.equal(parsed.length, 2); assert.equal(parsed[0].title, 'Deck 😀');
  assert.ok(source.slice(parsed[0].contentRange.start, parsed[0].contentRange.end).startsWith('# Deck 😀'));
  assert.deepEqual(parsed[0].images, ['/cover.svg']);
  const redacted = redactNotes(source, parsed); assert.equal(redacted.length, source.length); assert.equal(redacted.split('\n').length, source.split('\n').length);
  assert.ok(!redacted.includes('private')); assert.equal(redacted.slice(parsed[1].contentRange.start), source.slice(parsed[1].contentRange.start));
  assert.throws(() => parseSlidev('---\ntheme: a\ntheme: b\n---\n# X', 'x.md'), /YAML/);
  assert.throws(() => parseSlidev('---\nx: &a [one]\ny: *a\n---\n# X', 'x.md'));
  assert.throws(() => parseSlidev('---\naddons: [unsafe]\n---\n# X', 'x.md'), /preparsers/);
});

test('Slidev imports expand deterministically with ranges and occurrence-specific identities', async () => {
  const files = new Map([
    ['slides.md', '# Title\n\n---\nsrc: ./pages/details.md#2,3\n---\n\n---\nsrc: ./pages/details.md#2\n---\n'],
    ['pages/details.md', '# One\n\n---\n\n# Two\n\n---\n\n# Three\n']
  ]);
  const closure = await collectSlidev('slides.md', async p => { assert.ok(files.has(p), p); return files.get(p)!; });
  assert.deepEqual(closure.slides.map(s => s.title), ['Title', 'Two', 'Three', 'Two']);
  assert.equal(closure.documents.size, 2); assert.notEqual(closure.slides[1].id, closure.slides[3].id);
  assert.deepEqual(closure.slides[1].range, closure.slides[3].range);
  for (const ref of ['../../secret.md', 'https://example.com/a.md', '/a.md', 'C:\\a.md', '../%2e%2e/a.md', './a.md#1#2']) assert.throws(() => importedPath('slides.md', ref));
  assert.deepEqual(importedPath('pages/a.md', '../b.md#1-3'), { document: 'b.md', range: '1-3' });
  await assert.rejects(collectSlidev('a.md', async () => '---\nsrc: ./a.md\n---\n'), /Cyclic/);
  files.set('slides.md', '---\nsrc: ./pages/details.md#99\n---\n');
  await assert.rejects(collectSlidev('slides.md', async p => files.get(p)!), /outside/);
});

function profileFixture() {
  const source = '# Slide 😀\n\nVisible text.\n', document = 'slides.md', bytes = new Map<string, Uint8Array>();
  const stored = (data: Uint8Array, mediaType: string) => { const hash = digest(data), blobPath = `blobs/sha256/${hash.slice(7, 9)}/${hash.slice(7)}`; bytes.set(blobPath, data); return { digest: hash, blobPath, mediaType, byteLength: data.length }; };
  const png = new Uint8Array(24); png.set(encode('PNG'), 1); png.set(encode('IHDR'), 12); const view = new DataView(png.buffer); view.setUint32(16, 980); view.setUint32(20, 552);
  const id = slideIdentity(document, [0]), reference = `${SLIDEV_ID}:preview:${id}`, previewResourceId = stableId('resource', `${document}\0${reference}`);
  const revision = { rootDocument: document, documents: [{ path: document, ...stored(encode(source), 'text/markdown') }], resources: [{ id: previewResourceId, document, originalReference: reference, role: 'image', ...stored(png, 'image/png') }] } as Revision;
  const profile: SlidevProfile = { profile: SLIDEV_ID, parserVersion: '52.19.1', rendererVersion: '52.19.1', entryDocument: document, notes: 'included', capture: 'slidev-png-static', limitations: [], slides: [{ id, number: 1, title: 'Slide 😀', document, documentDigest: digest(source), sourceIndex: 0, occurrence: [0], range: { start: 0, end: source.length }, contentRange: { start: 0, end: source.length - 1 }, previewResourceId }] };
  for (const [ref, data] of [[SLIDEV_ID, jsonBytes(profile)], [slidevDeclaration().schemaUri, SLIDEV_SCHEMA_BYTES]] as const) revision.resources.push({ id: stableId('resource', `${document}\0${ref}`), document, originalReference: ref, role: 'attachment', sourceKind: 'data', capturedAt: new Date().toISOString(), ...stored(data, 'application/json') });
  const manifest = { capabilities: [...CAPABILITIES, 'presentation-profiles-v1'], requiredCapabilities: [...CAPABILITIES, 'presentation-profiles-v1'], extensions: [slidevDeclaration()] } as Manifest;
  return { source, document, profile, revision, manifest, sources: new Map([[document, source]]), read: async (c: { blobPath: string }) => bytes.get(c.blobPath)! };
}

test('Slidev schema, source/digest ownership and capability negotiation fail closed', async () => {
  const f = profileFixture(); assert.equal((await loadSlidev(f.manifest, f.revision, f.sources, f.read))?.slides.length, 1);
  const change = (mutate: (p: SlidevProfile) => void) => { const p = structuredClone(f.profile); mutate(p); assert.throws(() => validateSlidev(p, f.revision, f.sources)); };
  change(p => p.slides[0].number = 2); change(p => p.slides[0].id = 'forged'); change(p => p.slides[0].previewResourceId = 'missing');
  change(p => p.slides[0].range.end = 999); change(p => p.slides[0].documentDigest = digest('wrong'));
  const oldId = f.revision.resources[0].id; f.revision.resources[0].id = 'forged_image';
  change(p => p.slides[0].previewResourceId = 'forged_image'); f.revision.resources[0].id = oldId;
  change(p => p.slides.push(p.slides[0])); change(p => (p as unknown as Record<string, unknown>).code = '<script>');
  const wrong = structuredClone(f.manifest); wrong.requiredCapabilities = [...CAPABILITIES]; await assert.rejects(loadSlidev(wrong, f.revision, f.sources, f.read), /requires/);
  const forged = structuredClone(f.profile); forged.slides[0].title = 'Not the frozen title';
  await assert.rejects(loadSlidev(f.manifest, f.revision, f.sources, async c => c.blobPath === f.revision.resources.find(r => r.originalReference === SLIDEV_ID)!.blobPath ? jsonBytes(forged) : f.read(c)), /frozen source mapping/);
  wrong.requiredCapabilities.push('presentation-profiles-v1'); wrong.extensions![0].schemaDigest = digest('wrong'); await assert.rejects(loadSlidev(wrong, f.revision, f.sources, f.read), /schema/);
  wrong.extensions![0].id = 'urn:unknown:profile'; await assert.rejects(loadProfiles(wrong, f.revision, f.sources, f.read), /cannot interpret/);
  f.revision.resources = f.revision.resources.filter(r => r.originalReference !== slidevDeclaration().schemaUri); await assert.rejects(loadSlidev(f.manifest, f.revision, f.sources, f.read), /schema evidence/);
});

test('trusted Slidev subprocess failure and cancellation return without publishing output', { timeout: 10000 }, async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'omr-slidev-process-')), journalRoot = path.join(source, 'journal'), bin = path.join(source, 'node_modules/@slidev/cli/bin');
  await mkdir(bin, { recursive: true }); await mkdir(journalRoot); await writeFile(path.join(source, 'slides.md'), '# Source\n');
  await writeFile(path.join(bin, '../package.json'), JSON.stringify({ name: '@slidev/cli', version: '52.19.1', bin: { slidev: 'bin/slidev.mjs' } }));
  const base = { source, entry: 'slides.md', journalRoot, options: { trustProject: true, notes: 'included' as const }, sources: new Map([['slides.md', '# Source\n']]), count: 1 };
  await writeFile(path.join(bin, 'slidev.mjs'), 'process.stderr.write("fixture render failed"); process.exitCode = 4;');
  await assert.rejects(captureSlidev(base), /fixture render failed/);
  await writeFile(path.join(bin, 'slidev.mjs'), 'setInterval(() => {}, 100);');
  const controller = new AbortController();
  await assert.rejects(captureSlidev({ ...base, signal: controller.signal, progress: message => { if (message.startsWith('Rendering frozen')) setTimeout(() => controller.abort(), 50); } }), /cancelled/);
  await assert.rejects(captureSlidev({ ...base, options: { ...base.options, trustProject: false } }), /trust/);
  await writeFile(path.join(source, 'slides.md'), '# Changed\n');
  await assert.rejects(captureSlidev(base), /source changed/);
});

test('Slidev shared view escapes project HTML and maps exact source offsets', () => {
  const f = profileFixture(), source = '<script>alert(1)</script>\n# Slide 😀\n';
  const rendered = sourceView(source, 0, source.length);
  assert.ok(!rendered.html.includes('<script>')); assert.match(rendered.html, /&lt;script&gt;/);
  assert.deepEqual(rendered.textMaps.get('slide-source-0'), Array.from({ length: source.indexOf('\n') + 2 }, (_, i) => i));
  assert.match(renderSlide(f.profile, f.profile.slides[0], f.source).html, /data-resource-id=/);
  assert.match(renderSlide(f.profile, f.profile.slides[0], f.source).html, /notes included/);
  const windows = sourceView('abc\r\ndef\r\n');
  assert.deepEqual(windows.textMaps.get('slide-source-0'), [0, 1, 2, 3, 5]);
  assert.deepEqual(windows.textMaps.get('slide-source-1'), [5, 6, 7, 8, 10]);
});

test('Slidev CLI dry run captures no runtime, files, network or journal and rejects missing consent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omr-slidev-plan-')), source = path.join(root, 'source'); await mkdir(source);
  await writeFile(path.join(source, 'slides.md'), '# Root\n\n---\nsrc: ./import.md\n---\n'); await writeFile(path.join(source, 'import.md'), '# Imported\n');
  const args = ['review', 'create', '--source', source, '--store', path.join(root, 'review'), '--root-document', 'slides.md', '--include', 'slides.md', '--actor-id', 'test', '--profile', 'slidev-v1', '--notes', 'exclude'];
  const plan = await runCli([...args, '--dry-run']); assert.equal(plan.exitCode, 0, JSON.stringify(plan.result)); assert.deepEqual((plan.result as { documentPaths: string[] }).documentPaths, ['slides.md', 'import.md']);
  assert.deepEqual(await readdir(root), ['source']);
  const denied = await runCli([...args, '--operation-id', 'denied']); assert.equal(denied.exitCode, 4); assert.deepEqual(await readdir(root), ['source']);
  const bad = await runCli([...args, '--notes', 'include', '--dry-run']); assert.equal(bad.exitCode, 2);
});
