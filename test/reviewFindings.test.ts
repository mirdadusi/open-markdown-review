import test from 'node:test';
import assert from 'node:assert/strict';
import { findingFixture, rewrite, actor } from './findingPublication.fixture';
import { ReviewFindingsIndex, snapshotLabels } from '../src/professional/reviewFindings';
import { fold, threadWorkflowQueue } from '../src/professional/state';
import { reopenFinding } from '../src/professional/reopenFinding';
import { ReviewSession } from '../src/professional/session';

test('review-wide derived index preserves original anchors, reply context and per-snapshot counts', async () => {
  const f = await findingFixture(); await rewrite(f.source);
  const pending = await f.publisher.prepare(f.origin, actor), result = await f.publisher.finish(pending.operationId, actor, [{ threadId: 'finding_0', summary: 'Full document fix.' }]);
  await f.session.refresh(); await f.session.pin(result.revisionId);
  const index = new ReviewFindingsIndex().update(f.session.events);
  assert.equal(index.count(f.origin), 2); assert.equal(index.count(result.revisionId), 0);
  for (const revision of f.session.revisions.keys()) { const expected = fold(f.session.events, revision); assert.deepEqual(index.state(revision).threads, expected.threads); assert.deepEqual(index.state(revision).suggestions, expected.suggestions); }
  assert.equal(index.threads.length, 2);
  assert.match(snapshotLabels(f.session.revisions.values(), index, 'en-GB').get(f.origin)!, /Snapshot 1.*2 findings/);
  assert.strictEqual(index.labels(f.session.revisions.values()), index.labels(f.session.revisions.values()), 'Labels reuse the derived cache.');
  const ctx = f.session.context(actor, f.origin);
  await f.session.save(ctx, f.session.makeEvent(ctx, { type: 'thread.reopened', threadId: 'finding_1', reason: 'Continue discussion.', statusPredecessors: index.state(f.origin).threads[1].status.heads.map(e => e.id) }));
  await f.session.save(ctx, f.session.makeEvent(ctx, { type: 'comment.replied', threadId: 'finding_1', commentId: 'reply_other_snapshot', inReplyTo: 'comment_1', body: { format: 'markdown', text: 'Original-context reply while reading the latest snapshot.' } }));
  index.update(f.session.events);
  assert.equal(index.state(f.origin).threads[1].replies.length, 1);
  assert.equal(f.session.revision!.id, result.revisionId, 'An action on an old finding never moves the document pin.');
  assert.equal(index.state(result.revisionId).threads.length, 0);
  assert.throws(() => f.session.context(actor, 'missing_revision'), /verified revision/);
});

test('implemented is finished; initiator reopen is reasoned, exact and retry-safe without reopening participation', async () => {
  const f = await findingFixture(); await rewrite(f.source);
  const pending = await f.publisher.prepare(f.origin, actor), result = await f.publisher.finish(pending.operationId, actor, [{ threadId: 'finding_0', summary: 'Full document fix.' }]);
  await f.session.refresh(); await f.session.pin(result.revisionId);
  const ctx = f.session.context(actor, f.origin), audit = await f.session.audit(ctx);
  await f.session.save(ctx, f.session.makeEvent(ctx, { type: 'review.completed', completionPredecessors: [], verification: await f.session.verificationBlob(audit, 'complete_fixture') }));
  const before = f.session.events.map(e => e.id), reopen = reopenFinding(ctx, 'finding_0');
  assert.equal(threadWorkflowQueue(fold(f.session.events, f.origin).threads[0]), 'implemented');
  assert.equal(f.session.events.some(e => e.type === 'thread.verification.recorded'), false, 'No verification required to finish processing.');
  await assert.rejects(reopen(' '), /Explain/);
  await assert.rejects(reopenFinding(f.session.context({ id: 'other@example.com' }, f.origin), 'finding_0')('More work'), /initiator/);
  const save = f.session.save.bind(f.session); let fail = true;
  f.session.save = async (context, event) => { if (fail && event.type === 'thread.reopened') { fail = false; throw new Error('Interrupted discussion reopen'); } await save(context, event); };
  await assert.rejects(reopen('The published correction needs another change.'), /Interrupted/);
  await assert.rejects(reopen('Different reason'), /original reason/);
  await reopen('The published correction needs another change.'); await reopen('The published correction needs another change.');
  const added = f.session.events.filter(e => !before.includes(e.id));
  assert.equal(added.length, 2, 'Retry does not duplicate either durable event.');
  assert.equal(new Set(added.map(e => e.operationId)).size, 2, 'Every event has its own immutable operation identity.');
  assert.equal(f.session.revision!.id, result.revisionId);
  const state = fold(f.session.events, f.origin), thread = state.threads[0];
  assert.equal(thread.open, true); assert.equal(threadWorkflowQueue(thread), 'challenged');
  assert.equal(state.register(`completion:${f.origin}:${actor.id}`).heads[0].type, 'review.completed');
  await assert.rejects(reopenFinding(ctx, 'finding_0')('Again'), /already reopened/);
  // An existing old verification stays readable and replacement evidence, not
  // verification of the old implementation, finishes processing again.
  const old = thread.addressed!;
  await f.session.save(ctx, f.session.makeEvent(ctx, { type: 'thread.addressed', threadId: old.threadId, toRevisionId: old.toRevisionId, document: old.document, sourceDigestBefore: old.sourceDigestBefore, sourceDigestAfter: old.sourceDigestAfter, summary: 'Explicitly reconciled the implementation.', decisionIds: old.decisionIds, addressingPredecessors: [old.id] }));
  assert.equal(threadWorkflowQueue(fold(f.session.events, f.origin).threads[0]), 'implemented');
  const fresh = new ReviewSession(f.store); await fresh.open();
  assert.equal(fresh.diagnostics.filter(d => d.severity === 'error').length, 0);
  assert.ok(before.every(id => fresh.events.some(e => e.id === id)), 'No history deleted.');
});
