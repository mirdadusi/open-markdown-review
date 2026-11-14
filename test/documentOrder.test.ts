import test from 'node:test';
import assert from 'node:assert/strict';
import { documentOrder } from '../src/professional/documentOrder';
import { actor, findingFixture } from './findingPublication.fixture';
import { ReviewSession } from '../src/professional/session';

test('chapter order crosses folders, sorts numeric parts/suffixes, and never changes inventory', () => {
  const paths = ['features/03-10-z.md', 'features/03-04-b-details.md', 'features/03-04-a-details.md', 'features/04-01-internal.md', 'features/03-02-detail.md', 'sections/06-appendix.md', 'sections/04-hidden.md', 'sections/03-2-inventory.md', 'sections/03-1-inventory.md', 'sections/01-scope.md', 'sections/00-information.md', 'sections/05-deferred.md'];
  const input = [...paths], expected = ['sections/00-information.md', 'sections/01-scope.md', 'sections/03-1-inventory.md', 'sections/03-2-inventory.md', 'features/03-02-detail.md', 'features/03-04-a-details.md', 'features/03-04-b-details.md', 'features/03-10-z.md', 'sections/04-hidden.md', 'features/04-01-internal.md', 'sections/05-deferred.md', 'sections/06-appendix.md'];
  const index = '[1 Scope](01-scope.md)\n\n[Inventory](03-1-inventory.md) [Other inventory](03-2-inventory.md)\n\n[3.2](../features/03-02-detail.md) [4](04-hidden.md)';
  assert.deepEqual(documentOrder(paths, 'sections/00-information.md', index), expected);
  assert.deepEqual(documentOrder([...paths].reverse(), 'sections/00-information.md', index), expected);
  assert.deepEqual(paths, input);
  assert.deepEqual(documentOrder(['10.md', '2.md', 'root.md', '2.md'], 'root.md'), ['root.md', '2.md', '10.md']);
});

test('author index links order unnumbered documents; unsafe, attachment and fenced links do not', () => {
  const paths = ['root.md', 'a.md', 'b.md', 'space name.md', 'html.md', 'tail10.md', 'tail2.md'];
  const source = '```md\n[ignore](a.md)\n```\n\n[external](https://invalid/a.md) [attach](a.md "review:attach") [bad](%ZZ.md) [outside](../a.md)\n\n[B](b.md#heading) [space](space%20name.md)\n\n<a href="html.md">HTML</a>\n\n[A](a.md) [again](b.md)';
  assert.deepEqual(documentOrder(paths, 'root.md', source), ['root.md', 'b.md', 'space name.md', 'html.md', 'a.md', 'tail2.md', 'tail10.md']);
  assert.deepEqual(documentOrder(['root.md', 'a.md', 'z.md'], 'root.md', '[10 Appendix](a.md) [2 Scope](z.md)'), ['root.md', 'z.md', 'a.md']);
  assert.deepEqual(documentOrder(['root.md', 'a.md'], 'absent.md', '[bad](https://elsewhere/a.md)'), ['a.md', 'root.md']);
});

test('reading order is UI-lazy, cached and does not add reads to native validation', async () => {
  const fixture = await findingFixture();
  const session = new ReviewSession(fixture.store); await session.open();
  const original = session.content.bind(session), reads: string[] = [];
  session.content = async content => { reads.push(content.blobPath); return original(content); };
  assert.deepEqual(session.readingPaths(), ['a.md', 'b.md']); assert.deepEqual(reads, []);
  await Promise.all([session.prepareReadingOrder(), session.prepareReadingOrder()]); await session.prepareReadingOrder();
  assert.deepEqual(session.readingPaths(), ['a.md', 'b.md']); assert.equal(reads.length, 1);
  const before = reads.length; await session.refresh(); session.context(actor); session.readingPaths();
  assert.equal(reads.length, before, 'Polling and obtaining a write context never read documents for display ordering.');
});
