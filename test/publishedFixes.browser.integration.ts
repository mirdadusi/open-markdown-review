import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import type { PublishedFixChoice } from '../src/professional/publishedFixes';
import { actor, findingFixture, rewrite } from './findingPublication.fixture';
import { authorReview } from '../src/professional/authoring';
import { fold } from '../src/professional/state';
import { startCompanion, startNativeCompanion } from './companionHost';

test('snapshot details escape untrusted labels and load large implementation history only on demand', { timeout: 60000 }, async () => {
  const script = await build({ stdin: { contents: "import {mountPublishedFixPicker} from './src/professional/publishedFixPicker'; window.attachPicker=mountPublishedFixPicker;", resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', write: false });
  const browser = await chromium.launch({ headless: true, ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 352, height: 900 } });
    await page.setContent('<dialog id="composer" open><select id="test-choice"><option value="revision_exact_value">Snapshot 2</option></select><section id="test-details"></section></dialog>');
    await page.addStyleTag({ content: await readFile('media/professional.css', 'utf8') }); await page.addScriptTag({ content: script.outputFiles[0].text });
    const choice: PublishedFixChoice = { id: 'revision_exact_value', name: 'Snapshot 2', label: 'Snapshot 2', publishedAt: '10 Nov 2026, 12:34:56', author: '<img src=x onerror=alert(1)>', parents: ['Snapshot 1'], head: true, latest: true, changes: [{ path: 'details/long-document-name.md', kind: 'Added' }], resourceChanges: 0, policyChanged: false, originalDocumentChanged: false,
      fixes: Array.from({ length: 500 }, (_, index) => ({ threadId: `thread_${index}`, document: 'a.md', quote: '<svg onload=alert(1)>Concern 😃', summary: 'Updated wording 😃', status: 'Implemented' })) };
    await page.evaluate(choice => { const win=window as any; win.previewed=[]; win.detachPicker=win.attachPicker(document.getElementById('test-details'),document.getElementById('test-choice'),[choice],async(id:string)=>{win.previewed.push(id);}); }, choice);
    assert.equal(await page.locator('.snapshot-fix').count(), 0);
    await page.locator('[data-recorded-fixes]>summary').click(); await page.locator('.snapshot-fix').nth(19).waitFor(); assert.equal(await page.locator('.snapshot-fix').count(), 20);
    await page.locator('[data-more-fix-records]').click(); assert.equal(await page.locator('.snapshot-fix').count(), 40);
    assert.equal(await page.locator('#published-fix-summary img,#published-fix-summary svg,#published-fix-summary script').count(), 0);
    assert.ok(!(await page.locator('#published-fix-summary').innerText()).includes('\ufffd'));
    assert.equal(await page.locator('#composer').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), true);
    await page.locator('[data-preview-snapshot]').click(); assert.deepEqual(await page.evaluate(()=>(window as any).previewed), ['revision_exact_value']);
    const contents = await page.locator('#published-fix-summary').innerHTML();
    await page.evaluate(() => { (window as any).detachPicker(); const select=document.querySelector<HTMLSelectElement>('#test-choice')!;select.value='';select.dispatchEvent(new Event('change')); });
    assert.equal(await page.locator('#published-fix-summary').innerHTML(), contents, 'Closing/reusing the composer detaches old picker listeners and data.');
  } finally { await browser.close(); }
});

test('readable published-fix picker previews exact older snapshot and reuses it for another finding without creating a revision', { timeout: 120000 }, async () => {
  const f = await findingFixture(); await rewrite(f.source);
  const prepared = await f.publisher.prepare(f.origin, actor), fixed = await f.publisher.finish(prepared.operationId, actor, [{ threadId: 'finding_0', summary: 'Clarified the design and supporting chapter.' }]);
  await writeFile(path.join(f.source, 'b.md'), '# Later unrelated wording\n\nTHIS_IS_NOT_THE_SELECTED_SNAPSHOT.\n');
  const later = await authorReview({ source: f.source, store: f.root, rootDocument: 'a.md', include: ['a.md', 'b.md'], actor, parents: [fixed.revisionId], operationId: 'picker_later', journalRoot: f.journalRoot, clientArtifact: path.resolve('dist/OpenMarkdownReview.html'), preserveClient: true });
  const options = { root: f.root, journalRoot: path.join(f.temp, 'picker-participant'), html: await readFile(path.resolve('dist/OpenMarkdownReview.html'), 'utf8') };
  const helper = process.env.OMR_TEST_COMPANION ? await startNativeCompanion(options, process.env.OMR_TEST_COMPANION) : await startCompanion(options);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
    const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } }), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(helper.url); await page.locator('#workspace').waitFor(); await page.locator('#actor-id').fill(actor.id); await page.locator('#actor-name').fill(actor.displayName);
    const finding = page.locator('#thread-finding_1'), before = (await f.store.list('events')).length;
    await finding.locator('[data-action=record-addressed]').click(); await page.locator('#composer:visible').waitFor();
    assert.equal(await page.locator('#choice').inputValue(), '', 'Several candidates require an explicit choice, not an oldest/latest default.');
    const labels = await page.locator('#choice option').allTextContents(); assert.ok(labels.some(label => /Snapshot 2.*recorded fix/.test(label))); assert.ok(labels.some(label => /Snapshot 3.*latest/.test(label))); assert.ok(labels.every(label => !label.includes('revision_')));
    await page.locator('#save').click(); assert.equal((await f.store.list('events')).length, before, 'Empty selection cannot record a fix.');
    await page.locator('#choice').selectOption(fixed.revisionId!);
    assert.match(await page.locator('#published-fix-summary').innerText(), /Published by Review Initiator/); assert.match(await page.locator('#published-fix-summary').innerText(), /Modified: a.md/);
    assert.equal(await page.locator('[data-snapshot-audit]').evaluate((element: HTMLDetailsElement) => element.open), false);
    await page.locator('[data-recorded-fixes]>summary').click(); await page.locator('.snapshot-fix').getByText('Clarified the design and supporting chapter.').waitFor();
    await page.setViewportSize({ width: 352, height: 900 }); assert.equal(await page.locator('#composer').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), true);
    await page.locator('[data-preview-snapshot]').click(); await page.locator('#fix-inspection[data-ready=true]').waitFor();
    assert.match(await page.locator('#fix-inspection-title').innerText(), /Preview published snapshot/);
    assert.match(await page.locator('[data-implementation]').innerText(), /The whole second document changes too/); assert.doesNotMatch(await page.locator('[data-implementation]').innerText(), /THIS_IS_NOT_THE_SELECTED_SNAPSHOT/);
    assert.equal(await page.locator('#revisions').inputValue(), later.revisionId); assert.equal((await f.store.list('events')).length, before);
    await page.locator('[data-close]').click(); assert.equal(await page.locator('#choice').inputValue(), fixed.revisionId);
    await page.locator('#cancel').click(); assert.equal((await f.store.list('events')).length, before, 'Preview and cancellation write nothing.');
    await page.setViewportSize({ width: 1300, height: 1000 });
    await finding.locator('[data-action=record-addressed]').click(); await page.locator('#choice').selectOption(fixed.revisionId!); await page.locator('#save').click(); await page.locator('#composer').waitFor({ state: 'hidden' });
    await f.session.refresh(); assert.equal(fold(f.session.events, f.origin).threads[1].addressed!.toRevisionId, fixed.revisionId); assert.equal(f.session.revisions.size, 3);
    assert.equal(f.session.events.filter(event => event.type === 'thread.addressed').length, 2); assert.equal(await page.locator('#revisions').inputValue(), later.revisionId);
    // The shared generic composer must reset snapshot-only labels, validation and panels.
    const original = fold(f.session.events, f.origin).threads[0]; await f.session.save(f.session.context(actor, f.origin), f.session.makeEvent(f.session.context(actor, f.origin), { type: 'thread.reopened', threadId: original.root.threadId, reason: 'Independent discussion.', statusPredecessors: original.status.heads.map(event => event.id) }));
    await page.locator('#refresh').click(); await page.locator('#thread-finding_0 [data-action=resolve]').click();
    assert.equal(await page.locator('#published-fix-summary').count(), 0); assert.equal(await page.locator('#choice').evaluate((select: HTMLSelectElement) => select.required), false); await page.locator('#cancel').click();
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await helper.close(); }
});
