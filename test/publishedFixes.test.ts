import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { actor, findingFixture, rewrite } from './findingPublication.fixture';
import { authorReview } from '../src/professional/authoring';
import { eligibleFixRevisions, publishedFixChoices } from '../src/professional/publishedFixes';
import { reopenFinding } from '../src/professional/reopenFinding';
import { ReviewFindingsIndex } from '../src/professional/reviewFindings';
import type { Revision } from '../src/professional/types';

test('published fix choices have readable names, exact values, document deltas and linked original findings without moving the view', async () => {
  const f = await findingFixture(); await rewrite(f.source);
  const prepared = await f.publisher.prepare(f.origin, actor), fixed = await f.publisher.finish(prepared.operationId, actor, [{ threadId: 'finding_0', summary: 'Clarified the design and supporting chapter.' }]);
  await writeFile(path.join(f.source, 'b.md'), '# Later unrelated work\n');
  const later = await authorReview({ source: f.source, store: f.root, rootDocument: 'a.md', include: ['a.md', 'b.md'], actor, parents: [fixed.revisionId], operationId: 'later_snapshot', journalRoot: f.journalRoot, clientArtifact: path.resolve('dist/OpenMarkdownReview.html'), preserveClient: true });
  await f.session.refresh();
  const pin = f.session.pinnedRevisionId, before = f.session.events.map(event => event.id);
  const choices = publishedFixChoices(f.session.revisions.values(), f.session.events, f.origin, 'b.md', 'en-GB');
  assert.deepEqual(choices.map(choice => choice.id), [later.revisionId, fixed.revisionId]);
  assert.match(choices[0].label, /Snapshot 3.*1 modified.*latest/); assert.match(choices[1].label, /Snapshot 2.*2 modified.*1 recorded fix/);
  assert.ok(choices.every(choice => !choice.label.includes(choice.id)));
  assert.deepEqual(choices[1].changes.map(change => change.path), ['a.md', 'b.md']);
  assert.equal(choices[1].author, actor.displayName); assert.equal(choices[1].fixes[0].quote, 'Original concern.'); assert.equal(choices[1].fixes[0].summary, 'Clarified the design and supporting chapter.');
  assert.equal(choices[0].fixes.length, 0); assert.equal(choices[1].fixes[0].status, 'Implemented');
  assert.equal(f.session.pinnedRevisionId, pin); assert.deepEqual(f.session.events.map(event => event.id), before);
  assert.deepEqual(eligibleFixRevisions(f.session.revisions.values(), fixed.revisionId, 'b.md').map(revision => revision.id), [later.revisionId]);
  const thread = new ReviewFindingsIndex().update(f.session.events).threads.find(thread => thread.root.threadId === 'finding_0')!;
  const context = f.session.context(actor, f.origin), targetDocument = f.session.revisions.get(fixed.revisionId)!.documents.find(doc => doc.path === 'a.md')!;
  const amended = { ...f.session.makeEvent(context, { type: 'thread.addressed', threadId: thread.root.threadId, document: 'a.md', toRevisionId: fixed.revisionId, sourceDigestBefore: thread.root.anchor.documentDigest, sourceDigestAfter: targetDocument.digest, decisionIds: thread.decision.heads.map(event => event.id), addressingPredecessors: thread.addressing.heads.map(event => event.id), summary: 'Causally newer explanation despite a skewed clock.' }), occurredAt: '2020-01-01T00:00:00Z' };
  await f.session.save(context, amended);
  assert.equal(publishedFixChoices(f.session.revisions.values(), f.session.events, f.origin, 'b.md')[1].fixes[0].summary, 'Causally newer explanation despite a skewed clock.');
  await reopenFinding(f.session.context(actor, f.origin), 'finding_0')('The earlier fix needs follow-up.');
  assert.equal(publishedFixChoices(f.session.revisions.values(), f.session.events, f.origin, 'b.md')[1].fixes[0].status, 'Later reopened for changes');
});

test('eligibility excludes current, ancestor, unrelated and document-removed snapshots; competing heads never become latest by date', () => {
  const document = { path: 'a.md', digest: 'sha256:' + '0'.repeat(64) }, policy = { digest: 'sha256:' + '1'.repeat(64) };
  const make = (id: string, parents: string[], createdAt: string) => ({ id, parents, createdAt, createdBy: { id: 'author' }, documents: [document], resources: [], policy } as unknown as Revision);
  const root = make('root', [], '2026-11-10T10:00:00Z'), first = make('first', ['root'], '2026-11-10T10:01:00Z'), left = make('left', ['first'], '2026-11-10T10:02:00Z'), right = make('right', ['first'], '2026-11-10T10:03:00Z'), unrelated = make('other', [], '2026-11-10T10:04:00Z'), removed = { ...make('removed', ['left'], '2026-11-10T10:05:00Z'), documents: [] };
  const all = [root, first, left, right, unrelated, removed];
  assert.deepEqual(eligibleFixRevisions(all, 'first', 'a.md').map(revision => revision.id), ['left', 'right']);
  const choices = publishedFixChoices(all, [], 'first', 'a.md', 'en-GB'); assert.ok(choices.every(choice => !choice.latest));
  assert.ok(choices.find(choice => choice.id === 'right')!.head); assert.ok(!choices.find(choice => choice.id === 'left')!.head);
});

test('added/removed documents, resources and policy-only changes are described from frozen metadata, not source reads', () => {
  const doc = (path: string, digit: string) => ({ path, digest: 'sha256:' + digit.repeat(64) }), policy = (digit: string) => ({ digest: 'sha256:' + digit.repeat(64) });
  const root = { id: 'root', parents: [], documents: [doc('a.md', '0'), doc('old.md', '1')], resources: [{ id: 'image', digest: 'sha256:' + '2'.repeat(64) }], policy: policy('3'), createdBy: actor, createdAt: '2026-11-10T10:00:00Z' } as unknown as Revision;
  const next = { ...root, id: 'next', parents: ['root'], documents: [doc('a.md', '0'), doc('new.md', '4')], resources: [{ id: 'image', digest: 'sha256:' + '5'.repeat(64) }], policy: policy('6'), createdAt: '2026-11-10T10:01:00Z' } as unknown as Revision;
  const choice = publishedFixChoices([root, next], [], 'root', 'a.md', 'en-GB')[0];
  assert.deepEqual(choice.changes, [{ path: 'new.md', kind: 'Added' }, { path: 'old.md', kind: 'Removed' }]); assert.equal(choice.resourceChanges, 1); assert.equal(choice.policyChanged, true); assert.equal(choice.originalDocumentChanged, false);
  assert.match(choice.label, /1 added, 1 removed, 1 resource change, policy changed/);
});
