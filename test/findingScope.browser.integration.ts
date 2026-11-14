import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { actor, findingFixture } from './findingPublication.fixture';
import { storageResponse } from '../src/professional/bridge';
import { FindingSelection } from '../src/professional/findingPublication';
import { FindingScopeChoice } from '../src/professional/findingScope';
import { startCompanion, startNativeCompanion } from './companionHost';
import { confirmPdfOptions } from './pdfExport.helpers';
import { fold } from '../src/professional/state';

test('guided new Markdown fix: explicit scope, added diff, one publication, participant navigation/comment and both frozen PDF modes', { timeout: 180000 }, async () => {
  const f = await findingFixture(), originalManifest = await readFile(path.join(f.root, 'manifest.json'));
  await mkdir(path.join(f.source, 'details'));
  await writeFile(path.join(f.source, 'a.md'), '# Design\n\nOriginal concern.\n\n[Implementation detail](details/new.md)\n');
  await writeFile(path.join(f.source, 'details/new.md'), '# Additional design\n\nNEW_DOCUMENT_BODY_MARKER.\n\n| Item | Value |\n| --- | --- |\n| New detail | 42 |\n\n```mermaid\nflowchart LR\n A[New detail] --> B[Outcome]\n```\n\n![Frozen image](picture.svg)\n\n[Back](../a.md)\n');
  await writeFile(path.join(f.source, 'details/picture.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="30"><rect width="60" height="30" fill="blue"/></svg>');
  await writeFile(path.join(f.source, 'unrelated.md'), '# Never included implicitly\n');
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, helper: Awaited<ReturnType<typeof startCompanion>> | undefined;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('omrHost', async (method: string, args: unknown[]) => {
      try {
        if (method === 'info') return { ok: true, value: { identity: f.store.identity, writable: true, canAuthorFindings: true, canApply: true, reviewer: actor } };
        if (method === 'prepareFindingPublication') return { ok: true, value: await f.publisher.prepareGuided(f.origin, actor, (args[3] as FindingScopeChoice | undefined)?.parents, undefined, undefined, args[3] as FindingScopeChoice | undefined) };
        if (method === 'discardFindingPublication') return { ok: true, value: await f.publisher.discard(f.origin, actor, String(args[2])) };
        if (method === 'finishFindingPublication') { const intent = args[2] as { operationId: string; selections: FindingSelection[] }; return { ok: true, value: await f.publisher.finish(intent.operationId, actor, intent.selections) }; }
        return storageResponse(f.store, method, args);
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    });
    await page.goto(pathToFileURL(f.created.browserClientPath).href); await page.locator('#workspace').waitFor();
    await page.locator('#thread-finding_0 [data-action=publish-fix]').click(); await page.locator('#finding-scope-dialog').waitFor();
    assert.equal(await page.locator('[data-scope-path="details/new.md"]').isChecked(), false);
    assert.equal(await page.locator('[data-scope-path="unrelated.md"]').count(), 0);
    assert.equal(await page.locator('[data-scope-continue]').isDisabled(), true);
    assert.match(await page.locator('[data-scope-problems]').innerText(), /details\/new.md/);
    await page.locator('[data-scope-cancel]').click(); await page.locator('#finding-scope-dialog').waitFor({ state: 'hidden' });
    assert.equal((await readdir(path.join(f.root, 'revisions'))).length, 1);
    await page.locator('#thread-finding_0 [data-action=publish-fix]').click(); await page.locator('#finding-scope-dialog').waitFor();
    await page.setViewportSize({ width: 352, height: 900 }); assert.equal(await page.locator('#finding-scope-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), true);
    await page.locator('[data-scope-include-references]').click(); assert.equal(await page.locator('[data-scope-continue]').isEnabled(), true);
    await page.locator('[data-scope-continue]').click(); await page.locator('#finding-publication-dialog').waitFor(); await page.setViewportSize({ width: 1400, height: 1000 });
    assert.match(await page.locator('[aria-label="Changed documents"]').innerText(), /1 added.*1 modified/);
    await page.locator('[data-diff-index] summary').filter({ hasText: 'details/new.md · Added' }).click(); await page.locator('.publication-diff').getByText(/NEW_DOCUMENT_BODY_MARKER/).waitFor();
    await page.locator('[data-publish]').click(); await page.locator('#finding-publication-dialog').waitFor({ state: 'hidden' });
    await f.session.refresh(); const fixed = fold(f.session.events, f.origin).threads[0], latest = fixed.addressed!.toRevisionId;
    assert.equal(f.session.revisions.size, 2); assert.equal(f.session.events.filter(event => event.type === 'thread.addressed').length, 1);
    assert.deepEqual(f.session.revisions.get(latest)!.documents.map(doc => doc.path), ['a.md', 'b.md', 'details/new.md']);
    const options = { root: f.root, journalRoot: path.join(f.temp, 'participant-scope'), html: await readFile(path.resolve('dist/OpenMarkdownReview.html'), 'utf8') };
    helper = process.env.OMR_TEST_COMPANION ? await startNativeCompanion(options, process.env.OMR_TEST_COMPANION) : await startCompanion(options);
    const participant = await browser.newPage({ viewport: { width: 1400, height: 1000 } }); participant.on('pageerror', error => errors.push(error.message));
    await participant.goto(helper.url); await participant.locator('#workspace').waitFor(); await participant.locator('#actor-id').fill('reviewer@example.com'); await participant.locator('#actor-name').fill('Reviewer');
    await participant.locator('[data-document-link="details/new.md"]').click(); await participant.locator('#document').getByText('NEW_DOCUMENT_BODY_MARKER.', { exact: true }).waitFor();
    assert.equal(await participant.locator('#document table').count(), 1); assert.equal(await participant.locator('#document .diagram svg').count(), 1);
    assert.equal(await participant.locator('#document img[data-resource]').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0)), true);
    await participant.evaluate(() => { const span = [...document.querySelectorAll('#document [data-source-map]')].find(node => node.textContent === 'NEW_DOCUMENT_BODY_MARKER.')!; const range = document.createRange(); range.setStart(span.firstChild!, 0); range.setEnd(span.firstChild!, span.textContent!.length); const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')); });
    await participant.locator('#selection-comment').click(); await participant.locator('#composer:visible').waitFor(); await participant.locator('#body').fill('Review comment on the newly added document.'); await participant.locator('#save').click(); await participant.locator('#composer').waitFor({ state: 'hidden' });
    await f.session.refresh(); assert.ok(f.session.events.some(event => event.type === 'comment.created' && event.revisionId === latest && event.anchor.document === 'details/new.md'));
    const inspect = await (new Function('specifier', 'return import(specifier)')(pathToFileURL(path.resolve('scripts/inspect-pdf.mjs')).href) as Promise<{ inspectPdf(bytes: Uint8Array): Promise<any> }>);
    for (const mode of ['review', 'clean'] as const) {
      await confirmPdfOptions(participant, mode); await participant.locator('#export-result[data-kind=success],#export-result[data-kind=error]').waitFor({ timeout: 90000 });
      assert.equal(await participant.locator('#export-result').getAttribute('data-kind'), 'success', await participant.locator('#export-result-message').innerText());
      const relative = (await participant.locator('#export-result-path').innerText()).match(/exports\/[a-f0-9]{64}\.pdf/)![0], pdf = await inspect.inspectPdf(await readFile(path.join(f.root, relative)));
      assert.ok(pdf.pages.some((page: { text: string }) => page.text.includes('NEW_DOCUMENT_BODY_MARKER')));
      if (mode === 'review') assert.ok(pdf.annotations.some((annotation: { contents: string }) => annotation.contents.includes('Review comment on the newly added document.')));
      else assert.equal(pdf.annotations.length, 0);
    }
    assert.deepEqual(await readFile(path.join(f.root, 'manifest.json')), originalManifest); assert.equal(fold(f.session.events, f.origin).threads.length, 2); assert.deepEqual(errors, []);
  } finally { await browser?.close(); await helper?.close(); }
});
