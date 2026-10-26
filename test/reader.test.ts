import test from 'node:test';
import assert from 'node:assert/strict';
import { readingOrder } from '../src/professional/reader';

test('reading order keeps the root first and preserves the frozen inventory order without mutation', () => {
  const paths = ['appendix.md', 'nested/details.md', 'overview.md'];
  assert.deepEqual(readingOrder(paths, 'overview.md'), ['overview.md', 'appendix.md', 'nested/details.md']);
  assert.deepEqual(paths, ['appendix.md', 'nested/details.md', 'overview.md']);
  assert.deepEqual(readingOrder(['a.md'], 'a.md'), ['a.md']);
});
