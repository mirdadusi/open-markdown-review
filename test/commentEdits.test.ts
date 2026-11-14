import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { commentFixture, initiator, owner } from './commentEdits.fixture';
import { admit, dependencies, fold, policyResult } from '../src/professional/state';
import { COMMENT_EDITS, Event } from '../src/professional/types';
import { digest, jsonBytes } from '../src/professional/bytes';
import { authorReview } from '../src/professional/authoring';
import { writeFile } from 'node:fs/promises';
import { reopenFinding } from '../src/professional/reopenFinding';

test('author edits root and own reply as independent immutable events; original anchors and audit closure stay exact', async () => {
  const f = await commentFixture(), ctx = f.session.context(owner), rootFile = path.join(f.root, 'events', digest(jsonBytes(f.comment)).slice(7) + '.json'), bytes = await readFile(rootFile);
  assert.ok(f.session.manifest.requiredCapabilities.includes(COMMENT_EDITS));
  const changed = f.edit('Revised comment wording.'); await f.session.save(ctx, changed); await f.session.save(ctx, changed);
  await f.session.save(ctx, f.edit('Revised reply wording.', 'edit_reply'));
  const state = fold(f.session.events, f.origin);
  assert.equal(state.comments.get('edit_comment')!.body.text, 'Revised comment wording.');
  assert.equal(state.comments.get('edit_reply')!.body.text, 'Revised reply wording.');
  assert.equal(state.threads[0].root.body.text, 'Original comment wording.');
  assert.equal(f.session.events.filter(e => e.type === 'comment.edited').length, 2, 'Retry is idempotent.');
  assert.deepEqual(await readFile(rootFile), bytes); assert.deepEqual(state.threads[0].root.anchor, (f.comment as Extract<Event, { type: 'comment.created' }>).anchor);
  assert.ok(dependencies(changed, f.session.events, f.session.revisions).includes(f.comment.id));
  const audit = await f.session.audit(ctx); assert.ok(audit.events.some(e => e.id === changed.id)); assert.ok(audit.events.some(e => e.id === f.comment.id));
});

test('ownership, capabilities, stale edits, closed discussions and finished reviewers are enforced by the write core', async () => {
  const f = await commentFixture(), ctx = f.session.context(owner);
  await assert.rejects(f.session.save(f.session.context(initiator), f.edit('Not my comment.', 'edit_comment', [], initiator)), /original author/);
  await assert.rejects(f.session.save(ctx, f.edit('Not my reply.', 'other_reply')), /original author/);
  assert.throws(() => f.edit('  '), /must not be blank/);
  const stale = f.edit('Stale draft.'), first = f.edit('Saved wording.'); await f.session.save(ctx, first);
  await assert.rejects(f.session.save(ctx, stale), /changed while/);
  const creator = f.session.context(initiator); await f.session.save(creator, f.session.makeEvent(creator, { type: 'thread.resolved', threadId: 'edit_thread', statusPredecessors: [] }));
  await assert.rejects(f.session.save(ctx, f.edit('Closed edit.', 'edit_comment', [first.id])), /closed/);
  const status = fold(f.session.events, f.origin).threads[0].status;
  await f.session.save(creator, f.session.makeEvent(creator, { type: 'thread.reopened', threadId: 'edit_thread', reason: 'Continue.', statusPredecessors: status.heads.map(e => e.id) }));
  const audit = await f.session.audit(ctx); await f.session.save(ctx, f.session.makeEvent(ctx, { type: 'review.completed', completionPredecessors: [], verification: await f.session.verificationBlob(audit, 'finish_owner') }));
  await assert.rejects(f.session.save(ctx, f.edit('Finished edit.', 'edit_comment', [first.id])), /review is finished/);
  const old = await commentFixture(true); await assert.rejects(old.session.save(old.session.context(owner), old.edit('Unsupported.')), /does not declare comment-edits/);
});

test('simultaneous edits expose conflict, preserve both versions and require an explicit causal merge', async () => {
  const f = await commentFixture(), a = f.edit('Concurrent A.'), b = f.edit('Concurrent B.');
  const graph = (events: Event[]) => admit(events, f.session.revisions, new Map(), initiator.id, initiator.id, f.session.manifest);
  const merged = graph([...f.session.events, b, a]); assert.deepEqual(merged.diagnostics, []);
  const thread = fold(merged.events, f.origin).threads[0]; assert.equal(thread.editConflict, true); assert.equal(thread.comment.edits.heads.length, 2);
  assert.equal(policyResult({ schemaVersion: '0.6.0', kind: 'review-policy', mode: 'quorum-v1', eligibleActorIds: [owner.id], minimumApprovals: 1, blockOnRejection: true, requireResolvedThreads: true, requireClosedSuggestions: true }, merged.events, f.origin), 'conflicted');
  const resolve = f.edit('Explicit merged wording.', 'edit_comment', [a.id, b.id]), complete = graph([...merged.events, resolve]);
  assert.deepEqual(complete.diagnostics, []); assert.equal(fold(complete.events, f.origin).threads[0].comment.body.text, 'Explicit merged wording.');
  assert.equal(fold(complete.events, f.origin).threads[0].editConflict, false);
  const forged = f.edit('Forged author.', 'edit_comment', [], initiator); assert.ok(graph([...f.session.events, forged]).diagnostics.some(d => /original comment author/.test(d.message)));
  const wrongParent = f.edit('Other comment predecessor.', 'edit_reply', [a.id]); assert.ok(graph([...f.session.events, a, wrongParent]).diagnostics.some(d => /predecessor/.test(d.message)));
  const missing = { ...a, commentId: 'missing_comment' }; assert.ok(graph([...f.session.events, missing]).diagnostics.length);
});

test('edits on an original snapshot do not move the selected newer snapshot or enter its comments', async () => {
  const f = await commentFixture(); await writeFile(path.join(f.source, 'index.md'), '# Latest specification\n\nNew published sentence.\n');
  const next = await authorReview({ source: f.source, store: f.root, rootDocument: 'index.md', actor: initiator, operationId: 'publish_second', parents: [f.origin], journalRoot: f.journal, clientArtifact: path.resolve('dist/OpenMarkdownReview.html') });
  await f.session.refresh(); await f.session.pin(next.revisionId!);
  await f.session.save(f.session.context(owner, f.origin), f.edit('Edited on original snapshot.'));
  assert.equal(f.session.revision!.id, next.revisionId); assert.equal(fold(f.session.events, next.revisionId!).comments.size, 0);
  const creator = f.session.context(initiator, f.origin), decision = f.session.makeEvent(creator, { type: 'thread.decided', threadId: 'edit_thread', decision: 'accepted', decisionPredecessors: [] }); await f.session.save(creator, decision);
  const thread = fold(f.session.events, f.origin).threads[0], target = f.session.revisions.get(next.revisionId!)!;
  await f.session.save(creator, f.session.makeEvent(creator, { type: 'thread.addressed', threadId: 'edit_thread', toRevisionId: target.id, document: thread.root.anchor.document, sourceDigestBefore: thread.root.anchor.documentDigest, sourceDigestAfter: target.documents[0].digest, summary: 'Implemented in the published snapshot.', decisionIds: [decision.id], addressingPredecessors: [] }));
  const heads = fold(f.session.events, f.origin).comments.get('edit_comment')!.edits.heads.map(e => e.id);
  await assert.rejects(f.session.save(f.session.context(owner, f.origin), f.edit('Should be locked.', 'edit_comment', heads)), /finding is implemented/);
  await reopenFinding(creator, 'edit_thread')('Further work needs discussion.');
  await f.session.save(f.session.context(owner, f.origin), f.edit('Explicitly reopened correction.', 'edit_comment', heads));
});
