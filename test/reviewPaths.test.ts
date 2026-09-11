import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewPathKey, sameReviewPath, uniqueReviewPaths } from '../src/reviewPaths';

test('Windows review identity ignores drive/directory case, separators and dot segments', () => {
  assert.equal(reviewPathKey('C:\\Reviews\\Team\\..\\Package', 'win32'), reviewPathKey('c:/reviews/package/', 'win32'));
  assert.equal(reviewPathKey('\\\\Server\\Share\\Review', 'win32'), reviewPathKey('\\\\server\\share\\review\\', 'win32'));
  assert.notEqual(reviewPathKey('C:\\Reviews\\one', 'win32'), reviewPathKey('C:\\Reviews\\two', 'win32'));
});
test('Review identity preserves POSIX case and deduplication preserves the first display path', () => {
  assert.notEqual(reviewPathKey('/reviews/One', 'linux'), reviewPathKey('/reviews/one', 'linux'));
  assert.equal(sameReviewPath(undefined, undefined), false);
  const first = process.platform === 'win32' ? 'C:\\Reviews\\One' : '/reviews/one';
  const alias = process.platform === 'win32' ? 'c:/reviews/one/' : '/reviews/./one/';
  assert.equal(sameReviewPath(first, alias), true);
  assert.deepEqual(uniqueReviewPaths([first, alias]), [first]);
});
