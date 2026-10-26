import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewerEmails, reviewerEmail, reviewerForInput, reviewerIdentity, reviewerRoster } from '../src/professional/reviewer';
import { Manifest } from '../src/professional/types';

test('reviewer preferences keep the selected ID and name together, without inventing an identity', () => {
  assert.deepEqual(reviewerIdentity({ id: ' mira ', displayName: ' Mira D. ' }), { id: 'mira', displayName: 'Mira D.' });
  assert.deepEqual(reviewerIdentity({ id: 'mira', displayName: '  ' }), { id: 'mira' });
  assert.deepEqual(reviewerIdentity({ id: '😀'.repeat(128) }), { id: '😀'.repeat(128) });
  for (const invalid of [undefined, null, '', {}, { id: '' }, { id: '  ' }, { id: 5 }, { id: 'a', displayName: 5 }, { id: 'a\0b' }, { id: 'a\nb' }, { id: 'a\x85b' }, { id: '😀'.repeat(129) }]) assert.equal(reviewerIdentity(invalid), undefined);
});

test('email rosters canonicalize and deduplicate addresses while preserving stable IDs across clients', () => {
  assert.deepEqual(parseReviewerEmails(' Sam@Example.COM; alex@example.com\nSAM@example.com '), ['alex@example.com', 'sam@example.com']);
  const emails = ['alex@example.com', 'sam@example.com'], reviewers = reviewerRoster(emails), manifest = { reviewers, createdBy: { id: 'initiator' } } as Manifest;
  assert.deepEqual(reviewerRoster([...emails].reverse()), reviewers);
  assert.equal(reviewerForInput(manifest, { id: ' ALEX@EXAMPLE.COM ', displayName: 'Alex' })?.id, reviewers[0].id);
  assert.equal(reviewerForInput(manifest, { id: reviewers[0].id })?.id, reviewers[0].id);
  assert.equal(reviewerForInput(manifest, { id: 'outsider@example.com' }), undefined);
  assert.equal(reviewerForInput(manifest, { id: 'initiator' })?.id, 'initiator');
  const longEmail = `${'a'.repeat(64)}@${'b'.repeat(60)}.${'c'.repeat(40)}.example`;
  const longManifest = { ...manifest, reviewers: reviewerRoster([longEmail]) };
  assert.ok(longEmail.length > 128); assert.equal(reviewerForInput(longManifest, { id: longEmail })?.id, longManifest.reviewers[0].id);
  for (const email of ['user', '@example.com', 'a@', 'a@localhost', 'a b@example.com', '.a@example.com', 'a..b@example.com', 'a@-example.com', 'a@example..com', 'a@example.com\0', `${'a'.repeat(65)}@example.com`]) assert.equal(reviewerEmail(email), undefined, email);
  assert.throws(() => parseReviewerEmails('alex@example.com,broken'), /valid reviewer email/);
  assert.throws(() => parseReviewerEmails(Array.from({ length: 101 }, (_, i) => `reviewer${i}@example.com`)), /at most 100/);
});
