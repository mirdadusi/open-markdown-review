import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewerIdentity } from '../src/professional/reviewer';

test('reviewer preferences keep the selected ID and name together, without inventing an identity', () => {
  assert.deepEqual(reviewerIdentity({ id: ' mira ', displayName: ' Mira D. ' }), { id: 'mira', displayName: 'Mira D.' });
  assert.deepEqual(reviewerIdentity({ id: 'mira', displayName: '  ' }), { id: 'mira' });
  assert.deepEqual(reviewerIdentity({ id: '😀'.repeat(128) }), { id: '😀'.repeat(128) });
  for (const invalid of [undefined, null, '', {}, { id: '' }, { id: '  ' }, { id: 5 }, { id: 'a', displayName: 5 }, { id: 'a\0b' }, { id: 'a\nb' }, { id: 'a\x85b' }, { id: '😀'.repeat(129) }]) assert.equal(reviewerIdentity(invalid), undefined);
});
