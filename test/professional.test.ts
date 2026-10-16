import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, symlink, writeFile, readFile, readdir, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest, encode, jsonBytes, parseJson, pointAt, offsetAt, safePath, stableId, toBase64, fromBase64 } from '../src/professional/bytes';
import { CAPABILITIES, CREATOR_THREAD_CONTROL, Event, Manifest, Revision, ProtocolError, ProtocolVersion, REVIEWER_COMPLETION, REVIEWER_ROSTER, REVIEWER_INVITATIONS, SANITIZED_HTML_CAPABILITY, SANITIZED_HTML_PROFILE, THREAD_ADDRESSING, VERSION, LEGACY_VERSION } from '../src/professional/types';
import { effectiveReviewers, reviewerForInput, reviewerRoster } from '../src/professional/reviewer';
import { Storage, JournalEntry, IoLimiter, evidence, publish, publishBlob } from '../src/professional/storage';
import { NativeStorage } from '../src/professional/nativeStorage';
import { ReviewSession } from '../src/professional/session';
import { admit, fold, policyResult, reviewerProgress, threadWorkflowQueue } from '../src/professional/state';
import { caseFold, inspect, validate, validateAnchorEvent } from '../src/professional/validation';
import { authorReview, updateClient } from '../src/professional/authoring';
import { rasterDimensions } from '../src/professional/imageLimits';
import { renderDocument } from '../src/professional/rendering';
import { runCli } from '../src/professional/cli';
import { applyAcceptedSuggestion } from '../src/professional/applySuggestion';
import { mapWithConcurrency } from '../src/protocol/concurrency';
import { archiveFindingIndex } from '../src/professional/export';
import { inspectReviewPackage, inspectSourceBinding, relocateReviewPackage } from '../src/professional/relocation';
import { nextReviewStorageRoot, transientReviewLocation } from '../src/professional/locations';
import { findMarkdownFiles } from '../src/protocol/snapshot';

class MemoryStorage implements Storage {
  identity = 'memory'; writable = true; files = new Map<string, Uint8Array>(); journals = new Map<string, JournalEntry>();
  reads = new Map<string, number>(); failWrite = false; activeReads = 0; peakReads = 0;
  async read(path: string, limit: number) {
    this.reads.set(path, (this.reads.get(path) ?? 0) + 1);
    const bytes = this.files.get(path); if (!bytes) throw new ProtocolError('missing', path);
    if (bytes.length > limit) throw new ProtocolError('unsupported', path); return bytes.slice();
  }
  async list(path: string) { return [...this.files.keys()].filter(p => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/')).map(p => p.slice(path.length + 1)).sort(); }
  async write(path: string, bytes: Uint8Array) { this.files.set(path, this.failWrite ? bytes.slice(0, 3) : bytes.slice()); if (this.failWrite) throw new Error('disconnected'); }
  async journalGet(op: string) { return this.journals.get(op); }
  async journalPut(op: string, value: JournalEntry) { this.journals.set(op, value); }
}
const actor = { id: 'reviewer', displayName: 'Reviewer' };
const time = '2026-09-08T12:00:00.000Z';
test('shared toolbox embeds client version without publisher-specific package metadata', async () => {
  const html = await readFile(path.resolve('dist/OpenMarkdownReview.html'), 'utf8');
  const pkg = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
  assert.ok(html.includes(pkg.version));
  assert.equal(html.includes(pkg.repository.url), false, 'A shared toolbox must not embed distribution-specific repository URLs.');
  assert.equal(html.includes('package:marketplace:vsix'), false, 'Build scripts do not belong in the shared runtime.');
});
test('0.6 bounded binary recovery encoding round-trips across chunk and padding boundaries', () => {
  for (const length of [0, 1, 2, 3, 12287, 12288, 12289, 100000]) {
    const bytes = Uint8Array.from({ length }, (_, i) => i % 256), encoded = toBase64(bytes);
    assert.equal(encoded, Buffer.from(bytes).toString('base64')); assert.deepEqual(fromBase64(encoded), bytes);
  }
  for (const invalid of ['=', 'A', 'a===', 'ab=cd===', 'YW Jj']) assert.throws(() => fromBase64(invalid));
});
test('0.6 global I/O admission transfers slots fairly, including after failures', async () => {
  const limiter = new IoLimiter(4); let active = 0, peak = 0;
  const results = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => limiter.run(async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; if (i % 7 === 0) throw new Error('fault'); return i; })));
  assert.equal(peak, 4); assert.equal(active, 0); assert.equal(results.length, 40);
  assert.equal(await limiter.run(async () => 1), 1);
});
test('0.6 rejects excessive/truncated raster dimensions before browser allocation', () => {
  const png = new Uint8Array(24); png.set(encode('PNG'), 1); png.set(encode('IHDR'), 12);
  const view = new DataView(png.buffer); view.setUint32(16, 5000); view.setUint32(20, 5000);
  assert.deepEqual(rasterDimensions(png, 'image/png'), { width: 5000, height: 5000 });
  view.setUint32(20, 5001); assert.throws(() => rasterDimensions(png, 'image/png'), /before decoding/);
  assert.throws(() => rasterDimensions(png.slice(0, 20), 'image/png'));
  assert.throws(() => rasterDimensions(encode('GIF89a'), 'image/gif'));
});
test('0.6 failed parallel work drains started operations before returning', async () => {
  const completed: number[] = [];
  await assert.rejects(mapWithConcurrency([0, 1, 2, 3, 4], 2, async value => {
    if (value === 0) { await new Promise(resolve => setTimeout(resolve, 1)); throw new Error('failure'); }
    await new Promise(resolve => setTimeout(resolve, 20)); completed.push(value);
  }), /failure/);
  assert.deepEqual(completed, [1]);
});
async function fixture(version: ProtocolVersion = VERSION, emails?: string[]) {
  const storage = new MemoryStorage();
  const capabilities = [...CAPABILITIES, CREATOR_THREAD_CONTROL, ...(version === VERSION ? [THREAD_ADDRESSING, REVIEWER_COMPLETION, ...(emails ? [REVIEWER_ROSTER, REVIEWER_INVITATIONS] : [])] : [])];
  const manifest: Manifest = { protocol: 'open-markdown-review', protocolVersion: version, reviewId: 'review_one', title: 'Fixture', createdAt: time, createdBy: actor, documents: ['a.md'], eventDirectory: 'events', revisionDirectory: 'revisions', blobDirectory: 'blobs/sha256', exportDirectory: 'exports', eventLayout: 'sha256-flat-v1', identityProfile: 'self-asserted-v1', limitsProfile: 'pilot-v1', creationOperationId: 'create_one', capabilities, requiredCapabilities: capabilities, ...(emails ? { reviewers: reviewerRoster(emails) } : {}) };
  storage.files.set('manifest.json', jsonBytes(manifest));
  const document = await publishBlob(storage, 'document', encode('Hello repeated repeated.\r\n\n| A | B |\n| - | - |\n| x | y |\n'), 'text/markdown');
  const policy = await publishBlob(storage, 'policy', jsonBytes({ schemaVersion: version, kind: 'review-policy', mode: 'assertions-only' }), 'application/json');
  const revision: Revision = { schemaVersion: version, id: 'revision_one', reviewId: manifest.reviewId, createdAt: time, createdBy: actor, rootDocument: 'a.md', documents: [{ ...document, path: 'a.md' }], resources: [], externalReferences: [], mermaidDiagrams: [], diagnostics: [], renderer: { markdownProfile: 'commonmark-gfm', mermaidVersion: '11.10.1' }, parents: [], policy, creationOperationId: 'revision_op' };
  storage.files.set('revisions/revision_one.json', jsonBytes(revision));
  const publication: Event = { schemaVersion: version, id: 'publication', type: 'revision.created', reviewId: manifest.reviewId, revisionId: revision.id, revisionDigest: digest(jsonBytes(revision)), revisionPath: 'revisions/revision_one.json', occurredAt: time, actor, operationId: 'publish_op' };
  storage.files.set(`events/${digest(jsonBytes(publication)).slice(7)}.json`, jsonBytes(publication));
  const session = new ReviewSession(storage); await session.open(); return { storage, session, manifest, revision, publication };
}
test('0.6 exact parser rejects duplicate keys, malformed UTF-8, surrogate escapes, nonfinite numbers and BOM', () => {
  for (const value of ['{"a":1,"a":2}', '{"a":{"x":1,"\\u0078":2}}', '{"x":"\\ud800"}', '{"x":1e999}', '[]', '{"a":1,}', '{"a":01}', '\ufeff{}']) assert.throws(() => parseJson(encode(value)));
  assert.throws(() => parseJson(new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125])));
  assert.deepEqual(parseJson(encode('{ "emoji": "😀", "nested": [1, true, null] }')), { emoji: '😀', nested: [1, true, null] });
  assert.notEqual(digest(encode('{"a":1}')), digest(encode('{ "a": 1 }\n')));
});

test('0.6 email roster admits only listed stable IDs and the initiator in both writes and transported events', async () => {
  const { session, storage, manifest, revision } = await fixture(VERSION, ['alex@example.com', 'sam@example.com']);
  validate('manifest', manifest);
  assert.throws(() => validate('manifest', { ...manifest, reviewers: [...manifest.reviewers!, manifest.reviewers![0]] }), /canonical|unique/);
  assert.throws(() => validate('manifest', { ...manifest, reviewers: [{ ...manifest.reviewers![0], email: 'ALEX@example.com' }] }), /canonical/);
  assert.throws(() => validate('manifest', { ...manifest, requiredCapabilities: manifest.requiredCapabilities.filter(c => c !== REVIEWER_ROSTER) }), /declared together|invitations require an email roster/);
  const context = session.context({ id: ' ALEX@EXAMPLE.COM ', displayName: 'Alex' });
  assert.equal(context.actor.id, manifest.reviewers![0].id);
  const root = session.makeEvent(context, { type: 'comment.created', threadId: 'roster_thread', commentId: 'roster_comment', anchor: { document: 'a.md', documentDigest: revision.documents[0].digest, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, quote: { exact: 'Hello' }, target: { kind: 'text' } }, body: { format: 'markdown', text: 'Invited feedback.' } });
  assert.ok(root.type === 'comment.created');
  await session.save(context, root);
  const outsider = session.context({ id: 'outsider@example.com' }), forged = session.makeEvent(outsider, { type: 'comment.replied', threadId: root.threadId, commentId: 'outsider_reply', body: { format: 'markdown', text: 'Not invited.' } });
  const before = storage.files.size;
  await assert.rejects(session.save(outsider, forged), /reviewer email/); assert.equal(storage.files.size, before);
  const creator = session.context(actor);
  await session.save(creator, session.makeEvent(creator, { type: 'thread.decided', threadId: root.threadId, decision: 'accepted', decisionPredecessors: [] }));
  storage.files.set(`events/${digest(jsonBytes(forged)).slice(7)}.json`, jsonBytes(forged));
  await session.refresh(); assert.ok(session.diagnostics.some(d => /outside.*roster/.test(d.message)));
  assert.ok(!session.events.some(e => e.id === forged.id));
});

test('0.6 only the initiator can add reviewers; additions preserve manifest, prior completion and policy', async () => {
  const { session, storage, manifest, revision } = await fixture(VERSION, ['alex@example.com']);
  const before = storage.files.get('manifest.json')!.slice(), policy = await session.content(revision.policy);
  await finishParticipant(session, 'alex@example.com');
  await finishParticipant(session, actor.id);
  const nina = reviewerRoster(['nina@example.com'])[0], creator = session.context(actor);
  const invite = session.makeEvent(creator, { type: 'reviewer.invited', reviewer: nina });
  await session.save(creator, invite); await session.save(creator, invite);
  assert.equal(session.events.filter(e => e.type === 'reviewer.invited').length, 1);
  assert.deepEqual(storage.files.get('manifest.json'), before); assert.deepEqual(await session.content(revision.policy), policy);
  assert.equal(reviewerProgress(manifest, session.events, revision.id).find(r => r.id === nina.id)?.status, 'not-started');
  assert.equal(reviewerProgress(manifest, session.events, revision.id).find(r => r.email === 'alex@example.com')?.status, 'finished');
  const member = session.context({ id: 'NINA@EXAMPLE.COM' }); assert.equal(member.actor.id, nina.id);
  const denied = session.makeEvent(member, { type: 'reviewer.invited', reviewer: reviewerRoster(['outsider@example.com'])[0] });
  const count = storage.files.size; await assert.rejects(session.save(member, denied), /Only the review initiator/); assert.equal(storage.files.size, count);
  const finished = await finishParticipant(session, 'nina@example.com'); assert.equal(finished.reviewerInvitationId, invite.id);
  const receipt = parseJson<{ events: Array<{ eventId: string }> }>(await session.content('verification' in finished ? finished.verification : assert.fail()));
  assert.ok(receipt.events.some(e => e.eventId === invite.id));
  const reopened = new ReviewSession(storage); await reopened.open(); await reopened.audit(reopened.context(actor));
  assert.equal(reviewerForInput(reopened.manifest, { id: 'nina@example.com' }, reopened.events)?.id, nina.id);
  assert.deepEqual(reopened.diagnostics, []);
});

test('0.6 invitation membership is an explicit causal dependency, including out-of-order transport and forged invitations', async () => {
  const { session, storage, manifest, revision } = await fixture(VERSION, ['alex@example.com']);
  const creator = session.context(actor), nina = reviewerRoster(['nina@example.com'])[0];
  const invite = session.makeEvent(creator, { type: 'reviewer.invited', reviewer: nina });
  const context = session.context({ id: nina.id });
  const feedback = validate('event', { ...session.makeEvent(context, { type: 'comment.created', threadId: 'late_invite_thread', commentId: 'late_invite_comment', anchor: { document: 'a.md', documentDigest: revision.documents[0].digest, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, quote: { exact: 'Hello' }, target: { kind: 'text' } }, body: { format: 'markdown', text: 'A newly invited participant.' } }), reviewerInvitationId: invite.id });
  const put = (event: Event) => storage.files.set(`events/${digest(jsonBytes(event)).slice(7)}.json`, jsonBytes(event));
  put(feedback); await session.refresh(); assert.ok(!session.events.some(e => e.id === feedback.id));
  assert.ok(session.diagnostics.some(d => /invitation|roster|Missing dependency/.test(d.message)));
  put(invite); await session.refresh(); assert.ok(session.events.some(e => e.id === feedback.id)); assert.equal(session.diagnostics.length, 0);
  const noReference = { ...feedback, id: 'missing_invite_ref', operationId: 'missing_invite_ref', threadId: 'other_thread', commentId: 'other_comment', reviewerInvitationId: undefined };
  assert.ok(admit([...session.events, noReference as Event], session.revisions, new Map(), actor.id, actor.id, manifest).diagnostics.some(d => /invitation dependency/.test(d.message)));
  const wrongReference = { ...noReference, reviewerInvitationId: 'publication' } as Event;
  assert.ok(admit([...session.events, wrongReference], session.revisions, new Map(), actor.id, actor.id, manifest).diagnostics.some(d => /invitation dependency/.test(d.message)));
  const forged = { ...invite, id: 'forged_invitation', operationId: 'forged_invitation', actor: { id: manifest.reviewers![0].id }, reviewer: reviewerRoster(['outsider@example.com'])[0] };
  const dependent = { ...feedback, id: 'forged_dependant', operationId: 'forged_dependant', actor: { id: forged.reviewer.id }, reviewerInvitationId: forged.id, threadId: 'forged_thread', commentId: 'forged_comment' } as Event;
  put(forged); put(dependent); await session.refresh();
  assert.ok(!session.events.some(e => [forged.id, dependent.id].includes(e.id)));
  assert.ok(session.diagnostics.some(d => /initiator/.test(d.message)));
  assert.equal(reviewerForInput(manifest, { id: 'outsider@example.com' }, session.events), undefined);
  await assert.rejects(session.audit(session.context(actor)), /initiator|Invalid dependency|invitation/);
});

test('0.6 simultaneous invitations form an order-independent union and duplicate emails count once', async () => {
  const { session, manifest } = await fixture(VERSION, ['alex@example.com']);
  const context = session.context(actor), [nina, pat] = reviewerRoster(['nina@example.com', 'pat@example.com']);
  const first = session.makeEvent(context, { type: 'reviewer.invited', reviewer: nina });
  const duplicate = session.makeEvent(context, { type: 'reviewer.invited', reviewer: nina });
  const other = session.makeEvent(context, { type: 'reviewer.invited', reviewer: pat });
  const events = [...session.events, first, duplicate, other];
  const forward = admit(events, session.revisions, new Map(), actor.id, actor.id, manifest), backward = admit([...events].reverse(), session.revisions, new Map(), actor.id, actor.id, manifest);
  assert.deepEqual(forward.diagnostics, []); assert.deepEqual(backward.diagnostics, []);
  assert.deepEqual(effectiveReviewers(manifest, forward.events), effectiveReviewers(manifest, backward.events));
  assert.equal(effectiveReviewers(manifest, forward.events).length, 3);
  assert.equal(effectiveReviewers(manifest, forward.events).find(r => r.id === nina.id)?.invitationId, [first.id, duplicate.id].sort()[0]);
  const more = Array.from({ length: 125 }, (_, i) => session.makeEvent(context, { type: 'reviewer.invited', reviewer: reviewerRoster([`extra${i}@example.com`])[0] }));
  const expanded = admit([...events, ...more], session.revisions, new Map(), actor.id, actor.id, manifest);
  assert.deepEqual(expanded.diagnostics, []); assert.equal(reviewerProgress(manifest, expanded.events, context.revision.id).length, 128, 'The initial/batch limit does not impose a concurrency-sensitive cumulative roster cap.');
});

test('reviewer invitations reject missing capabilities, open/legacy reviews and noncanonical identities', async () => {
  const { session, manifest } = await fixture(VERSION, ['alex@example.com']);
  const context = session.context(actor), payload = { type: 'reviewer.invited' as const, reviewer: reviewerRoster(['nina@example.com'])[0] };
  const event = session.makeEvent(context, payload);
  assert.throws(() => validate('event', { ...event, reviewer: { ...payload.reviewer, email: 'NINA@example.com' } }), /canonical/);
  assert.throws(() => validate('event', { ...event, reviewer: { ...payload.reviewer, id: 'not_derived' } }), /derived/);
  const old = { ...manifest, capabilities: manifest.capabilities.filter(c => c !== REVIEWER_INVITATIONS), requiredCapabilities: manifest.requiredCapabilities.filter(c => c !== REVIEWER_INVITATIONS) };
  assert.ok(admit([...session.events, event], session.revisions, new Map(), actor.id, actor.id, old).diagnostics.some(d => /reviewer-invitations-v1/.test(d.message)));
  for (const mutation of [{ reviewId: 'another_review' }, { revisionId: 'unpublished_revision' }, { actor: { id: manifest.reviewers![0].id } }]) {
    const altered = { ...event, ...mutation } as Event;
    assert.ok(!admit([...session.events, altered], session.revisions, new Map(), actor.id, actor.id, manifest).events.some(e => e.id === event.id));
  }
  const { session: open } = await fixture();
  await assert.rejects(open.save(open.context(actor), open.makeEvent(open.context(actor), payload)), /initiator.*reviewer-invitations/);
  const { session: legacy } = await fixture(LEGACY_VERSION);
  assert.throws(() => legacy.makeEvent(legacy.context(actor), payload), /event:/);
});

test('0.6 invitations apply across revisions and audit receipts retain their exact authorization closure', async () => {
  const { session, storage, revision, publication, manifest } = await fixture(VERSION, ['alex@example.com']);
  const next = { ...revision, id: 'revision_two', parents: [revision.id], creationOperationId: 'next_revision' };
  const created = validate('event', { ...publication, id: 'publication_two', operationId: 'publication_two', revisionId: next.id, revisionPath: 'revisions/revision_two.json', revisionDigest: digest(jsonBytes(next)) });
  storage.files.set('revisions/revision_two.json', jsonBytes(next)); storage.files.set(`events/${digest(jsonBytes(created)).slice(7)}.json`, jsonBytes(created)); await session.refresh(); await session.pin(next.id);
  const creator = session.context(actor), nina = reviewerRoster(['nina@example.com'])[0], invite = session.makeEvent(creator, { type: 'reviewer.invited', reviewer: nina }); await session.save(creator, invite);
  await session.pin(revision.id);
  const finished = await finishParticipant(session, nina.email); assert.equal(finished.reviewerInvitationId, invite.id);
  await session.audit(session.context(actor));
  assert.equal(reviewerProgress(manifest, session.events, revision.id).find(r => r.id === nina.id)?.status, 'finished');
  assert.equal(reviewerProgress(manifest, session.events, next.id).find(r => r.id === nina.id)?.status, 'not-started');
  const receipt = parseJson<{ events: Array<{ eventId: string }> }>(await session.content('verification' in finished ? finished.verification : assert.fail()));
  const incomplete = { ...receipt, events: receipt.events.filter(e => e.eventId !== invite.id) };
  const verification = await publishBlob(storage, 'bad_membership_receipt', jsonBytes(incomplete), 'application/json');
  const invalid = { ...finished, id: 'omitted_invitation_receipt', operationId: 'omitted_invitation_receipt', verification } as Event;
  storage.files.set(`events/${digest(jsonBytes(invalid)).slice(7)}.json`, jsonBytes(invalid)); await session.refresh();
  assert.ok(session.diagnostics.some(d => /invitation authorization/.test(d.message)));
  assert.ok(!session.events.some(e => e.id === invalid.id));
});

async function finishParticipant(session: ReviewSession, id: string, note = 'Reviewed this revision.') {
  const context = session.context({ id }), audit = await session.audit(context), op = `finish_${crypto.randomUUID().replaceAll('-', '')}`;
  const verification = await session.verificationBlob(audit, op);
  const event = session.makeEvent(context, { type: 'review.completed', completionPredecessors: fold(audit.events, context.revision.id).register(`completion:${context.revision.id}:${context.actor.id}`).heads.map(e => e.id), verification, note }, op);
  await session.save(context, event); return event;
}
test('0.6 finish locks only that reviewer; reopening restores feedback and completion is independent of stance', async () => {
  const { session, storage, manifest, revision } = await fixture(VERSION, ['alex@example.com', 'sam@example.com']);
  const stale = new ReviewSession(storage); await stale.open();
  const context = stale.context({ id: 'alex@example.com' });
  const feedback = stale.makeEvent(context, { type: 'suggestion.created', suggestionId: 'after_finish', anchor: { document: 'a.md', documentDigest: revision.documents[0].digest, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, quote: { exact: 'Hello' }, target: { kind: 'text' } }, rationale: { format: 'markdown', text: 'Late draft.' }, operation: { kind: 'delete' } });
  assert.ok(feedback.type === 'suggestion.created');
  const finished = await finishParticipant(session, 'alex@example.com');
  assert.deepEqual(reviewerProgress(manifest, session.events, revision.id).map(r => r.status), ['finished', 'not-started']);
  assert.equal(fold(session.events, revision.id).stances.length, 0, 'Finishing never creates approval.');
  await session.save(session.context({ id: 'alex@example.com' }), finished); // Idempotent retry.
  await assert.rejects(stale.save(context, feedback), /Reopen your review|Reopen.*feedback/i);
  const other = session.context({ id: 'sam@example.com' });
  await session.save(other, session.makeEvent(other, { type: 'suggestion.created', suggestionId: 'other_feedback', anchor: feedback.anchor, rationale: { format: 'markdown', text: 'Another reviewer can continue.' }, operation: { kind: 'delete' } }));
  assert.deepEqual(reviewerProgress(manifest, session.events, revision.id).map(r => r.status), ['finished', 'in-progress']);
  const latest = session.context({ id: 'alex@example.com' });
  const reopened = session.makeEvent(latest, { type: 'review.reopened', completionPredecessors: [finished.id], note: 'One more concern.' });
  await session.save(latest, reopened);
  assert.equal(reviewerProgress(manifest, session.events, revision.id)[0].status, 'reopened');
  await session.save(latest, feedback);
  await finishParticipant(session, 'alex@example.com', 'Finished again.');
  assert.equal(reviewerProgress(manifest, session.events, revision.id)[0].completion.history.length, 3);
  assert.deepEqual(reviewerProgress(manifest, session.events, 'new_revision').map(r => r.status), ['not-started', 'not-started']);
  await finishParticipant(session, actor.id, 'Initiator also finished a personal review.');
  const completionRows = reviewerProgress(manifest, session.events, revision.id);
  assert.equal(completionRows.find(r => r.id === actor.id)?.status, 'finished', 'Initiator completion remains visible even when not in the invited roster.');
  assert.equal(completionRows.filter(r => r.email).length, 2, 'An extra initiator assertion does not change the invited-reviewer denominator.');
  assert.deepEqual(session.diagnostics, []);
  await session.audit(session.context(actor));
});

test('0.6 concurrent finish/reopen states are causal, actor-scoped and independent of arrival order', async () => {
  const { session, storage, manifest, revision } = await fixture(VERSION, ['alex@example.com', 'sam@example.com']);
  const branch = new MemoryStorage(); branch.files = new Map(storage.files);
  const peer = new ReviewSession(branch); await peer.open();
  const first = await finishParticipant(session, 'alex@example.com'), concurrent = await finishParticipant(peer, 'alex@example.com');
  const context = session.context({ id: 'alex@example.com' }), reopened = session.makeEvent(context, { type: 'review.reopened', completionPredecessors: [first.id] });
  await session.save(context, reopened);
  for (const [file, bytes] of branch.files) if (!storage.files.has(file)) storage.files.set(file, bytes);
  await session.refresh();
  const progress = reviewerProgress(manifest, session.events, revision.id)[0];
  assert.equal(progress.status, 'conflicted'); assert.deepEqual(progress.completion.heads.map(e => e.id).sort(), [concurrent.id, reopened.id].sort());
  const graph = (events: Event[]) => admit(events, session.revisions, new Map(), actor.id, actor.id, manifest);
  assert.deepEqual(graph([...session.events].reverse()), graph(session.events));
  const merged = session.makeEvent(context, { type: 'review.reopened', completionPredecessors: progress.completion.heads.map(e => e.id) });
  await session.save(context, merged);
  assert.equal(reviewerProgress(manifest, session.events, revision.id)[0].status, 'reopened');
  const sam = session.context({ id: 'sam@example.com' }), bad = session.makeEvent(sam, { type: 'review.reopened', completionPredecessors: [first.id] });
  assert.ok(graph([...session.events, bad]).diagnostics.some(d => /incompatible|same reviewer/.test(d.message)));
  assert.deepEqual(session.diagnostics, []);
});

test('completion requires its declared capability and a complete exact verification receipt', async () => {
  const missing = await fixture();
  const capabilities = missing.manifest.capabilities.filter(c => c !== REVIEWER_COMPLETION);
  const manifest = { ...missing.manifest, capabilities, requiredCapabilities: capabilities };
  missing.storage.files.set('manifest.json', jsonBytes(manifest));
  const session = new ReviewSession(missing.storage); await session.open();
  const context = session.context(actor), audit = await session.audit(context), verification = await session.verificationBlob(audit, 'unsupported_completion');
  const event = session.makeEvent(context, { type: 'review.completed', completionPredecessors: [], verification });
  await assert.rejects(session.save(context, event), /does not declare reviewer-completion/);
  missing.storage.files.set(`events/${digest(jsonBytes(event)).slice(7)}.json`, jsonBytes(event));
  await session.refresh(); assert.ok(session.diagnostics.some(d => /requires reviewer-completion/.test(d.message)));
  assert.ok(!session.events.some(e => e.id === event.id));
  const legacy = await fixture(LEGACY_VERSION);
  assert.throws(() => legacy.session.makeEvent(legacy.session.context(actor), { type: 'review.completed', completionPredecessors: [], verification }));

  const complete = await fixture(VERSION, ['alex@example.com']);
  const finished = await finishParticipant(complete.session, 'alex@example.com');
  assert.ok(finished.type === 'review.completed');
  const bytes = complete.storage.files.get(finished.verification.blobPath)!;
  complete.storage.files.set(finished.verification.blobPath, bytes.slice(0, bytes.length - 1));
  const received = new ReviewSession(complete.storage); await received.open();
  assert.ok(!received.events.some(e => e.id === finished.id));
  assert.ok(received.diagnostics.some(d => /Evidence digest mismatch/.test(d.message)));
  await assert.rejects(received.audit(received.context(actor)), /digest mismatch/);
});
test('0.6 safe paths and Unicode 15.1 full folding reject portable aliases', () => {
  for (const p of ['../escape', '/absolute', 'a\\b', 'C:drive', 'nul.txt', 'con', 'x/COM¹.dat', 'a.', 'a ', 'a//b', 'e\u0301.md']) assert.throws(() => safePath(p));
  assert.equal(safePath('Dökumente/file.md'), 'Dökumente/file.md');
  assert.equal(caseFold('Straße/Σςﬃ'), caseFold('STRASSE/σσffi'));
});
test('0.6 extension declarations are capability-bound and state-affecting extensions fail closed', async () => {
  const { manifest } = await fixture(), declaration = { id: 'urn:example:profile:1', schemaUri: 'urn:example:schema:1', schemaDigest: digest('schema'), schemaBlobPath: `blobs/sha256/${digest('schema').slice(7, 9)}/${digest('schema').slice(7)}`, affectsState: false };
  assert.throws(() => validate('manifest', { ...manifest, extensions: [declaration] }), /presentation-profiles-v1/);
  assert.throws(() => validate('manifest', { ...manifest, capabilities: [...manifest.capabilities, 'presentation-profiles-v1'], requiredCapabilities: [...manifest.requiredCapabilities, 'presentation-profiles-v1'] }), /requires an immutable extension/);
  assert.throws(() => validate('manifest', { ...manifest, capabilities: [...manifest.capabilities, 'presentation-profiles-v1'], requiredCapabilities: [...manifest.requiredCapabilities, 'presentation-profiles-v1'], extensions: [{ ...declaration, affectsState: true }] }), (error: unknown) => error instanceof ProtocolError && error.code === 'unsupported');
});
test('0.6 positions preserve CRLF, lone CR, emoji and reject split pairs', () => {
  const source = 'a\r\n😀b\rc';
  assert.deepEqual(pointAt(source, 6), { line: 1, character: 3 });
  assert.equal(offsetAt(source, { line: 2, character: 1 }), 8);
  assert.throws(() => offsetAt(source, { line: 1, character: 1 }));
  assert.throws(() => offsetAt(source, { line: 3, character: 0 }));
});
test('0.6 content publication retries exact partial bytes and rejects foreign partial files', async () => {
  const s = new MemoryStorage(), bytes = encode('publication'), f = evidence('events/item.json', bytes, 'application/json');
  s.failWrite = true; await assert.rejects(publish(s, 'op', f, bytes));
  assert.equal(s.journals.get('op')?.acknowledged, false);
  s.failWrite = false; await publish(s, 'op', f, bytes); await publish(s, 'op', f, bytes);
  assert.equal(s.journals.get('op')?.acknowledged, true);
  s.files.delete(f.path); await assert.rejects(publish(s, 'op', f, bytes), /acknowledged.*events\/item\.json/);
  const foreign = new MemoryStorage(); foreign.files.set(f.path, bytes.slice(0, 3));
  await assert.rejects(publish(foreign, 'foreign', f, bytes), /overwrite/);
});
test('0.6 session pins an immutable context and saves exact independent event files', async () => {
  const { session, storage, revision } = await fixture(); assert.equal(session.revision?.id, revision.id);
  const context = session.context(actor);
  const event = session.makeEvent(context, { type: 'comment.created', threadId: 'thread_one', commentId: 'comment_one', anchor: { document: 'a.md', documentDigest: revision.documents[0].digest, range: { start: { line: 0, character: 15 }, end: { line: 0, character: 23 } }, quote: { exact: 'repeated' }, target: { kind: 'text' } }, body: { format: 'markdown', text: 'Second occurrence.' } });
  await session.save(context, event);
  assert.equal(session.events.length, 2); assert.ok(storage.files.has(`events/${digest(jsonBytes(event)).slice(7)}.json`));
  assert.equal(fold(session.events, revision.id).threads.length, 1);
});
test('0.6 initiator-only decisions and closure lock a thread until an explicit reopen', async () => {
  const { session, revision } = await fixture(), creator = session.context(actor);
  const participant = session.context({ id: 'participant', displayName: 'Participant' });
  const threadId = 'locked_thread', commentId = 'locked_comment';
  const root = session.makeEvent(participant, { type: 'comment.created', threadId, commentId, anchor: { document: 'a.md', documentDigest: revision.documents[0].digest, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, quote: { exact: 'Hello' }, target: { kind: 'text' } }, body: { format: 'markdown', text: 'Please verify this.' } });
  await session.save(participant, root);
  const participantClose = session.makeEvent(participant, { type: 'thread.resolved', threadId, statusPredecessors: [] });
  await assert.rejects(session.save(participant, participantClose), (error: unknown) => error instanceof ProtocolError && error.code === 'permission');
  const participantDecision = session.makeEvent(participant, { type: 'thread.decided', threadId, decision: 'accepted', decisionPredecessors: [] });
  await assert.rejects(session.save(participant, participantDecision), (error: unknown) => error instanceof ProtocolError && error.code === 'permission');
  const accepted = session.makeEvent(creator, { type: 'thread.decided', threadId, decision: 'accepted', decisionPredecessors: [] });
  await session.save(creator, accepted);
  const closed = session.makeEvent(creator, { type: 'thread.resolved', threadId, note: 'Addressed', statusPredecessors: [] });
  await session.save(creator, closed);
  const closedState = fold(session.events, revision.id).threads[0];
  const decisionHead = closedState.decision.heads[0];
  assert.equal(decisionHead?.type, 'thread.decided'); if (decisionHead?.type === 'thread.decided') assert.equal(decisionHead.decision, 'accepted');
  assert.equal(closedState.open, false, 'A decision must not silently reopen the lifecycle register.');
  const reply = session.makeEvent(participant, { type: 'comment.replied', threadId, commentId: 'late_reply', inReplyTo: commentId, body: { format: 'markdown', text: 'Late reply' } });
  const participantLateDecision = session.makeEvent(participant, { type: 'thread.decided', threadId, decision: 'duplicate', reason: 'Late decision', decisionPredecessors: closedState.decision.heads.map(event => event.id) });
  const creatorLateDecision = session.makeEvent(creator, { type: 'thread.decided', threadId, decision: 'duplicate', reason: 'Late decision', decisionPredecessors: closedState.decision.heads.map(event => event.id) });
  await assert.rejects(session.save(participant, reply), (error: unknown) => error instanceof ProtocolError && error.code === 'changed');
  await assert.rejects(session.save(participant, participantLateDecision), (error: unknown) => error instanceof ProtocolError && error.code === 'permission');
  await assert.rejects(session.save(creator, creatorLateDecision), (error: unknown) => error instanceof ProtocolError && error.code === 'changed');
  await assert.rejects(session.save(creator, session.makeEvent(creator, { type: 'thread.resolved', threadId, statusPredecessors: [closed.id] })), /already closed/);
  const reopened = session.makeEvent(creator, { type: 'thread.reopened', threadId, reason: 'More discussion needed', statusPredecessors: [closed.id] });
  await session.save(creator, reopened); await session.save(participant, reply);
  const openState = fold(session.events, revision.id).threads[0];
  assert.equal(openState.open, true); assert.equal(openState.replies.at(-1)?.commentId, 'late_reply');
});
test('0.6 publication rejects an event whose actor differs from its pinned action context', async () => {
  const { session, revision } = await fixture(), context = session.context(actor);
  const event = session.makeEvent(context, { type: 'comment.created', threadId: 'actor_context_thread', commentId: 'actor_context_comment', anchor: { document: 'a.md', documentDigest: revision.documents[0].digest, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, quote: { exact: 'Hello' }, target: { kind: 'text' } }, body: { format: 'markdown', text: 'Actor binding.' } });
  await assert.rejects(session.save(context, { ...event, actor: { id: 'other' } }), /actor differs/);
  assert.equal(session.events.some(item => item.id === event.id), false);
});
test('0.6 creator workbench links an accepted finding to a descendant revision and reviewer verification', async () => {
  const { session, storage, manifest, revision } = await fixture(), creator = session.context(actor), reviewer = session.context({ id: 'independent-reviewer', displayName: 'Independent Reviewer' });
  const threadId = 'processing_thread';
  const root = session.makeEvent(reviewer, { type: 'comment.created', threadId, commentId: 'processing_comment', anchor: { document: 'a.md', documentDigest: revision.documents[0].digest, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } }, quote: { exact: 'repeated' }, target: { kind: 'text' } }, body: { format: 'markdown', text: 'Please clarify this term.' } });
  await session.save(reviewer, root);
  assert.equal(threadWorkflowQueue(fold(session.events, revision.id).threads[0]), 'needs-decision');
  const accepted = session.makeEvent(creator, { type: 'thread.decided', threadId, decision: 'accepted', decisionPredecessors: [] }); await session.save(creator, accepted);
  assert.equal(threadWorkflowQueue(fold(session.events, revision.id).threads[0]), 'accepted-not-implemented');

  const changedDocument = await publishBlob(storage, 'changed_document', encode('Hello precise repeated.\r\n\n| A | B |\n| - | - |\n| x | y |\n'), 'text/markdown');
  const target: Revision = { ...revision, id: 'revision_two', createdAt: '2026-09-08T13:00:00.000Z', parents: [revision.id], documents: [{ ...changedDocument, path: 'a.md' }], creationOperationId: 'revision_two_op' };
  storage.files.set('revisions/revision_two.json', jsonBytes(target));
  const publication: Event = { schemaVersion: manifest.protocolVersion, id: 'publication_two', type: 'revision.created', reviewId: manifest.reviewId, revisionId: target.id, revisionDigest: digest(jsonBytes(target)), revisionPath: 'revisions/revision_two.json', occurredAt: target.createdAt, actor, operationId: 'publication_two_op' };
  storage.files.set(`events/${digest(jsonBytes(publication)).slice(7)}.json`, jsonBytes(publication)); await session.refresh();

  const unauthorized = session.makeEvent(reviewer, { type: 'thread.addressed', threadId, toRevisionId: target.id, document: 'a.md', sourceDigestBefore: revision.documents[0].digest, sourceDigestAfter: target.documents[0].digest, summary: 'Clarified the term.', decisionIds: [accepted.id], addressingPredecessors: [] });
  await assert.rejects(session.save(reviewer, unauthorized), (error: unknown) => error instanceof ProtocolError && error.code === 'permission');
  const addressed = session.makeEvent(creator, { type: 'thread.addressed', threadId, toRevisionId: target.id, document: 'a.md', sourceDigestBefore: revision.documents[0].digest, sourceDigestAfter: target.documents[0].digest, summary: 'Clarified the term in the published Markdown.', decisionIds: [accepted.id], addressingPredecessors: [] });
  await session.save(creator, addressed);
  assert.equal(threadWorkflowQueue(fold(session.events, revision.id).threads[0]), 'awaiting-verification');
  assert.throws(() => validate('event', { ...addressed, schemaVersion: LEGACY_VERSION }), /event:/, 'A 0.5 event must not acquire 0.6 semantics.');
  const concurrentAddressing: Event = { ...addressed, id: 'addressed_parallel', operationId: 'addressed_parallel_op' };
  const concurrentGraph = admit([...session.events, concurrentAddressing], session.revisions, new Map(), actor.id, actor.id);
  assert.deepEqual(concurrentGraph.diagnostics, []);
  assert.equal(threadWorkflowQueue(fold(concurrentGraph.events, revision.id).threads[0]), 'conflict', 'Two exact addressing heads require an explicit merge because verification names one event.');
  const missingTargetPublication = admit(session.events.filter(event => event.id !== publication.id), session.revisions, new Map(), actor.id, actor.id);
  assert.match(missingTargetPublication.diagnostics.map(item => item.message).join('\n'), /published descendant|Missing dependency/, 'Addressing evidence is causally dependent on the target revision publication.');
  assert.throws(() => session.makeEvent(reviewer, { type: 'thread.verification.recorded', threadId, addressedEventId: addressed.id, verdict: 'challenged', verificationPredecessors: [] }), /requires a note/);
  const verified = session.makeEvent(reviewer, { type: 'thread.verification.recorded', threadId, addressedEventId: addressed.id, verdict: 'verified', note: 'Checked the published revision.', verificationPredecessors: [] });
  await session.save(reviewer, verified);
  const verifiedState = fold(session.events, revision.id).threads[0];
  assert.equal(verifiedState.addressed?.toRevisionId, target.id); assert.equal(threadWorkflowQueue(verifiedState), 'verified');
  const archive = archiveFindingIndex(session.events, revision.id, ['a.md']); assert.match(archive[0].status, /verified/);
});
test('0.6 offline archive finding references are deterministic and expose challenged-topic status', async () => {
  const { session, revision } = await fixture(), creator = session.context(actor);
  const comment = session.makeEvent(creator, { type: 'comment.created', threadId: 'archive_thread', commentId: 'archive_comment', anchor: { document: 'a.md', documentDigest: revision.documents[0].digest, range: { start: { line: 0, character: 15 }, end: { line: 0, character: 23 } }, quote: { exact: 'repeated' }, target: { kind: 'text' } }, body: { format: 'markdown', text: 'Challenge the second occurrence.' } });
  const suggestion = session.makeEvent(creator, { type: 'suggestion.created', suggestionId: 'archive_suggestion', anchor: { document: 'a.md', documentDigest: revision.documents[0].digest, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } }, quote: { exact: 'repeated' }, target: { kind: 'text' } }, rationale: { format: 'markdown', text: 'Use a precise term.' }, operation: { kind: 'replace', replacement: 'specific' } });
  const accepted = session.makeEvent(creator, { type: 'suggestion.accepted', suggestionId: 'archive_suggestion', decisionPredecessors: [] });
  const resolved = session.makeEvent(creator, { type: 'thread.resolved', threadId: 'archive_thread', note: 'Addressed', statusPredecessors: [] });
  const events = [...session.events, comment, suggestion, accepted, resolved];
  const expected = [
    { reference: 'F-001', kind: 'suggested-edit', subjectId: 'archive_suggestion', line: 1, character: 7, status: 'accepted' },
    { reference: 'F-002', kind: 'comment', subjectId: 'archive_thread', line: 1, character: 16, status: 'resolved' }
  ];
  const summarize = (input: Event[]) => archiveFindingIndex(input, revision.id, ['a.md']).map(({ reference, kind, subjectId, line, character, status }) => ({ reference, kind, subjectId, line, character, status }));
  assert.deepEqual(summarize(events), expected); assert.deepEqual(summarize([...events].reverse()), expected);
});
test('0.5 creator lifecycle capability rejects received non-creator transitions without reinterpreting older packages', async () => {
  const { session, storage, manifest, revision } = await fixture(LEGACY_VERSION), participant = session.context({ id: 'participant' });
  const threadId = 'received_thread';
  const root = session.makeEvent(participant, { type: 'comment.created', threadId, commentId: 'received_comment', anchor: { document: 'a.md', documentDigest: revision.documents[0].digest, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, quote: { exact: 'Hello' } }, body: { format: 'markdown', text: 'Received thread' } });
  await session.save(participant, root);
  const unauthorized = session.makeEvent(participant, { type: 'thread.resolved', threadId, statusPredecessors: [] });
  const unauthorizedDecision = session.makeEvent(participant, { type: 'thread.decided', threadId, decision: 'accepted', decisionPredecessors: [] });
  storage.files.set(`events/${digest(jsonBytes(unauthorized)).slice(7)}.json`, jsonBytes(unauthorized));
  storage.files.set(`events/${digest(jsonBytes(unauthorizedDecision)).slice(7)}.json`, jsonBytes(unauthorizedDecision));
  const strict = new ReviewSession(storage); await strict.open();
  assert.equal(strict.events.some(event => event.id === unauthorized.id || event.id === unauthorizedDecision.id), false); assert.match(strict.diagnostics.map(diagnostic => diagnostic.message).join('\n'), /declared review initiator/);
  const legacyManifest = validate('manifest', { ...manifest, capabilities: manifest.capabilities.filter(capability => capability !== CREATOR_THREAD_CONTROL), requiredCapabilities: manifest.requiredCapabilities.filter(capability => capability !== CREATOR_THREAD_CONTROL) });
  storage.files.set('manifest.json', jsonBytes(legacyManifest));
  const compatible = new ReviewSession(storage); await compatible.open();
  assert.equal(compatible.events.some(event => event.id === unauthorized.id), true); assert.equal(compatible.events.some(event => event.id === unauthorizedDecision.id), true); assert.equal(fold(compatible.events, revision.id).threads[0].open, false);
});
test('0.6 rejects a sanitized HTML capability/profile mismatch instead of changing rendering semantics', async () => {
  const { storage, manifest } = await fixture();
  storage.files.set('manifest.json', jsonBytes({ ...manifest, capabilities: [...manifest.capabilities, SANITIZED_HTML_CAPABILITY], requiredCapabilities: [...manifest.requiredCapabilities, SANITIZED_HTML_CAPABILITY] }));
  const received = new ReviewSession(storage); await received.open();
  assert.equal(received.revisions.size, 0);
  assert.match(received.diagnostics.map(diagnostic => diagnostic.message).join('\n'), /renderer profile and manifest sanitized HTML capability differ/);
});
test('0.6 full audit uses exact compact event bytes and fails closed after loss', async () => {
  const { session, storage, publication } = await fixture();
  const compact = encode(JSON.stringify(publication));
  storage.files.delete(`events/${digest(jsonBytes(publication)).slice(7)}.json`);
  storage.files.set(`events/${digest(compact).slice(7)}.json`, compact);
  const fresh = new ReviewSession(storage); await fresh.open();
  const audit = await fresh.audit(fresh.context(actor));
  assert.equal(audit.inventory.events[0].digest, digest(compact));
  storage.files.delete(`events/${digest(compact).slice(7)}.json`);
  await assert.rejects(fresh.audit(fresh.context(actor)), /disappeared/);
});
test('0.6 partial revision admission defers documents and retries them without any new event filename', async () => {
  const { storage, revision } = await fixture(); const key = revision.documents[0].blobPath, bytes = storage.files.get(key)!;
  storage.reads.clear();
  storage.files.delete(key); const session = new ReviewSession(storage); await session.open();
  assert.equal(session.revisions.size, 1); assert.equal(session.revision?.id, revision.id); assert.equal(session.diagnostics.length, 0);
  assert.equal(storage.reads.has(key), false, 'Cold open does not read unrendered Markdown or every frozen resource.');
  await assert.rejects(
    session.content(revision.documents[0]),
    (error: unknown) => error instanceof ProtocolError && error.code === 'missing'
  );
  storage.files.set(key, bytes); assert.deepEqual(await session.content(revision.documents[0]), bytes);
  assert.equal(session.diagnostics.length, 0);
});
test('0.6 decisions do not resolve concerns and causal conflicts converge independent of order', async () => {
  const { session, revision } = await fixture(), context = session.context(actor);
  const root = session.makeEvent(context, { type: 'comment.created', threadId: 'thread', commentId: 'comment', anchor: { document: 'a.md', documentDigest: revision.documents[0].digest, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, quote: { exact: 'Hello' } }, body: { format: 'markdown', text: 'Question' } });
  const accepted = session.makeEvent(context, { type: 'thread.decided', threadId: 'thread', decision: 'accepted', decisionPredecessors: [] });
  assert.equal(fold([...session.events, root, accepted], revision.id).threads[0].open, true);
  const resolved = session.makeEvent(context, { type: 'thread.resolved', threadId: 'thread', statusPredecessors: [] });
  const reopened = session.makeEvent(context, { type: 'thread.reopened', threadId: 'thread', statusPredecessors: [resolved.id], reason: 'Still relevant' });
  const concurrent = session.makeEvent(context, { type: 'thread.resolved', threadId: 'thread', statusPredecessors: [] });
  const all = [...session.events, root, accepted, resolved, reopened, concurrent];
  for (const input of [all, [...all].reverse(), [...all.slice(3), ...all.slice(0, 3)]]) {
    const graph = admit(input, session.revisions); assert.deepEqual(graph.diagnostics, []);
    const thread = fold(graph.events, revision.id).threads[0]; assert.equal(thread.open, true); assert.equal(thread.status.conflict, true);
  }
});
test('0.6 native adapter rejects linked source/resource/output components', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'omr-containment-')); const root = path.join(base, 'root'), outside = path.join(base, 'outside');
  await mkdir(root); await mkdir(outside); await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const storage = new NativeStorage(root, path.join(base, 'journal'));
  await assert.rejects(storage.write('linked/file', encode('no'), false), /links\/junctions/);
  await assert.rejects(storage.read('linked/file', 100), /links\/junctions/);
});
test('0.6 receipt admission checks exact content and rejects an omitted document before writing', async () => {
  const { session, storage } = await fixture(), context = session.context(actor), audit = await session.audit(context);
  const verification = await session.verificationBlob(audit, 'approve');
  const approved = session.makeEvent(context, { type: 'review.approved', verification, stancePredecessors: [] }, 'approve');
  await session.save(context, approved); assert.equal(session.diagnostics.length, 0);
  const reopened = new ReviewSession(storage); await reopened.open(); await reopened.audit(reopened.context(actor));
  assert.equal(fold(reopened.events, context.revision.id).stances.length, 1);
  const withdrawalAudit = await session.audit(context), withdrawalVerification = await session.verificationBlob(withdrawalAudit, 'withdraw');
  const withdrawn = session.makeEvent(context, { type: 'review.withdrawn', reason: 'Changing my assessment.', verification: withdrawalVerification, stancePredecessors: [approved.id] }, 'withdraw');
  await session.save(context, withdrawn);
  const currentAudit = await session.audit(context);
  const wrong = { ...currentAudit.inventory, documents: [] }, invalid = await publishBlob(storage, 'bad_inventory', jsonBytes(wrong), 'application/json');
  const before = (await storage.list('events')).length;
  await assert.rejects(session.save(context, session.makeEvent(context, { type: 'review.approved', verification: invalid, stancePredecessors: [withdrawn.id] })), /omits required/);
  assert.equal((await storage.list('events')).length, before);
});
test('0.6 approval stops if a new observed event arrives after its confirmation', async () => {
  const { session } = await fixture(), context = session.context(actor), audit = await session.audit(context);
  const verification = await session.verificationBlob(audit, 'approval_context');
  const root = session.makeEvent(context, { type: 'comment.created', threadId: 'new_thread', commentId: 'new_comment', anchor: { document: 'a.md', documentDigest: context.revision.documents[0].digest, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, quote: { exact: 'Hello' } }, body: { format: 'markdown', text: 'New concern' } });
  await session.save(context, root);
  await assert.rejects(session.save(context, session.makeEvent(context, { type: 'review.approved', verification, stancePredecessors: [] })), /state changed after confirmation/);
});
test('0.6 validators reject nonexistent table cells, wrong quotes, invalid dates and extra fields', async () => {
  const { session, revision } = await fixture(), context = session.context(actor), source = 'Hello repeated repeated.\r\n\n| A | B |\n| - | - |\n| x | y |\n';
  const event = session.makeEvent(context, { type: 'comment.created', threadId: 'thread', commentId: 'comment', anchor: { document: 'a.md', documentDigest: revision.documents[0].digest, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, quote: { exact: 'Hello' }, target: { kind: 'table-cell', tableId: stableId('table', 'a.md\0' + 0), row: 99, column: 0 } }, body: { format: 'markdown', text: 'Cell' } });
  assert.throws(() => validateAnchorEvent(event, revision, new Map([['a.md', source]])), /cell does not exist/);
  for (const date of ['2026-09-08', '2026-02-30T12:00:00Z', '2026-09-08T12:00:60Z', '2026-09-08T12:00:00']) assert.throws(() => validate('event', { ...event, occurredAt: date }));
  assert.throws(() => validate('event', { ...event, unsupported: true }));
  assert.throws(() => validate('manifest', { ...session.manifest, capabilities: [...session.manifest.capabilities, 'unknown-state-v1'], requiredCapabilities: [...session.manifest.requiredCapabilities, 'unknown-state-v1'] }), /Unsupported/);
});
test('0.6 coalesces simultaneous refresh requests and bounds event reads', async () => {
  const { session, storage } = await fixture(); let enumerations = 0;
  const list = storage.list.bind(storage); storage.list = async p => { enumerations++; await new Promise(r => setTimeout(r, 5)); return list(p); };
  await Promise.all(Array.from({ length: 25 }, () => session.refresh())); assert.equal(enumerations, 1);
  const blobReadsBefore = [...storage.reads].filter(([p]) => p.startsWith('blobs/')).reduce((sum, [, count]) => sum + count, 0);
  await session.refresh();
  const blobReadsAfter = [...storage.reads].filter(([p]) => p.startsWith('blobs/')).reduce((sum, [, count]) => sum + count, 0);
  assert.equal(blobReadsAfter, blobReadsBefore);
});
test('0.6 slow-storage reconstruction remains bounded and warm refresh avoids historical rereads', async () => {
  const { session, storage, revision } = await fixture(), context = session.context(actor);
  for (let index = 0; index < 127; index++) {
    const event = session.makeEvent(context, {
      type: 'comment.created', threadId: `slow_thread_${index}`, commentId: `slow_comment_${index}`,
      anchor: { document: 'a.md', documentDigest: revision.documents[0].digest, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, quote: { exact: 'Hello' } },
      body: { format: 'markdown', text: `Slow storage finding ${index}` }
    });
    const bytes = jsonBytes(event); storage.files.set(`events/${digest(bytes).slice(7)}.json`, bytes);
  }
  const read = storage.read.bind(storage), list = storage.list.bind(storage);
  let active = 0, peak = 0;
  storage.read = async (file, limit) => {
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 3)); return await read(file, limit); }
    finally { active--; }
  };
  storage.list = async directory => { await new Promise(resolve => setTimeout(resolve, 3)); return list(directory); };
  storage.reads.clear();
  const received = new ReviewSession(storage); await received.open();
  assert.equal(received.events.length, 128); assert.deepEqual(received.diagnostics, []);
  assert.equal(peak, 4, 'Cold reads use bounded parallelism on a high-latency adapter.');
  storage.reads.clear(); peak = 0;
  await Promise.all(Array.from({ length: 20 }, () => received.refresh()));
  assert.ok([...storage.reads.values()].reduce((sum, count) => sum + count, 0) <= 64, 'A warm notification burst performs one bounded integrity sweep.');
  assert.ok(peak <= 4); assert.equal(storage.reads.get(revision.documents[0].blobPath), undefined, 'Warm event refresh does not fetch Markdown content.');
  const controller = new AbortController(), fileCount = storage.files.size;
  const timer = setTimeout(() => controller.abort(), 5);
  await assert.rejects(received.audit(received.context(actor), { signal: controller.signal }), (error: unknown) => error instanceof ProtocolError && error.code === 'cancelled');
  clearTimeout(timer); assert.equal(storage.files.size, fileCount, 'Cancelling verification does not publish or rewrite shared evidence.');
});
test('0.6 graph rejects cross-thread replies, logical-ID collisions, causal cycles and skewed branch winners', async () => {
  const { session, revision, publication } = await fixture(), context = session.context(actor);
  const base = session.makeEvent(context, { type: 'thread.resolved', threadId: 'absent', statusPredecessors: [] });
  assert.equal(admit([...session.events, base], session.revisions).events.length, 1);
  const collision = { ...publication, actor: { id: 'other' }, operationId: 'other' };
  assert.equal(admit([publication, collision], session.revisions).events.length, 0);
  const branch: Revision = { ...revision, id: 'revision_two', createdAt: '2000-01-01T00:00:00Z', parents: [revision.id] };
  const branch2: Revision = { ...revision, id: 'revision_three', createdAt: '2099-01-01T00:00:00Z', parents: [revision.id] };
  session.revisions.set(branch.id, branch); session.revisions.set(branch2.id, branch2);
  assert.deepEqual(session.heads.map(r => r.id).sort(), ['revision_three', 'revision_two']); assert.equal(session.pinnedRevisionId, revision.id);
});
test('0.6 quorum counts actor IDs once and reports conflicting current stances', async () => {
  const { session } = await fixture(), ctx = session.context(actor), audit = await session.audit(ctx), verification = await session.verificationBlob(audit, 'quorum');
  const a = session.makeEvent(ctx, { type: 'review.approved', verification, stancePredecessors: [] });
  const b = session.makeEvent(ctx, { type: 'review.approved', verification, stancePredecessors: [] });
  const p = validate('policy', { schemaVersion: session.manifest.protocolVersion, kind: 'review-policy', mode: 'quorum-v1', eligibleActorIds: ['reviewer', 'second'], minimumApprovals: 2, blockOnRejection: true, requireResolvedThreads: true, requireClosedSuggestions: true });
  assert.equal(policyResult(p, [a, b], ctx.revision.id), 'unsatisfied');
  const rejected = session.makeEvent(ctx, { type: 'review.rejected', verification, stancePredecessors: [], reason: 'Concern' });
  assert.equal(policyResult(p, [a, rejected], ctx.revision.id), 'conflicted');
});
async function authorFixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omr-author-')), source = path.join(temporary, 'source'), store = path.join(temporary, 'package'), journal = path.join(temporary, 'journal');
  await mkdir(source); await writeFile(path.join(source, 'a.md'), '# Title\n\nHello world.\n');
  const request = { source, store, rootDocument: 'a.md', actor, operationId: 'create_fixture', clientArtifact: path.resolve('dist/OpenMarkdownReview.html'), journalRoot: journal };
  return { temporary, request, journal };
}
test('0.5.6 chooses a fresh durable default and excludes generated preview Markdown', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omr-location-')), source = path.join(temporary, 'source');
  await mkdir(path.join(source, '.local-preview/virtual-docs'), { recursive: true });
  await writeFile(path.join(source, 'a.md'), '# Source\n');
  await writeFile(path.join(source, '.local-preview/virtual-docs/generated.md'), '# Generated\n');
  assert.equal(await nextReviewStorageRoot(source), path.join(source, '.review'));
  await mkdir(path.join(source, '.review')); await writeFile(path.join(source, '.review/partial'), 'incomplete');
  assert.equal(await nextReviewStorageRoot(source), path.join(source, '.review-2'));
  assert.deepEqual(await findMarkdownFiles(source), ['a.md']);
  assert.match(transientReviewLocation(path.join(source, '.local-preview/virtual-docs/.review')) ?? '', /generated \.local-preview tree/);
});
test('0.5.6 rejects transient package roots and identifies extensionless supported images by bytes', async () => {
  const transientFixture = await authorFixture();
  await assert.rejects(authorReview({ ...transientFixture.request, store: path.join(transientFixture.temporary, '.local-preview/virtual-docs/.review') }), /generated \.local-preview tree/);

  const { request } = await authorFixture();
  await mkdir(path.join(request.source, 'images'));
  await writeFile(path.join(request.source, 'images/pixel'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  await writeFile(path.join(request.source, 'a.md'), '# Image\n\n![Pixel](images/pixel)\n');
  await authorReview(request);
  const session = new ReviewSession(new NativeStorage(request.store, request.journalRoot)); await session.open();
  assert.equal(session.revision?.resources[0]?.mediaType, 'image/png');

  const unsupported = await authorFixture();
  await mkdir(path.join(unsupported.request.source, 'images'));
  await writeFile(path.join(unsupported.request.source, 'images/unknown'), 'not an image');
  await writeFile(path.join(unsupported.request.source, 'a.md'), '# Image\n\n![Unknown](images/unknown)\n');
  await assert.rejects(authorReview(unsupported.request), /Unsupported frozen image in a\.md: images\/unknown \(application\/octet-stream\)/);
});
test('0.6 authoring creates an identity-bound review launcher, resumes exact revision and refuses nonempty foreign target', async () => {
  const { request } = await authorFixture(), result = await authorReview(request);
  assert.equal(result.outcome, 'completed'); assert.ok(result.revisionId);
  assert.equal(path.basename(result.browserClientPath), 'Review-source.html');
  const launcher = await readFile(result.browserClientPath, 'utf8');
  const encodedBinding = /name="open-markdown-review-bootstrap" content="([A-Za-z0-9+/=]+)"/.exec(launcher)?.[1]; assert.ok(encodedBinding);
  const binding = JSON.parse(Buffer.from(encodedBinding, 'base64').toString('utf8'));
  const manifest = await readFile(path.join(request.store, 'manifest.json'));
  assert.deepEqual(binding, { schemaVersion: 'omr-launcher/1', reviewId: result.reviewId, title: 'source', manifestDigest: digest(manifest) });
  assert.ok(!launcher.includes('Hello world.'), 'Frozen review content is not embedded in the launcher.');
  assert.notEqual(digest(Buffer.from(launcher)), digest(await readFile(request.clientArtifact)));
  const resumed = await authorReview({ ...request, resume: true }); assert.equal(resumed.revisionId, result.revisionId);
  assert.equal((await readdir(path.join(request.store, 'events'))).length, 1);
  await assert.rejects(authorReview({ ...request, operationId: 'other_operation' }), /already contains/);
  await assert.rejects(authorReview({ ...request, resume: true, title: 'Different' }), /parameters differ/);
});
test('0.6 recreated review folders isolate content recovery by review identity and retain earlier evidence', async () => {
  const { request, temporary } = await authorFixture();
  const first = await authorReview(request), originalManifest = await readFile(path.join(request.store, 'manifest.json'));
  const firstSession = new ReviewSession(new NativeStorage(request.store, request.journalRoot)); await firstSession.open();
  const blob = firstSession.revision!.documents[0];
  const journal = new NativeStorage(request.store, request.journalRoot);
  const oldKey = `review:${first.reviewId}:${blob.blobPath}`, oldRecord = await journal.journalGet(oldKey);
  const legacyRecord: JournalEntry = { path: blob.blobPath, bytes: [], digest: blob.digest, acknowledged: true };
  await journal.journalPut(blob.blobPath, legacyRecord);
  const retired = path.join(temporary, 'retired-review'); await rename(request.store, retired);
  const next = { ...request, operationId: 'recreated_fixture', title: 'Recreated review', reviewerEmails: ['alex@example.com'] };
  const second = await authorReview(next); assert.equal(second.outcome, 'completed'); assert.notEqual(second.reviewId, first.reviewId);
  assert.equal(oldRecord?.acknowledged, true);
  const session = new ReviewSession(new NativeStorage(request.store, request.journalRoot)); await session.open();
  await session.audit(session.context(actor)); assert.deepEqual(session.diagnostics, []);
  assert.equal(session.revision!.documents[0].digest, blob.digest);
  assert.equal(session.revision!.rootDocument, request.rootDocument); assert.equal(session.manifest.reviewers!.length, 1);
  assert.deepEqual(await journal.journalGet(oldKey), oldRecord);
  assert.deepEqual(await journal.journalGet(blob.blobPath), legacyRecord, 'Unscoped records remain untouched, not deleted to bypass integrity checks.');
  assert.equal((await journal.journalGet(`review:${second.reviewId}:${blob.blobPath}`))?.acknowledged, true);
  assert.deepEqual(await readFile(path.join(retired, 'manifest.json')), originalManifest);
  const previous = new ReviewSession(new NativeStorage(retired, request.journalRoot)); await previous.open(); await previous.audit(previous.context(actor));
  assert.equal((await authorReview({ ...next, resume: true })).revisionId, second.revisionId);
  assert.equal((await readdir(path.join(request.store, 'events'))).length, 1);
  await unlink(path.join(request.store, blob.blobPath));
  await assert.rejects(authorReview({ ...next, resume: true }), /acknowledged immutable publication/);
  await assert.rejects(readFile(path.join(request.store, blob.blobPath)), { code: 'ENOENT' });
  await assert.rejects(authorReview({ ...next, operationId: 'descendant_fixture', parents: [second.revisionId!] }), /acknowledged immutable publication/);
});
test('0.6 acknowledged content tampering remains fail-closed on exact authoring resume', async () => {
  const { request } = await authorFixture(); await authorReview(request);
  const session = new ReviewSession(new NativeStorage(request.store, request.journalRoot)); await session.open();
  const file = path.join(request.store, session.revision!.documents[0].blobPath), original = await readFile(file);
  const changed = Buffer.from(original); changed[0] ^= 1; await writeFile(file, changed);
  await assert.rejects(authorReview({ ...request, resume: true }), /acknowledged immutable publication/);
  assert.deepEqual(await readFile(file), changed, 'Neither acknowledgement nor file is reset to repair changed evidence.');
});
test('0.6 saved legacy authoring plans retain their original acknowledgement checks after upgrade', async () => {
  const { request } = await authorFixture(), controller = new AbortController();
  await assert.rejects(authorReview({ ...request, signal: controller.signal, progress: message => { if (message.startsWith('Publishing captured content')) controller.abort(); } }), (error: unknown) => error instanceof ProtocolError && error.code === 'cancelled');
  const saved = path.join(request.journalRoot, 'authoring', digest(`${path.resolve(request.store)}\0${request.operationId}`).slice(7), 'plan.json');
  const plan = parseJson<Record<string, unknown>>(await readFile(saved)); delete plan.publicationJournalVersion; await writeFile(saved, jsonBytes(plan));
  const created = await authorReview({ ...request, resume: true }); assert.equal(created.outcome, 'completed');
  const storage = new NativeStorage(request.store, request.journalRoot), session = new ReviewSession(storage); await session.open();
  const blob = session.revision!.documents[0]; assert.equal((await storage.journalGet(blob.blobPath))?.acknowledged, true);
  assert.equal(await storage.journalGet(`review:${created.reviewId}:${blob.blobPath}`), undefined);
  await unlink(path.join(request.store, blob.blobPath));
  await assert.rejects(authorReview({ ...request, resume: true }), /acknowledged immutable publication/);
  await assert.rejects(readFile(path.join(request.store, blob.blobPath)), { code: 'ENOENT' });
  await assert.rejects(authorReview({ ...request, operationId: 'legacy_descendant', parents: [created.revisionId!] }), /Previously published review content|Existing review evidence/);
  await assert.rejects(readFile(path.join(request.store, blob.blobPath)), { code: 'ENOENT' });
});
test('0.6 explicit initial-creation recovery retains legacy journals, exact capture and pending-resume identity', async () => {
  const { request, temporary } = await authorFixture();
  const savedPlan = (operationId: string, journalRoot = request.journalRoot) => path.join(journalRoot, 'authoring', digest(`${path.resolve(request.store)}\0${operationId}`).slice(7), 'plan.json');
  const stageLegacy = async (operationId: string) => {
    const controller = new AbortController();
    await assert.rejects(authorReview({ ...request, operationId, signal: controller.signal, progress: message => { if (message.startsWith('Publishing captured content')) controller.abort(); } }), (error: unknown) => error instanceof ProtocolError && error.code === 'cancelled');
    const file = savedPlan(operationId), plan = parseJson<Record<string, unknown>>(await readFile(file));
    delete plan.publicationJournalVersion; await writeFile(file, jsonBytes(plan));
  };
  await stageLegacy(request.operationId); const first = await authorReview({ ...request, resume: true });
  const firstSession = new ReviewSession(new NativeStorage(request.store, request.journalRoot)); await firstSession.open();
  const blob = firstSession.revision!.documents[0], journal = new NativeStorage(request.store, request.journalRoot), oldRecord = await journal.journalGet(blob.blobPath);
  const retired = path.join(temporary, 'retired'); await rename(request.store, retired);
  const operationId = 'legacy_collision'; await stageLegacy(operationId);
  await assert.rejects(authorReview({ ...request, operationId, resume: true }), /acknowledged immutable publication/);
  const manifest = await readFile(path.join(request.store, 'manifest.json')), expected = parseJson<Manifest>(manifest);
  assert.notEqual(expected.reviewId, first.reviewId); assert.deepEqual(await readdir(path.join(request.store, 'events')), []);
  assert.deepEqual(await readdir(path.join(request.store, 'revisions')), []);
  const isolated = path.join(temporary, 'explicit-recovery'); await mkdir(path.join(isolated, 'authoring'), { recursive: true });
  const originalPlan = await readFile(savedPlan(operationId));
  await cp(path.dirname(savedPlan(operationId)), path.dirname(savedPlan(operationId, isolated)), { recursive: true, force: false, errorOnExist: true });
  await writeFile(path.join(request.source, 'a.md'), '# Edited after the failed capture\n');
  const recovered = await authorReview({ ...request, operationId, journalRoot: isolated, resume: true });
  assert.equal(recovered.reviewId, expected.reviewId); assert.equal(recovered.outcome, 'completed');
  assert.deepEqual(await readFile(path.join(request.store, 'manifest.json')), manifest);
  assert.deepEqual(await readFile(savedPlan(operationId)), originalPlan); assert.deepEqual(await journal.journalGet(blob.blobPath), oldRecord);
  const session = new ReviewSession(new NativeStorage(request.store, isolated)); await session.open(); await session.audit(session.context(actor));
  assert.equal(new TextDecoder().decode(await session.content(session.revision!.documents[0])), '# Title\n\nHello world.\n');
  assert.equal((await authorReview({ ...request, operationId, resume: true })).revisionId, recovered.revisionId);
  assert.equal((await readdir(path.join(request.store, 'events'))).length, 1);
});
test('0.6 verified package publication is portable and source linkage remains private', async () => {
  const { request, temporary, journal } = await authorFixture();
  await mkdir(path.join(request.source, 'nested')); await writeFile(path.join(request.source, 'nested/b.md'), '# Second document\n');
  await authorReview(request);
  await writeFile(path.join(request.store, 'StartReview.exe'), 'Inert optional launcher fixture; never execute.');
  await writeFile(path.join(request.store, 'StartReview.exe.sha256'), 'Inert checksum fixture.');
  const before = await inspectReviewPackage(request.store), destination = path.join(temporary, 'published-review');
  const result = await relocateReviewPackage(request.store, destination);
  assert.equal(await readFile(path.join(destination, 'StartReview.exe'), 'utf8'), 'Inert optional launcher fixture; never execute.');
  assert.equal(result.reviewId, before.reviewId); assert.equal(result.fingerprint, before.fingerprint);
  assert.deepEqual(await readFile(path.join(destination, 'manifest.json')), await readFile(path.join(request.store, 'manifest.json')));
  const copied = new ReviewSession(new NativeStorage(destination, journal)); await copied.open(); await copied.refresh(true);
  assert.equal(copied.revision?.documents.length, 2);
  const linked = await inspectSourceBinding(destination, request.source, journal);
  assert.equal(linked.documents, 2); assert.deepEqual(linked.changed, []); assert.deepEqual(linked.missing, []); assert.equal(linked.exact.length, 2);
  await writeFile(path.join(request.source, 'a.md'), '# Changed for a later revision\n');
  const changed = await inspectSourceBinding(destination, request.source, journal);
  assert.deepEqual(changed.changed, ['a.md']); assert.deepEqual(changed.missing, []);
  await unlink(path.join(request.source, 'nested/b.md'));
  assert.deepEqual((await inspectSourceBinding(destination, request.source, journal)).missing, ['nested/b.md']);
  const nonempty = path.join(temporary, 'nonempty-destination'); await mkdir(nonempty); await writeFile(path.join(nonempty, 'keep.txt'), 'keep');
  await assert.rejects(relocateReviewPackage(request.store, nonempty), /must be empty/);
  await mkdir(path.join(request.store, 'client-backups'));
  await symlink(request.store, path.join(request.store, 'client-backups/linked-package'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectReviewPackage(request.store), /Linked or special/);
});
test('0.6 sanitized HTML profile freezes images, inventories links, preserves source maps and removes active markup', async () => {
  const { request } = await authorFixture();
  await mkdir(path.join(request.source, 'images'));
  const source = `# HTML fixture

<a id="bookmark"></a><u style="color:red" onclick="alert(1)">Underlined &copy; &amp; mapped</u>

<!-- retained only in frozen source -->
<table id="risk-table" onclick="alert(2)">
<thead><tr><th rowspan="2">Risk</th><th>Owner</th></tr></thead>
<tbody><tr><td><mark>Mira</mark></td></tr></tbody>
</table>

<img src="images/icon.svg" alt="Architecture icon" width="120" onerror="alert(3)">

<a href="https://example.com/evidence" onclick="alert(4)">External evidence</a>
<a href="http://example.com/insecure">Insecure external evidence</a>
<a href="file:///restricted/evidence.pdf">File evidence</a>
<a href="javascript:alert(5)">Script reference</a>
<a href="evidence.txt" title="review:attach">Frozen attachment</a>
<a href="evidence.docx" title="review:attach">Frozen Word source</a>
<a href="drawing.vsd" title="review:attach">Frozen Visio source</a>
<a href="drawing.emf" title="review:attach">Frozen EMF source</a>

<script><img src="missing.png" onerror="alert(6)">globalThis.compromised = true</script>
`;
  await writeFile(path.join(request.source, 'a.md'), source);
  await writeFile(path.join(request.source, 'images/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="navy"/></svg>');
  await writeFile(path.join(request.source, 'evidence.txt'), 'Frozen HTML attachment.');
  await writeFile(path.join(request.source, 'evidence.docx'), 'Bounded Word fixture.');
  await writeFile(path.join(request.source, 'drawing.vsd'), 'Bounded Visio fixture.');
  await writeFile(path.join(request.source, 'drawing.emf'), 'Bounded EMF fixture.');
  const created = await authorReview(request); assert.equal(created.outcome, 'completed');
  const session = new ReviewSession(new NativeStorage(request.store, request.journalRoot)); await session.open();
  const revision = session.revision!;
  assert.ok(session.manifest.requiredCapabilities.includes(SANITIZED_HTML_CAPABILITY));
  assert.equal(revision.renderer.markdownProfile, SANITIZED_HTML_PROFILE);
  assert.equal(revision.resources.length, 5); assert.deepEqual(revision.resources.map(resource => resource.role).sort(), ['attachment', 'attachment', 'attachment', 'attachment', 'image']);
  assert.deepEqual(revision.resources.filter(resource => resource.role === 'attachment').map(resource => resource.mediaType).sort(), ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.visio', 'image/emf', 'text/plain']);
  assert.deepEqual(revision.externalReferences.map(reference => reference.uri).sort(), ['file:///restricted/evidence.pdf', 'http://example.com/insecure', 'https://example.com/evidence']);
  assert.equal(revision.diagnostics.some(diagnostic => diagnostic.code === 'html.unsupported-tags' && diagnostic.message.includes('script')), true);
  const parsed = inspect(source, 'a.md', SANITIZED_HTML_PROFILE);
  assert.deepEqual(parsed.tables.map(table => table.rows), [[2, 1]]); assert.equal(parsed.references.length, 5); assert.equal(parsed.links.length, 3);
  const rendered = renderDocument(source, 'a.md', revision);
  assert.match(rendered.html, /class="semantic html-table"/); assert.match(rendered.html, /rowspan="2"/);
  assert.match(rendered.html, /data-source-bookmark="risk-table"/); assert.doesNotMatch(rendered.html, /id="(?:bookmark|risk-table)"/);
  assert.match(rendered.html, /data-resource="resource_/); assert.match(rendered.html, /href="https:\/\/example\.com\/evidence"/);
  assert.match(rendered.html, /data-attachment="resource_/);
  assert.match(rendered.html, /class="blocked-reference"/); assert.match(rendered.html, /&lt;script&gt;&lt;img src=&quot;missing\.png&quot; onerror=&quot;alert\(6\)&quot;&gt;globalThis\.compromised = true&lt;\/script&gt;/);
  assert.doesNotMatch(rendered.html, /<[^>]*(?:onclick|onerror)|style="color:red"|<!-- retained|href="http:|href="javascript:/);
  const underlined = source.indexOf('Underlined');
  assert.equal([...rendered.textMaps.values()].some(offsets => offsets[0] === underlined && offsets.at(-1)! >= underlined + 'Underlined &copy; &amp; mapped'.length), true);
  assert.match(rendered.html, new RegExp(`data-start="${source.indexOf('<table')}" data-end="${source.indexOf('</table>') + '</table>'.length}"`));
});
test('Markdown file references are audited but rendered as non-actionable', async () => {
  const source = '# Evidence\n\n[Local author file](file:///restricted/evidence.pdf)\n';
  const parsed = inspect(source, 'a.md');
  assert.deepEqual(parsed.links.map(link => link.uri), ['file:///restricted/evidence.pdf']);
  const { revision } = await fixture();
  const candidate: Revision = {
    ...revision,
    externalReferences: parsed.links.map(link => ({ ...link, document: 'a.md', relation: 'link' as const }))
  };
  const rendered = renderDocument(source, 'a.md', candidate).html;
  assert.match(rendered, /class="blocked-reference"/);
  assert.doesNotMatch(rendered, /href="file:/);
});
test('0.6 CLI dry-run writes no package, unknown flags fail, and inspect/validate need no VS Code', async () => {
  const { request } = await authorFixture();
  const args = ['review', 'create', '--source', request.source, '--store', request.store, '--root-document', 'a.md', '--actor-id', 'reviewer', '--operation-id', 'cli_fixture', '--dry-run', '--json'];
  const dry = await runCli(args, request.clientArtifact); assert.equal(dry.exitCode, 0); await assert.rejects(readdir(request.store));
  assert.equal((await runCli(args.filter((a, i) => a !== '--operation-id' && args[i - 1] !== '--operation-id'), request.clientArtifact)).exitCode, 0);
  assert.equal((await runCli([...args, '--not-a-flag'], request.clientArtifact)).exitCode, 2);
  await authorReview(request);
  assert.equal((await runCli(['review', 'inspect', '--store', request.store, '--json'], request.clientArtifact)).exitCode, 0);
  assert.equal((await runCli(['review', 'validate', '--store', request.store, '--full', '--json'], request.clientArtifact)).exitCode, 0);
});
test('0.6 creation cancellation preserves captured bytes and never publishes a revision', async () => {
  const { request } = await authorFixture(), controller = new AbortController();
  await writeFile(path.join(request.source, 'b.md'), '# Another document\n');
  await assert.rejects(authorReview({ ...request, signal: controller.signal, progress: message => { if (message === 'Capturing b.md') controller.abort(); } }), (error: unknown) => error instanceof ProtocolError && error.code === 'cancelled');
  await assert.rejects(readdir(request.store));
  await writeFile(path.join(request.source, 'a.md'), '# Changed after cancellation\n');
  const result = await authorReview({ ...request, resume: true }); assert.equal(result.outcome, 'completed');
  const session = new ReviewSession(new NativeStorage(request.store, request.journalRoot)); await session.open();
  assert.equal(new TextDecoder().decode(await session.content(session.revision!.documents.find(d => d.path === 'a.md')!)), '# Title\n\nHello world.\n');
  const cancelled = await runCli(['review', 'inspect', '--store', request.store], request.clientArtifact, { signal: controller.signal });
  assert.equal(cancelled.exitCode, 6);
});
test('0.6 native suggested source edit requires acceptance and is idempotent on retry', async () => {
  const { request, journal } = await authorFixture(), created = await authorReview(request), store = new NativeStorage(request.store, journal), session = new ReviewSession(store);
  await session.open(); const ctx = session.context(actor), doc = ctx.revision.documents[0];
  const suggestion = session.makeEvent(ctx, { type: 'suggestion.created', suggestionId: 'edit_one', anchor: { document: 'a.md', documentDigest: doc.digest, range: { start: { line: 2, character: 6 }, end: { line: 2, character: 11 } }, quote: { exact: 'world' } }, operation: { kind: 'replace', replacement: 'reviewers' }, rationale: { format: 'markdown', text: 'Make audience explicit.' } });
  await session.save(ctx, suggestion);
  const apply = { store, source: request.source, revisionId: created.revisionId!, suggestionId: 'edit_one', expectedSourceDigest: doc.digest, actor, operationId: 'apply_one' };
  await assert.rejects(applyAcceptedSuggestion(apply), /accepted/);
  await session.save(ctx, session.makeEvent(ctx, { type: 'suggestion.accepted', suggestionId: 'edit_one', decisionPredecessors: [] }));
  assert.equal((await applyAcceptedSuggestion(apply)).outcome, 'completed');
  assert.equal(await readFile(path.join(request.source, 'a.md'), 'utf8'), '# Title\n\nHello reviewers.\n');
  assert.equal((await applyAcceptedSuggestion({ ...apply, resume: true })).outcome, 'already-completed');
});
test('0.6 cancellation before revision publication resumes; after publication reports completion', async t => {
  for (const phase of ['blobs/', 'events/']) await t.test(phase, async child => {
    const { request } = await authorFixture(), controller = new AbortController(), original = NativeStorage.prototype.write;
    child.mock.method(NativeStorage.prototype, 'write', async function(this: NativeStorage, file: string, bytes: Uint8Array, recover: boolean) {
      await original.call(this, file, bytes, recover);
      if (this.root === request.store && file.startsWith(phase)) controller.abort();
    });
    if (phase === 'blobs/') {
      await assert.rejects(authorReview({ ...request, signal: controller.signal }), (error: unknown) => error instanceof ProtocolError && error.code === 'cancelled');
      assert.deepEqual(await readdir(path.join(request.store, 'events')), []);
      assert.equal((await authorReview({ ...request, resume: true })).outcome, 'completed');
    } else assert.equal((await authorReview({ ...request, signal: controller.signal })).outcome, 'completed');
    assert.equal((await readdir(path.join(request.store, 'events'))).length, 1);
  });
});
async function acceptedApplyFixture() {
  const { request, journal } = await authorFixture(); await authorReview(request);
  const store = new NativeStorage(request.store, journal), session = new ReviewSession(store); await session.open();
  const ctx = session.context(actor), doc = ctx.revision.documents[0];
  await session.save(ctx, session.makeEvent(ctx, { type: 'suggestion.created', suggestionId: 'fault_edit', anchor: { document: 'a.md', documentDigest: doc.digest, range: { start: { line: 2, character: 6 }, end: { line: 2, character: 11 } }, quote: { exact: 'world' } }, operation: { kind: 'replace', replacement: 'reviewers' }, rationale: { format: 'markdown', text: 'Recovery fixture.' } }));
  const accepted = session.makeEvent(ctx, { type: 'suggestion.accepted', suggestionId: 'fault_edit', decisionPredecessors: [] }); await session.save(ctx, accepted);
  return { request, session, ctx, accepted, apply: { store, source: request.source, revisionId: ctx.revision.id, suggestionId: 'fault_edit', expectedSourceDigest: doc.digest, actor, operationId: 'fault_apply' } };
}
test('0.6 interrupted source staging leaves original intact and resumes exact bytes', async t => {
  const { request, apply } = await acceptedApplyFixture(), original = NativeStorage.prototype.write;
  let fail = true;
  t.mock.method(NativeStorage.prototype, 'write', async function(this: NativeStorage, file: string, bytes: Uint8Array, recover: boolean) {
    if (fail && file.endsWith('.pending')) { fail = false; await original.call(this, file, bytes.slice(0, 7), recover); throw new Error('simulated disconnect while staging'); }
    return original.call(this, file, bytes, recover);
  });
  await assert.rejects(applyAcceptedSuggestion(apply), /interrupted/);
  assert.equal(await readFile(path.join(request.source, 'a.md'), 'utf8'), '# Title\n\nHello world.\n');
  const saved = (await apply.store.journalGet('apply:fault_apply'))!;
  const plan = parseJson<{ originalBase64: string }>(new Uint8Array(saved.bytes));
  assert.equal(Buffer.from(plan.originalBase64, 'base64').toString(), '# Title\n\nHello world.\n');
  await applyAcceptedSuggestion({ ...apply, resume: true });
  assert.equal(await readFile(path.join(request.source, 'a.md'), 'utf8'), '# Title\n\nHello reviewers.\n');
  assert.deepEqual((await readdir(request.source)).filter(name => name.endsWith('.pending')), []);
});
test('0.6 completed source replacement with pending evidence retries without a second edit', async t => {
  const { request, apply } = await acceptedApplyFixture(), original = apply.store.write.bind(apply.store);
  let fail = true;
  t.mock.method(apply.store, 'write', async (file: string, bytes: Uint8Array, recover: boolean) => {
    if (fail && file.startsWith('events/')) { fail = false; throw new Error('event publication unavailable'); }
    return original(file, bytes, recover);
  });
  await assert.rejects(applyAcceptedSuggestion(apply), /Source was saved, but application evidence is still pending/);
  assert.equal(await readFile(path.join(request.source, 'a.md'), 'utf8'), '# Title\n\nHello reviewers.\n');
  await applyAcceptedSuggestion({ ...apply, resume: true });
  const check = new ReviewSession(apply.store); await check.open();
  assert.equal(check.events.filter(event => event.type === 'suggestion.applied').length, 1);
  assert.equal((await applyAcceptedSuggestion({ ...apply, resume: true })).outcome, 'already-completed');
});
test('0.6 source replacement refuses a changed source or acceptance after staging', async t => {
  for (const fault of ['source', 'acceptance', 'foreign-stage']) await t.test(fault, async child => {
    const { request, apply, session, ctx, accepted } = await acceptedApplyFixture(), original = NativeStorage.prototype.write;
    let inject = true;
    child.mock.method(NativeStorage.prototype, 'write', async function(this: NativeStorage, file: string, bytes: Uint8Array, recover: boolean) {
      await original.call(this, file, bytes, recover);
      if (inject && file.endsWith('.pending')) {
        inject = false;
        if (fault === 'source') await writeFile(path.join(request.source, 'a.md'), '# User edited this while staging.\n');
        else if (fault === 'acceptance') await session.save(ctx, session.makeEvent(ctx, { type: 'suggestion.rejected', suggestionId: 'fault_edit', reason: 'New concern during source staging.', decisionPredecessors: [accepted.id] }));
        else { await writeFile(path.join(request.source, file), 'unrelated staging data'); throw new Error('staging changed'); }
      }
    });
    await assert.rejects(applyAcceptedSuggestion(apply), /changed|interrupted/);
    await assert.rejects(applyAcceptedSuggestion({ ...apply, resume: true }), /changed|unrelated/);
    assert.equal(await readFile(path.join(request.source, 'a.md'), 'utf8'), fault === 'source' ? '# User edited this while staging.\n' : '# Title\n\nHello world.\n');
  });
});
test('0.6 interrupted resource capture resumes previously captured Markdown, not changed source', async () => {
  const { request } = await authorFixture();
  const original = '# Frozen before capture failure\n\n![Diagram](missing.svg)\n';
  await writeFile(path.join(request.source, 'a.md'), original);
  await assert.rejects(authorReview(request), /missing.svg/);
  await writeFile(path.join(request.source, 'a.md'), '# Changed after capture failure\n');
  await writeFile(path.join(request.source, 'missing.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  await assert.rejects(authorReview(request), /Capture already started/);
  const result = await authorReview({ ...request, resume: true }); assert.equal(result.outcome, 'completed');
  const session = new ReviewSession(new NativeStorage(request.store, request.journalRoot)); await session.open();
  assert.equal(new TextDecoder().decode(await session.content(session.revision!.documents[0])), original);
});
test('0.6 explicit HTML update keeps exact backup and never changes protocol evidence', async () => {
  const { request, temporary } = await authorFixture(); const created = await authorReview(request);
  const legacyPath = path.join(request.store, 'OpenMarkdownReview.html'); await rename(created.browserClientPath, legacyPath);
  const original = await readFile(legacyPath), oldDigest = digest(original), manifest = await readFile(path.join(request.store, 'manifest.json'));
  const template = await readFile(request.clientArtifact), modified = Buffer.concat([template, Buffer.from('\n<!-- alternate trusted test build -->')]), artifact = path.join(temporary, 'new-client.html'); await writeFile(artifact, modified);
  const store = new NativeStorage(request.store, request.journalRoot);
  await assert.rejects(updateClient(store, artifact, digest('wrong')), /confirmation/);
  const updated = await updateClient(store, artifact, oldDigest);
  assert.ok(updated.backupPath); assert.equal(digest(await readFile(updated.backupPath)), oldDigest);
  assert.equal(path.basename(updated.path), 'Review-source.html'); await assert.rejects(readFile(legacyPath), /ENOENT/);
  assert.match(await readFile(updated.path, 'utf8'), /alternate trusted test build/); assert.deepEqual(await readFile(path.join(request.store, 'manifest.json')), manifest);
  assert.equal((await readdir(path.join(request.store, 'events'))).length, 1);
});
test('0.6 CLI rejects valid-but-inapplicable flags before accessing or changing a review', async () => {
  for (const args of [['review', 'export', '--store', '/missing', '--dry-run'], ['review', 'inspect', '--store', '/missing', '--parent', 'revision'], ['review', 'create', '--store', '/missing', '--browser-executable', '/browser']]) assert.equal((await runCli(args)).exitCode, 2);
  assert.equal((await runCli(['--help'])).exitCode, 0);
});
test('0.6 full audits deduplicate historical receipt reads but reread on the next audit', async () => {
  const { storage, session } = await fixture(), ctx = session.context(actor);
  for (let i = 0; i < 3; i++) {
    const audit = await session.audit(ctx), verification = await session.verificationBlob(audit, `receipt_${i}`);
    const stancePredecessors = fold(session.events, ctx.revision.id).register(`stance:${ctx.revision.id}:${actor.id}`).heads.map(e => e.id);
    await session.save(ctx, session.makeEvent(ctx, i === 1 ? { type: 'review.withdrawn', reason: 'Exercise historical receipt reads.', verification, stancePredecessors } : { type: 'review.approved', verification, stancePredecessors }));
  }
  storage.reads.clear(); await session.audit(ctx); for (const [file, count] of storage.reads) assert.equal(count, 1, file);
  storage.reads.clear(); await session.audit(ctx); assert.equal(storage.reads.get('manifest.json'), 1);
});
test('0.6 real causal cycle and over-depth history are rejected independently of arrival order', async () => {
  const { session, publication, revision } = await fixture(), ctx = session.context(actor);
  const root = session.makeEvent(ctx, { type: 'comment.created', threadId: 't', commentId: 'c', anchor: { document: 'a.md', documentDigest: revision.documents[0].digest, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, quote: { exact: 'Hello' } }, body: { format: 'markdown', text: 'Concern' } });
  const a = session.makeEvent(ctx, { type: 'thread.resolved', threadId: 't', statusPredecessors: [] }), b = session.makeEvent(ctx, { type: 'thread.reopened', threadId: 't', reason: 'Cycle fixture', statusPredecessors: [a.id] });
  if (a.type === 'thread.resolved') a.statusPredecessors = [b.id];
  for (const events of [[publication, root, a, b], [b, a, root, publication]]) assert.equal(admit(events, session.revisions).events.length, 2);
  const chain: Event[] = [publication, root]; let previous: string[] = [];
  for (let i = 0; i < 1026; i++) { const event = session.makeEvent(ctx, { type: 'thread.resolved', threadId: 't', statusPredecessors: previous }); chain.push(event); previous = [event.id]; }
  assert.ok(admit(chain, session.revisions).diagnostics.length); assert.ok(admit([...chain].reverse(), session.revisions).diagnostics.length);
});
test('0.6 scale: 10,000 events reconstruct identically; warm scan reads only its bounded integrity sweep', async () => {
  const { session, storage, revision } = await fixture(), ctx = session.context(actor);
  for (let i = 0; i < 9999; i++) {
    const event = session.makeEvent(ctx, { type: 'comment.created', threadId: `thread_${i}`, commentId: `comment_${i}`, anchor: { document: 'a.md', documentDigest: revision.documents[0].digest, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, quote: { exact: 'Hello' } }, body: { format: 'markdown', text: `Scale concern ${i}` } });
    const bytes = jsonBytes(event); storage.files.set(`events/${digest(bytes).slice(7)}.json`, bytes);
  }
  const start = performance.now(); await session.refresh(); const cold = performance.now() - start;
  assert.equal(session.events.length, 10000); assert.deepEqual(session.diagnostics, []);
  storage.reads.clear(); const warmStart = performance.now(); await session.refresh();
  assert.ok([...storage.reads.values()].reduce((sum, n) => sum + n, 0) <= 64); assert.equal(storage.reads.get(revision.documents[0].blobPath), undefined);
  const rebuilt = new ReviewSession(storage); await rebuilt.open(); assert.deepEqual(rebuilt.events.map(e => e.id), session.events.map(e => e.id));
  process.stdout.write(`Scale 10000 events: cold ${cold.toFixed(1)} ms, warm ${(performance.now() - warmStart).toFixed(1)} ms including independent rebuild; pure in-memory adapter, not a shared-drive latency claim.\n`);
});
test('0.6 source maps do not confuse link destinations/titles with repeated visible text', async () => {
  const { revision } = await fixture();
  for (const source of ['[same](https://example.invalid/same "same") same', '[same][same] same\n\n[same]: https://example.invalid/same', '**same** and `same` &amp; 😀 same']) {
    const rendered = renderDocument(source, 'a.md', revision), maps = [...rendered.textMaps.values()];
    assert.ok(maps.length > 1); const last = maps.at(-1)!;
    assert.equal(last.at(-1), source.startsWith('[same][same]') ? source.indexOf('\n') : source.length);
    assert.ok(last[0] <= source.indexOf(' same', source.indexOf(')') + 1) || !source.includes(')'));
    assert.equal(source.slice(last.at(-1)! - 4, last.at(-1)), 'same');
  }
});
test('0.6 duplicate transport copy is counted once but an orphan copy blocks verification', async () => {
  const { storage, session, publication } = await fixture();
  storage.files.set('events/publication (conflicted copy).json', jsonBytes(publication));
  await session.refresh(); assert.equal(session.events.length, 1); assert.equal(session.diagnostics[0].severity, 'warning');
  await session.audit(session.context(actor));
  storage.files.delete(`events/${digest(jsonBytes(publication)).slice(7)}.json`);
  await assert.rejects(() => session.audit(session.context(actor)));
});
test('0.6 a simultaneous peer partial event closes during bounded preflight without losing our draft', async () => {
  const { storage, session, revision } = await fixture(), ctx = session.context(actor);
  const payload = { type: 'comment.created' as const, threadId: 'ours', commentId: 'ours', anchor: { document: 'a.md', documentDigest: revision.documents[0].digest, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, quote: { exact: 'Hello' } }, body: { format: 'markdown' as const, text: 'Concurrent concern' } };
  const peer = session.makeEvent(ctx, { ...payload, threadId: 'peer', commentId: 'peer' }), bytes = jsonBytes(peer), filename = `events/${digest(bytes).slice(7)}.json`;
  storage.files.set(filename, bytes.slice(0, 2)); const ours = session.makeEvent(ctx, payload);
  const timer = setTimeout(() => storage.files.set(filename, bytes), 20);
  try { await session.save(ctx, ours); } finally { clearTimeout(timer); }
  assert.equal(session.events.filter(e => e.type === 'comment.created').length, 2); assert.deepEqual(session.diagnostics, []);
});
test('0.6 a completed capture can resume with the original source folder unavailable', async () => {
  const { request, temporary } = await authorFixture(), created = await authorReview(request);
  await rename(request.source, path.join(temporary, 'source-moved-for-recovery-test'));
  const resumed = await authorReview({ ...request, resume: true }); assert.equal(resumed.revisionId, created.revisionId);
  await assert.rejects(authorReview({ ...request, resume: true, include: ['different.md'] }), /parameters differ/);
});
