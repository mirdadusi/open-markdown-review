import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { commentFixture, initiator, owner } from './commentEdits.fixture';
import { startCompanion, startNativeCompanion } from './companionHost';
import type { CompanionOptions } from '../src/professional/companion';
import { authorReview } from '../src/professional/authoring';
import { fold } from '../src/professional/state';
const clientHost = (options: CompanionOptions) => process.env.OMR_TEST_COMPANION ? startNativeCompanion(options, process.env.OMR_TEST_COMPANION) : startCompanion(options);

test('participant edits own comments and replies on the original snapshot; other authors and closed discussions cannot edit', { timeout: 120000 }, async () => {
  const f = await commentFixture(); await writeFile(path.join(f.source, 'index.md'), '# New snapshot\n\nChanged source, original finding stays on its snapshot.\n');
  const next = await authorReview({ source: f.source, store: f.root, rootDocument: 'index.md', actor: initiator, operationId: 'edit_browser_next', parents: [f.origin], journalRoot: f.journal, clientArtifact: path.resolve('dist/OpenMarkdownReview.html') });
  const helper = await clientHost({ root: f.root, journalRoot: path.join(f.temp, 'client-journal'), html: await readFile(path.resolve('dist/OpenMarkdownReview.html'), 'utf8') });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
    const page = await browser.newPage(), errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(helper.url); await page.locator('#workspace').waitFor(); await page.locator('#actor-id').fill(owner.id); await page.locator('#actor-name').fill(owner.displayName);
    assert.equal(await page.locator('#revisions').inputValue(), next.revisionId);
    const rootEdit = page.locator('[data-action=edit-comment][data-comment=edit_comment]');
    assert.equal(await page.locator('[data-action=edit-comment]').count(), 2); assert.equal(await page.locator('[data-comment=other_reply]').count(), 0);
    await rootEdit.click(); assert.equal(await page.locator('#body').inputValue(), 'Original comment wording.');
    await page.locator('#body').fill('UI updated comment → český text.'); await page.locator('#save').click(); await page.locator('#composer').waitFor({ state: 'hidden' });
    await page.locator('#thread-edit_thread > .comment-body').getByText('UI updated comment → český text.', { exact: true }).waitFor();
    await page.locator('#thread-edit_thread > .comment-history').evaluate((details: HTMLDetailsElement) => { details.open = true; });
    assert.match(await page.locator('#thread-edit_thread > .comment-history').innerText(), /Original comment wording/);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.locator('[data-action=edit-comment][data-comment=edit_reply]').click(); await page.locator('#body').fill('UI updated reply.'); await page.locator('#save').click(); await page.locator('#composer').waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 1200, height: 950 });
    assert.equal(await page.locator('#revisions').inputValue(), next.revisionId);
    await f.session.refresh(); assert.equal(f.session.events.filter(e => e.type === 'comment.edited').length, 2); assert.ok(f.session.events.filter(e => e.type === 'comment.edited').every(e => e.revisionId === f.origin));
    assert.equal(fold(f.session.events, f.origin).comments.get('edit_reply')!.body.text, 'UI updated reply.');
    await page.locator('#actor-id').fill(initiator.id); await page.locator('#actor-name').fill(initiator.displayName);
    assert.equal(await page.locator('[data-action=edit-comment]').count(), 0, 'Initiator is not allowed to edit another author’s wording.');
    await page.locator('#thread-edit_thread [data-action=resolve]').click(); await page.locator('#save').click(); await page.locator('#composer').waitFor({ state: 'hidden' });
    await page.locator('#actor-id').fill(owner.id); await page.locator('#actor-name').fill(owner.displayName);
    assert.equal(await page.locator('[data-action=edit-comment]').count(), 0);
    assert.match(await page.locator('#thread-edit_thread .comment-edit-lock').first().innerText(), /initiator must reopen this closed discussion/); assert.deepEqual(errors, []);
  } finally { await browser?.close(); await helper.close(); }
});

test('older immutable packages offer honest correction replies, not undeclared edits or manifest rewrites', { timeout: 120000 }, async () => {
  const f = await commentFixture(true), manifest = await readFile(path.join(f.root, 'manifest.json'));
  const helper = await clientHost({ root: f.root, journalRoot: path.join(f.temp, 'old-client-journal'), html: await readFile(path.resolve('dist/OpenMarkdownReview.html'), 'utf8') });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
    const page = await browser.newPage(); await page.goto(helper.url); await page.locator('#workspace').waitFor(); await page.locator('#actor-id').fill(owner.id);
    assert.equal(await page.locator('[data-action=edit-comment]').count(), 0);
    await page.locator('[data-action=correct-comment][data-comment=edit_comment]').click(); assert.match(await page.locator('#composer-context').innerText(), /normal correction reply/);
    await page.locator('#body').fill('Corrected wording for the older review.'); await page.locator('#save').click(); await page.locator('#composer').waitFor({ state: 'hidden' });
    await f.session.refresh(); assert.equal(f.session.events.filter(e => e.type === 'comment.edited').length, 0);
    assert.ok(f.session.events.some(e => e.type === 'comment.replied' && e.inReplyTo === 'edit_comment' && e.body.text.includes('Corrected wording')));
    assert.equal(fold(f.session.events, f.origin).comments.get('edit_comment')!.body.text, 'Original comment wording.');
    assert.deepEqual(await readFile(path.join(f.root, 'manifest.json')), manifest);
  } finally { await browser?.close(); await helper.close(); }
});
