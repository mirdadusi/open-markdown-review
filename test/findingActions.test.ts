import test from 'node:test';
import assert from 'node:assert/strict';
import { findingActions, FindingActionContext } from '../src/professional/findingActions';

const base: FindingActionContext = { queue: 'accepted-not-implemented', open: false, creator: true, locked: false, native: true, canEdit: true, addressing: true, accepted: true, addressed: false, otherRevision: false };
const actions = (values: Partial<FindingActionContext> = {}) => findingActions({ ...base, ...values });
test('recorded fix finishes processing; inspect or explicitly reopen, no mandatory verification', () => {
  for (const queue of ['implemented', 'verified'] as const) {
    const result = actions({ queue, addressed: true, otherRevision: true });
    assert.deepEqual(result.primary.map(a => a.action), ['open-addressed', 'reopen-finding']);
    assert.deepEqual(result.more.map(a => a.action), ['reveal-source']);
  }
});
test('a participant can inspect a finished fix but cannot reopen it', () => {
  const result = actions({ queue: 'implemented', addressed: true, creator: false });
  assert.deepEqual(result.primary.map(a => a.action), ['open-addressed']);
  assert.deepEqual(result.more, []);
});
test('initiator can close an implemented but open discussion without reopening the fix', () => {
  for (const queue of ['implemented', 'verified'] as const) for (const locked of [false, true]) {
    assert.deepEqual(actions({ queue, addressed: true, open: true, locked }).primary.map(a => a.action), ['resolve', 'open-addressed', 'reopen-finding']);
    assert.deepEqual(actions({ queue, addressed: true, open: true, locked, creator: false }).primary.map(a => a.action), ['open-addressed']);
  }
});
test('conflicting verification retains an explicit reconciliation action', () => {
  const result = actions({ queue: 'conflict', addressed: true, creator: false, verificationConflict: true });
  assert.deepEqual(result.primary.map(a => a.action), ['open-addressed']);
  assert.ok(result.more.some(a => a.action === 'verify-addressing' && a.label.includes('Reconcile')));
});
test('new or challenged fix: editing and preparation remain actionable, never automatic', () => {
  assert.ok(actions().primary.some(a => a.action === 'publish-fix'));
  const result = actions({ queue: 'challenged', addressed: true });
  assert.ok(result.primary.some(a => a.action === 'reveal-source'));
  assert.ok(result.primary.some(a => a.action === 'publish-fix'));
  assert.equal(result.more.some(a => a.action === 'verify-addressing'), false);
});
test('role, completion, disposition and conflicts do not acquire invalid primary actions', () => {
  const queues: FindingActionContext['queue'][] = ['needs-decision', 'accepted-not-implemented', 'implemented', 'verified', 'challenged', 'disposed', 'conflict'];
  for (const queue of queues) for (const creator of [false, true]) for (const locked of [false, true]) for (const native of [false, true]) {
    const result = actions({ queue, creator, locked, native, canEdit: native, accepted: !['needs-decision', 'disposed'].includes(queue), addressed: ['implemented', 'verified', 'challenged'].includes(queue) });
    const all = [...result.primary, ...result.more];
    assert.equal(new Set(all.map(a => a.action)).size, all.length, 'No duplicated action in primary/secondary menus.');
    assert.equal(all.some(a => a.action === 'reply' || a.action === 'decide'), false, 'Closed discussions retain their write restrictions.');
    if (!creator) assert.equal(all.some(a => ['reveal-source', 'publish-fix', 'record-addressed', 'resolve', 'reopen', 'reopen-finding'].includes(a.action)), false);
    if (!native) assert.equal(all.some(a => a.action === 'publish-fix'), false);
    if (queue === 'conflict' || queue === 'disposed') assert.equal(all.some(a => a.action === 'publish-fix' || a.action === 'verify-addressing'), false);
    if (locked) assert.equal(all.some(a => a.action === 'verify-addressing'), false);
  }
});
