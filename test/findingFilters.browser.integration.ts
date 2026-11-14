import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { actor, findingFixture } from './findingPublication.fixture';
import { startCompanion, startNativeCompanion } from './companionHost';
import { fold } from '../src/professional/state';
import { authorReview } from '../src/professional/authoring';
import { newId } from '../src/professional/bytes';

test('finding filters combine decision, open/closed, scope, search and snapshots; context links clear hiding filters', { timeout: 120000 }, async () => {
  const f = await findingFixture(), ctx = f.session.context(actor), original = fold(f.session.events, f.origin).threads[0];
  await f.session.save(ctx, f.session.makeEvent(ctx, { type: 'thread.reopened', threadId: 'finding_0', reason: 'Keep discussion open.', statusPredecessors: original.status.heads.map(event => event.id) }));
  for (const [index, document] of ['a.md', 'b.md'].entries()) {
    const anchor = fold(f.session.events, f.origin).threads[index].root.anchor;
    await f.session.save(ctx, f.session.makeEvent(ctx, { type: 'comment.created', threadId: `undecided_${index}`, commentId: `unassigned_comment_${index}`, anchor, body: { format: 'markdown', text: `No decision for ${document}` } }));
    if (index) await f.session.save(ctx, f.session.makeEvent(ctx, { type: 'thread.resolved', threadId: `undecided_${index}`, statusPredecessors: [] }));
  }
  // A second snapshot proves all-snapshot filtering isn't limited to the displayed text.
  const later = await authorReview({ source: f.source, store: f.root, rootDocument: 'a.md', actor, parents: [f.origin], operationId: newId('filter'), journalRoot: f.journalRoot, clientArtifact: f.created.browserClientPath, preserveClient: true });
  const before = (await f.store.list('events')).length;
  const options = { root: f.root, journalRoot: path.join(f.temp, 'filter-participant'), html: await readFile(path.resolve('dist/OpenMarkdownReview.html'), 'utf8') };
  const helper = process.env.OMR_TEST_COMPANION ? await startNativeCompanion(options, process.env.OMR_TEST_COMPANION) : await startCompanion(options);
  const browser = await chromium.launch({ headless: true, ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(helper.url); await page.locator('#workspace').waitFor();
    await page.locator('#actor-id').fill(actor.id); await page.locator('#actor-name').fill(actor.displayName);
    assert.equal(await page.locator('#revisions').inputValue(), later.revisionId);
    await page.locator('#decision-status').selectOption('undecided'); assert.equal(await page.locator('#threads > article').count(), 2);
    await page.locator('#discussion-status').selectOption('closed'); await page.locator('#thread-undecided_1').waitFor(); assert.equal(await page.locator('#threads > article').count(), 1);
    assert.match(await page.locator('#discussion-count').innerText(), /discussion: closed.*decision: no decision/);
    await page.locator('#discussion-status').selectOption('open'); await page.locator('#thread-undecided_0').waitFor();
    await page.locator('#discussion-search').fill('NOT_PRESENT'); assert.equal(await page.locator('#threads > article').count(), 0);
    await page.locator('#show-all-findings').click(); assert.equal(await page.locator('#threads > article').count(), 4);
    assert.equal(await page.locator('#decision-status').inputValue(), 'all'); assert.equal(await page.locator('#discussion-status').inputValue(), 'all');
    await page.locator('#decision-status').selectOption('accepted'); await page.locator('#discussion-status').selectOption('closed'); await page.locator('#thread-finding_1').waitFor(); assert.equal(await page.locator('#threads > article').count(), 1);
    await page.locator('#finding-snapshot-scope').selectOption('current'); assert.equal(await page.locator('#threads > article').count(), 0);
    await page.locator('#finding-snapshot-scope').selectOption('all'); await page.locator('#thread-finding_1').waitFor();
    await page.locator('#revisions').selectOption(f.origin); await page.locator('#document [data-thread-ids]').first().waitFor();
    await page.locator('#decision-status').selectOption('rejected'); assert.equal(await page.locator('#threads > article').count(), 0);
    await page.locator('#document [data-thread-ids]').first().click(); assert.ok(await page.locator('#threads > article').count() > 0, 'Opening highlighted context cannot be hidden by decision/discussion filters.');
    assert.equal(await page.locator('#decision-status').inputValue(), 'all'); assert.equal(await page.locator('#discussion-status').inputValue(), 'all');
    assert.equal((await f.store.list('events')).length, before, 'Filters and locating comments are read-only.');
  } finally { await browser.close(); await helper.close(); }
});
