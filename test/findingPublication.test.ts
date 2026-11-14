import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { authorReview } from '../src/professional/authoring';
import { FindingPublisher } from '../src/professional/findingPublication';
import { ReviewSession } from '../src/professional/session';
import { NativeStorage } from '../src/professional/nativeStorage';
import { decode, digest } from '../src/professional/bytes';
import { fold, threadWorkflowQueue } from '../src/professional/state';
import { createCompanionRpc } from '../src/professional/companionRpc';
import { ProtocolError } from '../src/professional/types';

import { actor, findingFixture, rewrite } from './findingPublication.fixture';

test('omitted and blank implementation notes retain factual evidence; closing discussion preserves the fix', async () => {
  const f = await findingFixture(); await rewrite(f.source);
  const context = f.session.context(actor), thread = fold(f.session.events, f.origin).threads[0];
  await f.session.save(context, f.session.makeEvent(context, { type: 'thread.reopened', threadId: thread.root.threadId, reason: 'Continue discussion.', statusPredecessors: thread.status.heads.map(e => e.id) }));
  const preview = await f.publisher.prepare(f.origin, actor), selections = [{ threadId: 'finding_0' }, { threadId: 'finding_1', summary: '   ' }];
  await f.publisher.finish(preview.operationId, actor, selections); await f.session.refresh();
  const implemented = fold(f.session.events, f.origin).threads[0];
  assert.equal(implemented.open, true); assert.equal(threadWorkflowQueue(implemented), 'implemented');
  for (const finding of fold(f.session.events, f.origin).threads) assert.equal(finding.addressed!.summary, `Implementation recorded in published snapshot ${preview.revisionId} for ${finding.root.anchor.document}.`);
  const addressed = implemented.addressed!.id, before = f.session.events.length;
  await f.session.save(context, f.session.makeEvent(context, { type: 'thread.resolved', threadId: implemented.root.threadId, statusPredecessors: implemented.status.heads.map(e => e.id) }));
  const closed = fold(f.session.events, f.origin).threads[0];
  assert.equal(closed.open, false); assert.equal(closed.addressed!.id, addressed); assert.equal(threadWorkflowQueue(closed), 'implemented');
  assert.equal(f.session.events.length, before + 1);
  assert.equal(f.session.events.filter(e => e.type === 'thread.verification.recorded').length, 0);
  await f.publisher.finish(preview.operationId, actor, selections);
  await assert.rejects(f.publisher.finish(preview.operationId, actor, [{ threadId: 'finding_0', summary: '' }, selections[1]]), /original selected fixes/);
  await writeFile(path.join(f.source, 'b.md'), '# Another saved change\n');
  const next = await f.publisher.prepare(f.origin, actor);
  assert.ok(next.findings.every(finding => finding.workflow === 'implemented'));
  await assert.rejects(f.publisher.finish(next.operationId, actor, [{ threadId: 'finding_0' }]), /already implemented/);
});

test('comparison preparation reuses request-local verification and omits unchanged document text', async () => {
  const f = await findingFixture(); await rewrite(f.source);
  const first = await f.publisher.prepare(f.origin, actor);
  await f.publisher.finish(first.operationId, actor, [{ threadId: 'finding_0', summary: 'Initial implementation.' }]);
  await writeFile(path.join(f.source, 'b.md'), '# A later saved correction\n');
  const open = ReviewSession.prototype.open; let scans = 0;
  ReviewSession.prototype.open = async function () { if (this.storage.identity === f.store.identity) scans++; return open.call(this); };
  try {
    const authority = new ReviewSession(f.store); await authority.open(); await authority.pin(f.origin);
    assert.equal(await f.publisher.pending(f.origin, actor, authority), undefined);
    const next = await f.publisher.prepare(f.origin, actor);
    assert.equal(scans, 3, 'One authority, one preparation and one authoring verification; no repeated pending/read/result history scans.');
    assert.deepEqual(next.documents.find(d => d.path === 'a.md') && { before: next.documents[0].before, after: next.documents[0].after, changed: next.documents[0].changed }, { before: '', after: '', changed: false });
    assert.ok(next.documents.find(d => d.path === 'b.md')!.after.includes('later saved correction'));
    assert.equal((await readdir(path.join(f.root, 'revisions'))).length, 2, 'Preparation is not publication.');
  } finally { ReviewSession.prototype.open = open; }
});
test('preparation cancellation and cross-package snapshot reuse cannot publish or bypass authority', async () => {
  const f = await findingFixture(), other = await findingFixture(); await rewrite(f.source);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.publisher.prepare(f.origin, actor, undefined, undefined, { signal: controller.signal }), (e: unknown) => e instanceof ProtocolError && e.code === 'cancelled');
  await assert.rejects(f.publisher.pending(f.origin, actor, other.session), /another review or snapshot/);
  assert.equal((await readdir(path.join(f.root, 'revisions'))).length, 1);
  assert.equal((await readdir(path.join(f.root, 'events'))).length, 7);
});

test('whole-document and multi-document publication preserves original findings, clients and immutable evidence', async () => {
  const f = await findingFixture(), manifest = await readFile(path.join(f.root, 'manifest.json')), html = await readFile(f.created.browserClientPath);
  const oldEvents = new Map(await Promise.all((await readdir(path.join(f.root, 'events'))).map(async p => [p, await readFile(path.join(f.root, 'events', p))] as const)));
  await rewrite(f.source);
  const preview = await f.publisher.prepare(f.origin, actor);
  await f.store.journalPut(`native-finding:${preview.operationId}`, { path: 'private/finding-publication', bytes: new TextEncoder().encode('{}'), acknowledged: false });
  assert.equal(preview.documents.filter(d => d.changed).length, 2);
  assert.match(preview.documents[0].after, /completely rewritten/);
  assert.equal((await readdir(path.join(f.root, 'revisions'))).length, 1, 'Preparation is private, not a shared revision.');
  const result = await f.publisher.finish(preview.operationId, actor, [{ threadId: 'finding_0', summary: 'Rewrote both documents to explain the new design.' }]);
  assert.deepEqual(result.records.map(r => r.saved), [true]);
  await f.session.refresh();
  assert.equal(f.session.revision!.id, f.origin, 'The original finding context remains pinned.');
  const threads = fold(f.session.events, f.origin).threads;
  assert.equal(threads[0].open, false); assert.equal(threadWorkflowQueue(threads[0]), 'implemented');
  assert.equal(threads[1].addressed, undefined, 'Other findings in changed files are not silently marked addressed.');
  assert.equal(f.session.events.filter(e => e.type === 'review.approved' || e.type === 'review.completed').length, 0);
  assert.deepEqual(await readFile(f.root + '/manifest.json'), manifest);
  assert.deepEqual(await readFile(f.created.browserClientPath), html, 'Publication never attempts client installation or upgrades.');
  for (const [name, bytes] of oldEvents) assert.deepEqual(await readFile(path.join(f.root, 'events', name)), bytes);
  assert.equal(await f.publisher.pending(f.origin, actor), undefined, 'Completed operations do not trap subsequent work.');
  const before = (await readdir(path.join(f.root, 'events'))).length;
  await new FindingPublisher(f.options).finish(preview.operationId, actor, [{ threadId: 'finding_0', summary: 'Rewrote both documents to explain the new design.' }]);
  assert.equal((await readdir(path.join(f.root, 'events'))).length, before, 'Exact retries are idempotent across service instances.');
});

test('partial and lost-ack records retry exact bytes against the existing revision', async () => {
  const f = await findingFixture(); await rewrite(f.source); const preview = await f.publisher.prepare(f.origin, actor);
  const selections = [{ threadId: 'finding_0', summary: 'First document rewritten.' }, { threadId: 'finding_1', summary: 'Second document reorganized.' }];
  const write = NativeStorage.prototype.write;
  let injected = false;
  NativeStorage.prototype.write = async function(file, bytes, recover) {
    await write.call(this, file, bytes, recover);
    if (!injected && this.identity === f.store.identity && file.startsWith('events/') && JSON.parse(decode(bytes)).type === 'thread.addressed') { injected = true; throw new Error('Connection interrupted after write.'); }
  };
  let first;
  try { first = await f.publisher.finish(preview.operationId, actor, selections); }
  finally { NativeStorage.prototype.write = write; }
  assert.ok(injected); assert.equal(first.records.filter(r => !r.saved).length, 1);
  const events = (await readdir(path.join(f.root, 'events'))).sort();
  const resumed = new FindingPublisher(f.options), pending = await resumed.pending(f.origin, actor);
  // A lost acknowledgement may already be admitted on a fresh read. Either way
  // the original operation remains directly retryable with its exact bytes.
  if (pending) assert.deepEqual(pending.preparedSelections, selections);
  const result = await resumed.finish(preview.operationId, actor, selections);
  assert.ok(result.records.every(r => r.saved));
  assert.equal((await readdir(path.join(f.root, 'revisions'))).length, 2);
  assert.deepEqual((await readdir(path.join(f.root, 'events'))).sort(), events, 'No duplicate event is created for a lost acknowledgement.');
  await assert.rejects(resumed.finish(preview.operationId, actor, [{ ...selections[0], summary: 'Changed retry intent.' }]), /original selected fixes/);
});

test('ordinary participants and changed source/identity/heads cannot redirect a confirmed publication', async () => {
  const f = await findingFixture();
  await assert.rejects(f.publisher.prepare(f.origin, { id: 'reviewer@example.com' }), /initiator/);
  await assert.rejects(f.publisher.prepare(f.origin, actor), /Source is unchanged/);
  await rewrite(f.source); const preview = await f.publisher.prepare(f.origin, actor);
  await assert.rejects(f.publisher.finish(preview.operationId, { ...actor, displayName: 'Changed actor' }, []), /participant changed/);
  await writeFile(path.join(f.source, 'b.md'), '# Changed again\n');
  await assert.rejects(f.publisher.finish(preview.operationId, actor, [{ threadId: 'finding_0', summary: 'Update.' }]), /Source changed after/);
  assert.equal((await readdir(path.join(f.root, 'revisions'))).length, 1);
  await f.publisher.discard(f.origin, actor, preview.operationId);
  const next = await f.publisher.prepare(f.origin, actor);
  assert.notEqual(next.operationId, preview.operationId);
  await authorReview({ source: f.source, store: f.root, rootDocument: 'a.md', actor, operationId: 'concurrent_revision', clientArtifact: f.created.browserClientPath, journalRoot: f.journalRoot, parents: [f.origin], preserveClient: true });
  await assert.rejects(f.publisher.finish(next.operationId, actor, []), /Revision heads changed/);
});

test('decision changes and local resource edits after preparation require a fresh confirmation', async () => {
  const f = await findingFixture(); await rewrite(f.source);
  await writeFile(path.join(f.source, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>');
  await writeFile(path.join(f.source, 'b.md'), '# Other\n\n![Picture](image.svg)\n');
  const preview = await f.publisher.prepare(f.origin, actor);
  await writeFile(path.join(f.source, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"/>');
  await assert.rejects(f.publisher.finish(preview.operationId, actor, []), /local resource changed/);
  await f.publisher.discard(f.origin, actor, preview.operationId);
  const next = await f.publisher.prepare(f.origin, actor);
  const ctx = f.session.context(actor), thread = fold(f.session.events, f.origin).threads[0];
  await f.session.save(ctx, f.session.makeEvent(ctx, { type: 'thread.reopened', threadId: thread.root.threadId, reason: 'Reconsider', statusPredecessors: thread.status.heads.map(e => e.id) }));
  await f.session.save(ctx, f.session.makeEvent(ctx, { type: 'thread.decided', threadId: thread.root.threadId, decision: 'rejected', reason: 'Changed decision', decisionPredecessors: thread.decision.heads.map(e => e.id) }));
  await assert.rejects(f.publisher.finish(next.operationId, actor, [{ threadId: thread.root.threadId, summary: 'Not automatically retargeted.' }]), /decision changed/);
  assert.equal((await readdir(path.join(f.root, 'revisions'))).length, 1);
});

test('participant transports never expose native authoring, even through forged RPC', async () => {
  const f = await findingFixture();
  const rpc = createCompanionRpc({ store: f.store, hostStore: f.store, session: f.session, manifestDigest: digest(await readFile(path.join(f.root, 'manifest.json'))), codec: { toBase64: b => Buffer.from(b).toString('base64'), fromBase64: v => new Uint8Array(Buffer.from(v, 'base64')) }, binding: async () => {}, scheduleStop: () => {} });
  const info = await rpc('info', []) as { canAuthorFindings?: boolean };
  assert.equal(info.canAuthorFindings, undefined);
  for (const method of ['prepareFindingPublication','cancelFindingPreparation','finishFindingPublication','discardFindingPublication','retireFindingPublication','linkFindingSource','configureFindingRevision']) await assert.rejects(rpc(method, [f.origin, actor]), /Unknown|Unsupported|supported/);
});

test('a finding may be addressed by changes elsewhere in the complete published snapshot', async () => {
  const f = await findingFixture();
  await writeFile(path.join(f.source, 'b.md'), '# Supporting design\n\nThis chapter now supplies the missing complete explanation.\n');
  const preview = await f.publisher.prepare(f.origin, actor);
  assert.equal(preview.documents.find(d => d.path === 'a.md')!.changed, false);
  const result = await f.publisher.finish(preview.operationId, actor, [{ threadId: 'finding_0', summary: 'The missing explanation is supplied in the supporting chapter, not by changing the quoted sentence.' }]);
  assert.ok(result.records.every(r => r.saved)); await f.session.refresh();
  const event = f.session.events.find(e => e.type === 'thread.addressed');
  assert.ok(event?.type === 'thread.addressed'); assert.equal(event.sourceDigestBefore, event.sourceDigestAfter);
});

test('manual reconciliation can retire a blocked retry without deleting evidence or falsely implementing a finding', async () => {
  const f = await findingFixture(); await rewrite(f.source); const preview = await f.publisher.prepare(f.origin, actor);
  const write = NativeStorage.prototype.write;
  NativeStorage.prototype.write = async function(file, bytes, recover) {
    if (this.identity === f.store.identity && file.startsWith('events/') && JSON.parse(decode(bytes)).type === 'thread.addressed') throw new Error('Blocked finding record.');
    return write.call(this, file, bytes, recover);
  };
  try { assert.equal((await f.publisher.finish(preview.operationId, actor, [{ threadId: 'finding_0', summary: 'Prepared change.' }])).records[0].saved, false); }
  finally { NativeStorage.prototype.write = write; }
  const before = (await readdir(path.join(f.root, 'events'))).sort();
  await assert.rejects(f.publisher.discard(f.origin, actor, preview.operationId), /already published/);
  await f.publisher.retire(f.origin, actor, preview.operationId, 'Reconcile a changed decision manually before recording this published revision.');
  assert.equal(await f.publisher.pending(f.origin, actor), undefined);
  assert.deepEqual((await readdir(path.join(f.root, 'events'))).sort(), before);
  await f.session.refresh(); assert.equal(fold(f.session.events, f.origin).threads[0].addressed, undefined);
  assert.equal((await readdir(path.join(f.root, 'revisions'))).length, 2);
});


test('separate native processes reuse one confirmed event intent and one published revision', async () => {
  const f = await findingFixture(); await rewrite(f.source); const preview = await f.publisher.prepare(f.origin, actor);
  const selections = [{ threadId: 'finding_0', summary: 'One explicit implementation intent across windows.' }];
  const script = 'const {FindingPublisher}=require(process.argv[1]);const r=JSON.parse(process.argv[2]);new FindingPublisher(r.options).finish(r.operationId,r.actor,r.selections).then(()=>process.exit(0),e=>{console.error(e.message);process.exit(2)});';
  const { spawn } = await import('node:child_process');
  const launch = () => new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, path.resolve('out/src/professional/findingPublication.js'), JSON.stringify({ options: f.options, operationId: preview.operationId, actor, selections })], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.resume(); child.once('error', reject); child.once('close', resolve);
  });
  const exits = await Promise.all([launch(), launch()]);
  assert.ok(exits.some(code => code === 0), 'At least one confirmation should complete; a concurrent writer may need an exact retry.');
  const result = await f.publisher.finish(preview.operationId, actor, selections);
  assert.ok(result.records.every(r => r.saved)); await f.session.refresh();
  assert.equal(f.session.events.filter(e => e.type === 'thread.addressed').length, 1);
  assert.equal((await readdir(path.join(f.root, 'revisions'))).length, 2);
  assert.deepEqual(f.session.diagnostics.filter(d => d.severity === 'error'), []);
});
