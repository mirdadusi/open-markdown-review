import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { authorReview } from '../src/professional/authoring';
import { NativeStorage } from '../src/professional/nativeStorage';
import { ReviewSession } from '../src/professional/session';
import { fold, threadWorkflowQueue } from '../src/professional/state';
import { startCompanion, startNativeCompanion } from './companionHost';
import { confirmPdfOptions } from './pdfExport.helpers';
import { actor, findingFixture, rewrite } from './findingPublication.fixture';

async function host(root: string, journalRoot: string) {
  const options = { root, journalRoot, html: await readFile(path.resolve('dist/OpenMarkdownReview.html'), 'utf8') };
  return process.env.OMR_TEST_COMPANION ? startNativeCompanion(options, process.env.OMR_TEST_COMPANION) : startCompanion(options);
}

test('reader and both PDF modes share frozen chapter order across folders without changing review evidence', { timeout: 180000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'omr-chapter-order-')), source = path.join(temp, 'source'), root = path.join(temp, 'review');
  await mkdir(path.join(source, 'sections'), { recursive: true }); await mkdir(path.join(source, 'features'));
  const paths = ['sections/00-index.md', 'sections/01-scope.md', 'features/02-feature.md', 'features/10-feature.md', 'sections/20-appendix.md'];
  const markers = ['INDEX_ORDER_MARKER', 'SCOPE_ORDER_MARKER', 'FEATURE_TWO_MARKER', 'FEATURE_TEN_MARKER', 'APPENDIX_ORDER_MARKER'];
  for (const [index, name] of paths.entries()) await writeFile(path.join(source, name), `# ${markers[index]}\n\n${markers[index]}_BODY\n\n${index === 0 ? '[1 Scope](01-scope.md) [2 Feature](../features/02-feature.md) [10 Feature](../features/10-feature.md) [20 Appendix](20-appendix.md)\n\n' : ''}${Array.from({ length: 30 }, (_, number) => `Paragraph ${number + 1}.`).join('\n\n')}\n`);
  await authorReview({ source, store: root, rootDocument: paths[0], actor, operationId: 'chapter_order', clientArtifact: path.resolve('dist/OpenMarkdownReview.html'), journalRoot: path.join(temp, 'author') });
  const store = new NativeStorage(root, path.join(temp, 'verify')), session = new ReviewSession(store); await session.open();
  const manifest = await readFile(path.join(root, 'manifest.json')), revision = await readFile(path.join(root, 'revisions', `${session.revision!.id}.json`));
  const before = await readdir(path.join(root, 'events')), helper = await host(root, path.join(temp, 'participant'));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
    const page = await browser.newPage({ viewport: { width: 1450, height: 1000 } }); await page.goto(helper.url); await page.locator('#workspace').waitFor();
    await page.locator('#actor-id').fill(actor.id); await page.locator('#actor-name').fill(actor.displayName);
    assert.deepEqual(await page.locator('#documents [data-document]').evaluateAll(buttons => buttons.map(button => (button as HTMLElement).dataset.document)), paths);
    const expectChapter = async (index: number) => {
      // Continuous reading mounts adjacent headings before they become active.
      try { await page.locator(`#reading-position[title="${paths[index]}"]`).waitFor(); }
      catch (cause) {
        const position = await page.evaluate(() => ({
          active: document.getElementById('reading-position')?.title,
          y: scrollY,
          toolbarBottom: document.getElementById('toolbar')?.getBoundingClientRect().bottom,
          mounted: Array.from(document.querySelectorAll<HTMLElement>('[data-reading-document]'), section => [section.dataset.readingDocument, Math.round(section.getBoundingClientRect().top)]),
        }));
        throw new Error(`Expected chapter ${paths[index]}; reader position: ${JSON.stringify(position)}`, { cause });
      }
      await page.locator('#document').getByRole('heading', { name: markers[index], exact: true }).waitFor();
    };
    await page.locator('#reading-next').click(); await expectChapter(1);
    assert.equal(await page.locator('#reading-position').innerText(), '2 / 5');
    await page.locator('#continuous-reading').check();
    await page.locator('#reading-next').click(); await expectChapter(2);
    await page.locator('#reading-previous').click(); await expectChapter(1);
    const inspect = await (new Function('specifier', 'return import(specifier)')(pathToFileURL(path.resolve('scripts/inspect-pdf.mjs')).href) as Promise<{ inspectPdf(bytes: Uint8Array): Promise<any> }>);
    for (const mode of ['review', 'clean'] as const) {
      await confirmPdfOptions(page, mode); await page.locator('#export-result[data-kind=success],#export-result[data-kind=error]').waitFor({ timeout: 90000 });
      assert.equal(await page.locator('#export-result').getAttribute('data-kind'), 'success', await page.locator('#export-result-message').innerText());
      const file = (await page.locator('#export-result-path').innerText()).match(/exports\/[a-f0-9]{64}\.pdf/)![0];
      const pdf = await inspect.inspectPdf(await readFile(path.join(root, file)));
      const positions = markers.map(marker => pdf.pages.findIndex((page: { text: string }) => page.text.includes(marker + '_BODY')));
      assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])), `${mode}: chapters must be ordered in the actual PDF (${positions}).`);
      assert.ok(String(pdf.metadata.Keywords ?? '').includes('omr-document-order-v1') || mode === 'review');
    }
    await session.refresh(); assert.equal(session.events.length, before.length + 1, 'Only the review-mode export adds an audit event.');
    assert.deepEqual(await readFile(path.join(root, 'manifest.json')), manifest); assert.deepEqual(await readFile(path.join(root, 'revisions', `${session.revision!.id}.json`)), revision);
  } finally { await browser?.close(); await helper.close(); }
});

test('initiator closes an implemented open discussion with no note, without changing implementation or completion', { timeout: 90000 }, async () => {
  const f = await findingFixture(); await rewrite(f.source);
  const ctx = f.session.context(actor), thread = fold(f.session.events, f.origin).threads[0];
  await f.session.save(ctx, f.session.makeEvent(ctx, { type: 'thread.reopened', threadId: thread.root.threadId, reason: 'Discuss before implementation.', statusPredecessors: thread.status.heads.map(event => event.id) }));
  const preview = await f.publisher.prepare(f.origin, actor); await f.publisher.finish(preview.operationId, actor, [{ threadId: thread.root.threadId }]); await f.session.refresh();
  const previous = fold(f.session.events, f.origin).threads[0].addressed!.id, eventCount = f.session.events.length;
  const helper = await host(f.root, path.join(f.temp, 'close-participant'));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
    const page = await browser.newPage({ viewport: { width: 1450, height: 1000 } }); await page.goto(helper.url); await page.locator('#workspace').waitFor();
    await page.locator('#actor-id').fill('reviewer@example.com'); await page.locator('#actor-name').fill('Reviewer');
    assert.equal(await page.locator('#thread-finding_0 [data-action=resolve]').count(), 0);
    await page.locator('#actor-id').fill(actor.id); await page.locator('#actor-name').fill(actor.displayName);
    await page.locator('#thread-finding_0 [data-action=resolve]').click(); assert.equal(await page.locator('#body').inputValue(), ''); await page.locator('#save').click(); await page.locator('#composer').waitFor({ state: 'hidden' });
    await f.session.refresh(); const closed = fold(f.session.events, f.origin).threads[0];
    assert.equal(closed.open, false); assert.equal(closed.addressed!.id, previous); assert.equal(threadWorkflowQueue(closed), 'implemented');
    assert.equal(f.session.events.length, eventCount + 1); assert.equal(f.session.events.at(-1)!.type, 'thread.resolved');
    assert.equal(await page.locator('#thread-finding_0 [data-action=resolve]').count(), 0);
    assert.equal(await page.locator('#thread-finding_0 [data-action=reopen-finding]').count(), 1);
  } finally { await browser?.close(); await helper.close(); }
});
