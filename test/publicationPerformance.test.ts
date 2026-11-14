import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { actor, findingFixture } from './findingPublication.fixture';
import { authorReview } from '../src/professional/authoring';
import { ReviewSession } from '../src/professional/session';
import { NativeStorage } from '../src/professional/nativeStorage';
import { decode } from '../src/professional/bytes';

test('50-document publication bounds source I/O, avoids duplicate history loads, reports phases and retries exactly', { timeout: 120000 }, async t => {
  const f = await findingFixture();
  await Promise.all(Array.from({ length: 48 }, (_, i) => writeFile(path.join(f.source, `chapter-${i}.md`), `# Chapter ${i}\n\nFrozen chapter.\n`)));
  await authorReview({ source: f.source, store: f.root, rootDocument: 'a.md', actor, parents: [f.origin], operationId: 'expanded_scope', journalRoot: f.journalRoot, clientArtifact: f.created.browserClientPath, preserveClient: true });
  await writeFile(path.join(f.source, 'a.md'), '# Updated design\n\nThe complete correction.\n');
  const authority = new ReviewSession(f.store); await authority.open(); await authority.pin(f.origin);
  const preview = await f.publisher.prepareGuided(f.origin, actor, undefined, undefined, undefined, undefined, authority);
  assert.ok(!('kind' in preview)); if ('kind' in preview) return;
  const read = NativeStorage.prototype.read, open = ReviewSession.prototype.open;
  let scans = 0, active = 0, peak = 0, reads = 0;
  const progress: string[] = [], started = performance.now();
  NativeStorage.prototype.read = async function (file, limit) {
    if (this.identity !== f.source || !file.endsWith('.md')) return read.call(this, file, limit);
    active++; reads++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 8)); return await read.call(this, file, limit); }
    finally { active--; }
  };
  ReviewSession.prototype.open = async function () { if (this.storage.identity === f.store.identity) scans++; return open.call(this); };
  try {
    const result = await f.publisher.finish(preview.operationId, actor, [{ threadId: 'finding_0' }, { threadId: 'finding_1' }], undefined, f.origin, message => progress.push(message));
    assert.ok(result.records.every(record => record.saved));
    assert.equal(scans, 3, 'Initial, fresh pre-publication authority and authoring evidence scans only; draft and post-publication state reuse one request-local session.');
    assert.equal(reads, 50, 'Each saved source is rechecked exactly once at the final boundary.');
    assert.equal(peak, 4, 'Bounded parallel source checks avoid serial shared-drive latency and unbounded bursts.');
    assert.ok(progress.some(message => message.includes('(50/50)')));
    assert.ok(progress.some(message => message.startsWith('Verifying and publishing captured files (')));
    assert.match(progress.at(-1)!, /2\/2 selected fixes recorded/);
    assert.equal(active, 0, 'No worker is left running after success.');
    const events = (await f.store.list('events')).sort();
    await f.publisher.finish(preview.operationId, actor, [{ threadId: 'finding_0' }, { threadId: 'finding_1' }]);
    assert.deepEqual((await f.store.list('events')).sort(), events);
    const completed = new ReviewSession(f.store); await completed.open();
    assert.equal(completed.revisions.get(result.revisionId)!.documents.length, 50);
    const document = completed.revisions.get(result.revisionId)!.documents.find(doc => doc.path === 'a.md')!;
    assert.match(decode(await completed.content(document)), /complete correction/);
    t.diagnostic(`50 documents with 8ms injected source-read latency: ${Math.round(performance.now() - started)}ms including verification and retry; ${reads} source reads, peak concurrency ${peak}.`);
  } finally { NativeStorage.prototype.read = read; ReviewSession.prototype.open = open; }
});

test('request-local verification cannot cross packages, and failed parallel rechecks drain before returning', async () => {
  const f = await findingFixture(), other = await findingFixture();
  await writeFile(path.join(f.source, 'a.md'), '# Saved correction\n');
  await assert.rejects(f.publisher.prepareGuided(f.origin, actor, undefined, undefined, undefined, undefined, other.session), /another review or snapshot/);
  const preview = await f.publisher.prepare(f.origin, actor);
  await assert.rejects(f.publisher.finish(preview.operationId, actor, [], undefined, f.origin, undefined, other.session), /another review or snapshot/);
  const events = (await f.store.list('events')).sort();
  await writeFile(path.join(f.source, 'b.md'), '# Changed AFTER confirmation\n');
  const read = NativeStorage.prototype.read; let active = 0;
  NativeStorage.prototype.read = async function (file, limit) {
    if (this.identity !== f.source) return read.call(this, file, limit);
    active++;
    try { if (file === 'a.md') await new Promise(resolve => setTimeout(resolve, 30)); return await read.call(this, file, limit); }
    finally { active--; }
  };
  try {
    await assert.rejects(f.publisher.finish(preview.operationId, actor, []), /Source changed after/);
    assert.equal(active, 0);
    assert.deepEqual((await f.store.list('events')).sort(), events);
    assert.equal((await f.store.list('revisions')).length, 1);
  } finally { NativeStorage.prototype.read = read; }
});
