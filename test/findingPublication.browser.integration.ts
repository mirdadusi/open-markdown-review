import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { actor, findingFixture, rewrite } from './findingPublication.fixture';
import { storageResponse } from '../src/professional/bridge';
import { NativeStorage } from '../src/professional/nativeStorage';
import { decode } from '../src/professional/bytes';
import { FindingSelection } from '../src/professional/findingPublication';
import { fold } from '../src/professional/state';
import { startCompanion } from './companionHost';
import { ReviewSession } from '../src/professional/session';

test('guided workbench: whole-document editing, partial retry, rendered/source inspection and explicit reopen', { timeout: 120000 }, async () => {
  const f = await findingFixture(); await rewrite(f.source);
  const browser = await chromium.launch({ headless: true, ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    let failRecord = true;
    await page.exposeFunction('omrHost', async (method: string, args: unknown[]) => {
      try {
        if (method === 'info') return { ok: true, value: { identity: f.store.identity, writable: true, canAuthorFindings: true, canApply: true, reviewer: actor } };
        if (method === 'prepareFindingPublication') return { ok: true, value: await f.publisher.prepare(String(args[0]), args[1] as typeof actor) };
        if (method === 'discardFindingPublication') return { ok: true, value: await f.publisher.discard(String(args[0]), args[1] as typeof actor, String(args[2])) };
        if (method === 'finishFindingPublication') {
          const intent = args[2] as { operationId: string; selections: FindingSelection[] }, write = NativeStorage.prototype.write;
          NativeStorage.prototype.write = async function(file, bytes, recover) {
            if (failRecord && this.identity === f.store.identity && file.startsWith('events/') && JSON.parse(decode(bytes)).type === 'thread.addressed') { failRecord = false; throw new Error('Simulated disconnection before the finding record.'); }
            return write.call(this, file, bytes, recover);
          };
          try { return { ok: true, value: await f.publisher.finish(intent.operationId, args[1] as typeof actor, intent.selections) }; }
          finally { NativeStorage.prototype.write = write; }
        }
        return storageResponse(f.store, method, args);
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    });
    await page.goto(pathToFileURL(f.created.browserClientPath).href); await page.locator('#workspace').waitFor();
    const finding = page.locator('#thread-finding_0'); await finding.waitFor();
    assert.match(await finding.innerText(), /Discussion: closed/); assert.match(await finding.innerText(), /Change required/);
    assert.equal(await finding.locator('[data-action=reply], [data-action=decide]').count(), 0);
    await finding.locator('[data-action=publish-fix]').click();
    await page.locator('#finding-publication-dialog').waitFor();
    assert.match(await page.locator('.publication-diff').first().innerText(), /completely rewritten/);
    assert.match(await page.locator('#finding-publication-dialog').innerText(), /multiple documents/);
    assert.equal(await page.locator('[data-finding="finding_0"] [data-selected]').isChecked(), true);
    assert.equal(await page.locator('[data-finding="finding_1"] [data-selected]').isChecked(), false);
    await page.setViewportSize({ width: 352, height: 900 });
    assert.ok(await page.locator('#finding-publication-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), 'Publication confirmation reflows without horizontal clipping.');
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(await page.locator('[data-finding="finding_0"] [data-summary]').inputValue(), '', 'Implementation note may be left blank.');
    await page.locator('[data-publish]').click();
    await page.waitForFunction(() => document.querySelector('[data-publish]')?.textContent === 'Retry pending records');
    assert.match(await page.locator('#publication-outcome').innerText(), /no additional revision/);
    assert.equal((await readdir(path.join(f.root, 'revisions'))).length, 2);
    await writeFile(path.join(f.source, 'a.md'), '# A later, private edit after publication\n');
    await page.locator('[data-publish]').click(); await page.locator('#finding-publication-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#revisions').inputValue(), f.origin);
    assert.equal((await readdir(path.join(f.root, 'revisions'))).length, 2, 'Retry does not capture the later source or create a third revision.');
    assert.match(await finding.innerText(), /Processing finished/);
    assert.deepEqual(await finding.locator('[data-primary-actions] button').evaluateAll(buttons => buttons.map(button => (button as HTMLElement).dataset.action)), ['open-addressed', 'reopen-finding']);
    assert.equal(await finding.locator('[data-action=publish-fix], [data-action=verify-addressing], [data-action=reopen]').count(), 0);
    assert.match(await page.locator('#thread-finding_1').innerText(), /Change required/);
    await finding.locator('[data-action=open-addressed]').click(); await page.locator('#fix-inspection[data-ready="true"]').waitFor();
    assert.match(await page.locator('[data-original]').innerText(), /Original concern/);
    assert.match(await page.locator('[data-implementation]').innerText(), /completely rewritten/);
    await page.locator('#fix-document').selectOption('b.md');
    await page.locator('[data-implementation]').getByText('The whole second document changes too.').waitFor();
    assert.equal(await page.locator('#revisions').inputValue(), f.origin);
    await page.locator('#fix-view').selectOption('source'); await page.locator('[data-implementation] pre').getByText(/# Reorganized chapter/).waitFor();
    assert.equal(await page.locator('[data-verify]').count(), 0);
    await page.locator('[data-close]').click();
    await f.session.refresh(); assert.equal(f.session.events.filter(e => e.type === 'thread.addressed').length, 1);
    assert.match(fold(f.session.events, f.origin).threads[0].addressed!.summary, /Implementation recorded in published snapshot .* for a\.md\./);
    assert.equal(f.session.events.filter(e => e.type === 'thread.verification.recorded').length, 0);
    await finding.locator('[data-action=reopen-finding]').click(); await page.locator('#body').fill('The new explanation needs a further correction.'); await page.locator('#save').click(); await page.locator('#composer').waitFor({ state: 'hidden' });
    await finding.locator('[data-change-state=challenged]').waitFor(); assert.match(await finding.innerText(), /Discussion: open/);
    assert.equal(await finding.locator('[data-action=publish-fix]').count(), 1);
    const output = path.resolve('output/finding-workflow'); await mkdir(output, { recursive: true }); await page.screenshot({ path: path.join(output, 'guided-recorded.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('rendered comparison includes frozen tables, Mermaid and SVG; source is escaped and historical replies stay on origin', { timeout: 120000 }, async () => {
  const f = await findingFixture(undefined, true);
  const original = await readFile(path.join(f.source, 'a.md'), 'utf8');
  await writeFile(path.join(f.source, 'a.md'), original.replace('Original concern.', 'Updated concern.').replace('| Original | 1 |', '| Updated | 2 |').replace('A[Original]', 'A[Updated]'));
  const preview = await f.publisher.prepare(f.origin, actor), result = await f.publisher.finish(preview.operationId, actor, [{ threadId: 'finding_0', summary: 'Updated explanation, table and diagram.' }]);
  await f.session.refresh(); const ctx = f.session.context(actor, f.origin), status = fold(f.session.events, f.origin).threads[1].status;
  await f.session.save(ctx, f.session.makeEvent(ctx, { type: 'thread.reopened', threadId: 'finding_1', reason: 'Continue this separate concern.', statusPredecessors: status.heads.map(e => e.id) }));
  const helper = await startCompanion({ root: f.root, journalRoot: path.join(f.temp, 'rich-participant'), html: await readFile(path.resolve('dist/OpenMarkdownReview.html'), 'utf8') });
  const browser = await chromium.launch({ headless: true, ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message)); await page.goto(helper.url); await page.locator('#workspace').waitFor();
    await page.locator('#actor-id').fill('reviewer@example.com'); await page.locator('#actor-name').fill('Reviewer');
    assert.equal(await page.locator('#revisions').inputValue(), result.revisionId);
    await page.locator('#thread-finding_0 [data-action=open-addressed]').click(); await page.locator('#fix-inspection[data-ready=true]').waitFor();
    for (const pane of ['[data-original]', '[data-implementation]']) {
      assert.equal(await page.locator(`${pane} table`).count(), 1); assert.equal(await page.locator(`${pane} .diagram svg`).count(), 1);
      assert.equal(await page.locator(`${pane} img[data-resource]`).evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0)), true);
    }
    assert.match(await page.locator('[data-original] table').innerText(), /Original/); assert.match(await page.locator('[data-implementation] table').innerText(), /Updated/);
    await page.locator('#fix-view').selectOption('source'); await page.locator('[data-implementation] pre').getByText(/A\[Updated\]/).waitFor();
    assert.equal(await page.locator('[data-implementation] table, [data-implementation] svg').count(), 0);
    await page.locator('#fix-view').selectOption('rendered'); await page.locator('#fix-view').selectOption('source');
    await page.locator('#fix-inspection[data-ready=true]').waitFor(); assert.equal(await page.locator('[data-implementation] pre').count(), 1, 'A cancelled render cannot replace the selected source mode.');
    await page.locator('#fix-view').selectOption('rendered'); await page.locator('#fix-inspection[data-ready=true]').waitFor();
    await page.locator('[data-implementation] [data-document-link]').click(); await page.locator('[data-implementation]').getByText('Old chapter.', { exact: true }).waitFor();
    assert.equal(await page.locator('#revisions').inputValue(), result.revisionId);
    await page.setViewportSize({ width: 352, height: 900 });
    assert.ok(await page.locator('#fix-inspection').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1));
    await page.locator('[data-close]').click(); await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#thread-finding_1 [data-action=reply]').click(); await page.locator('#body').fill('Reply on the original snapshot while reading the latest document.'); await page.locator('#save').click(); await page.locator('#composer').waitFor({ state: 'hidden' });
    const fresh = new ReviewSession(f.store); await fresh.open(); const reply = fresh.events.find(e => e.type === 'comment.replied');
    assert.equal(reply?.revisionId, f.origin); assert.equal(reply?.revisionDigest, ctx.publication.revisionDigest);
    assert.equal(await page.locator('#revisions').inputValue(), result.revisionId);
    assert.equal(fold(fresh.events, result.revisionId).threads.length, 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await helper.close(); }
});

test('participant browser: review-wide findings, fixed-snapshot inspection, origin navigation and remembered view', { timeout: 120000 }, async () => {
  const f = await findingFixture(); await rewrite(f.source); const prepared = await f.publisher.prepare(f.origin, actor);
  await f.publisher.finish(prepared.operationId, actor, [{ threadId: 'finding_0', summary: 'Reorganized both documents.' }]);
  await f.session.refresh(); const completedCtx = f.session.context(actor, f.origin), audit = await f.session.audit(completedCtx);
  await f.session.save(completedCtx, f.session.makeEvent(completedCtx, { type: 'review.completed', completionPredecessors: [], verification: await f.session.verificationBlob(audit, 'finished_origin') }));
  const helper = await startCompanion({ root: f.root, journalRoot: path.join(f.temp, 'participant'), html: await readFile(path.resolve('dist/OpenMarkdownReview.html'), 'utf8') });
  const browser = await chromium.launch({ headless: true, ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(helper.url); await page.locator('#workspace').waitFor();
    const latest = await page.locator('#revisions').inputValue(); assert.notEqual(latest, f.origin);
    await page.locator('#actor-id').fill(actor.id); await page.locator('#actor-name').fill(actor.displayName);
    const untouched = page.locator('#thread-finding_1'); await untouched.waitFor();
    assert.match(await untouched.innerText(), /Continue in VS Code/);
    assert.equal(await page.locator('#publish-documents').isVisible(), false);
    assert.equal(await page.locator('[data-action=publish-fix]').count(), 0);
    assert.equal(await page.locator('[data-action=reveal-source], [data-action=link-source]').count(), 0, 'Participant hosts do not acquire native source discovery capabilities.');
    await page.locator('#actor-id').fill('reviewer@example.com'); await page.locator('#actor-name').fill('Independent Reviewer');
    await page.locator('#thread-finding_0 [data-action=open-addressed]').click(); await page.locator('#fix-inspection[data-ready="true"]').waitFor();
    assert.equal(await page.locator('#revisions').inputValue(), latest);
    assert.match(await page.locator('[data-implementation]').innerText(), /completely rewritten/);
    assert.equal(await page.locator('[data-verify]').count(), 0);
    await page.locator('[data-close]').click();
    assert.match(await page.locator('#thread-finding_0 .finding-origin').innerText(), /From another snapshot/);
    assert.equal(await page.locator('#thread-finding_0 [data-action=resolve]').count(), 0);
    assert.equal(await page.locator('#thread-finding_0 [data-action=reopen-finding]').count(), 0, 'Participant cannot reopen implementation.');
    await page.locator('#finding-snapshot-scope').selectOption('current');
    assert.equal(await page.locator('#threads .thread').count(), 0); assert.match(await page.locator('#finding-snapshot-notice').innerText(), /2 finding.*hidden/);
    await page.locator('#show-all-findings').click(); assert.equal(await page.locator('#threads .thread').count(), 2);
    await page.locator('#thread-finding_0 [data-action=locate]').click();
    await page.locator('#document').getByText('Original concern.', { exact: true }).waitFor();
    assert.equal(await page.locator('#revisions').inputValue(), f.origin);
    await page.reload(); await page.locator('#workspace').waitFor();
    assert.equal(await page.locator('#revisions').inputValue(), f.origin, 'Private view preference survives reopen.');
    assert.equal(await page.locator('#threads .thread').count(), 2);
    await page.locator('#actor-id').fill(actor.id); await page.locator('#actor-name').fill(actor.displayName);
    await page.locator('#thread-finding_0 [data-action=reopen-finding]').click(); await page.locator('#body').fill('A further change is needed after implementation.'); await page.locator('#save').click(); await page.locator('#composer').waitFor({ state: 'hidden' });
    await page.locator('#thread-finding_0 [data-change-state=challenged]').waitFor();
    await f.session.refresh(); assert.equal(fold(f.session.events, f.origin).register(`completion:${f.origin}:${actor.id}`).heads[0].type, 'review.completed', 'Finding rework does not silently reopen participant completion.');
  } finally { await browser.close(); await helper.close(); }
});
