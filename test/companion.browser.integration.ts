import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { chromium, Page } from 'playwright';
import { companionFixture } from './companion.fixture';
import { startCompanion } from './companionHost';
import { digest } from '../src/professional/bytes';
import { ReviewSession } from '../src/professional/session';
import { NativeStorage } from '../src/professional/nativeStorage';
import { nativeCompanion, nativeTarget } from './nativeCompanion';

async function saveDialog(page: Page, text: string) {
  await page.locator('#composer').waitFor({ state: 'visible' });
  await page.locator('#body').fill(text);
  await page.locator('#save').click();
  await page.locator('#composer').waitFor({ state: 'hidden', timeout: 60000 });
}
async function verifiedDialog(page: Page, text: string) {
  await page.locator('#composer').waitFor({ state: 'visible' }); await page.locator('#body').fill(text); await page.locator('#save').click();
  await page.waitForFunction(() => !((document.getElementById('composer') as HTMLDialogElement).open) || (document.getElementById('composer-error')?.textContent ?? '').includes('Press Save event again'), { timeout: 60000 });
  if (await page.locator('#composer').isVisible()) await page.locator('#save').click();
  await page.locator('#composer').waitFor({ state: 'hidden', timeout: 60000 });
}
test('real HTTP companion: blocked picker, two independent browser participants, rendering, live replies, lifecycle, completion and archival PDF', { timeout: 180000 }, async () => {
  const native = !!process.env.OMR_TEST_COMPANION;
  const f = await companionFixture(native ? { companionTargets: [nativeTarget()] } : {});
  if (native) { await f.helper.close(); f.helper = await nativeCompanion(f.root, path.join(f.temporary, 'native-user-one'), f.session.manifest.reviewId); }
  const peer = native ? await nativeCompanion(f.root, path.join(f.temporary, 'native-user-two'), f.session.manifest.reviewId) : await startCompanion({ root: f.root, journalRoot: path.join(f.temporary, 'peer-journal'), html: f.html });
  if (native) console.log(`Executing packaged ${nativeTarget()} companions delivered by review creation.`);
  const browser = await chromium.launch({ headless: true, channel: 'chromium', ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  const errors: string[] = [], externalRequests: string[] = [];
  const secondBlob = f.session.revision!.documents.find(document => document.path === 'second.md')!.blobPath;
  let releaseSecondDocument!: () => void, delayedReads = 0;
  const secondDocumentGate = new Promise<void>(resolve => { releaseSecondDocument = resolve; });
  try {
    const one = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), two = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    for (const context of [one, two]) {
      await context.addInitScript(() => {
        window.showDirectoryPicker = async () => { throw new DOMException('Managed filesystem access is blocked.', 'NotAllowedError'); };
      });
      await context.route(/^https?:\/\//, async route => {
        if (!route.request().url().startsWith(f.helper.origin + '/') && !route.request().url().startsWith(peer.origin + '/')) { externalRequests.push(route.request().url()); return route.abort(); }
        if (context === one && route.request().url() === f.helper.origin + '/api/rpc' && route.request().method() === 'POST') {
          const request = route.request().postDataJSON() as { method: string; args: unknown[] };
          if (request.method === 'read' && request.args[0] === secondBlob) { delayedReads++; await secondDocumentGate; }
        }
        return route.continue();
      });
    }
    const alex = await one.newPage(), sam = await two.newPage();
    for (const page of [alex, sam]) page.on('pageerror', error => errors.push(error.message));
    await Promise.all([alex.goto(f.helper.url), sam.goto(peer.url)]);
    for (const page of [alex, sam]) {
      await page.locator('#workspace').waitFor({ state: 'visible', timeout: 60000 });
      await page.locator('#open-progress').waitFor({ state: 'hidden', timeout: 60000 });
      assert.equal(await page.locator('#welcome').isVisible(), false);
      assert.equal(await page.locator('#companion-status').isVisible(), true);
      assert.ok(!(new URL(page.url()).hash), 'The per-launch capability leaves the address bar after session initialization.');
      await page.locator('#document table').waitFor({ state: 'visible' }); assert.equal(await page.locator('#document table').count(), 1);
      assert.ok(await page.locator('#document svg').count() >= 1, 'Mermaid renders offline through the same toolbox.');
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('#document img')].every(image => image.complete && image.naturalWidth > 0));
    }
    assert.match(await alex.locator('#reviewer-guidance').innerText(), /email address you were invited with/);
    await alex.locator('#documents [data-document="second.md"]').click();
    assert.equal(await alex.locator('[data-reading-document="second.md"]').count(), 0, 'The controlled slow read keeps the target absent until navigation is awaited.');
    // A click starts asynchronous rendering. Missing DOM is pending, not a test exception.
    const navigation = alex.waitForFunction(() => {
      const target = document.querySelector('[data-reading-document="second.md"]'), toolbar = document.getElementById('toolbar');
      return !!target && !!toolbar && Math.abs(target.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom - 12) < 3;
    });
    releaseSecondDocument(); await navigation;
    assert.ok(delayedReads > 0, 'Exercise the slow-document path instead of relying on a warmed content cache.');
    await alex.locator('#reading-back').click();
    await alex.locator('#documents [data-document="index.md"].active').waitFor();
    assert.equal(await alex.locator('#continuous-reading').isChecked(), true);
    await alex.locator('#actor-id').fill('alex@example.com'); await alex.locator('#actor-name').fill('Alex');
    assert.match(await alex.locator('#reviewer-guidance').innerText(), /Reviewing as alex@example.com/);
    await sam.locator('#actor-id').fill('sam@example.com'); await sam.locator('#actor-name').fill('Sam');
    await alex.evaluate(() => {
      const paragraph = [...document.querySelectorAll('#document p')].find(node => node.textContent?.startsWith('Frozen paragraph'))!;
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT), text = walker.nextNode()!, range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 'Frozen paragraph'.length);
      const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange'));
    });
    await alex.locator('#selection-comment').click(); await saveDialog(alex, 'Clarify this frozen paragraph.');
    await sam.waitForFunction(() => document.getElementById('threads')!.textContent!.includes('Clarify this frozen paragraph.'), { timeout: 20000 });
    assert.equal(await sam.locator('[data-action="resolve"]').count(), 0, 'Ordinary reviewers cannot close findings.');
    await sam.locator('[data-action="reply"]').first().click(); await saveDialog(sam, 'A concurrent reviewer can see and reply.');
    await alex.waitForFunction(() => document.getElementById('threads')!.textContent!.includes('A concurrent reviewer can see and reply.'), { timeout: 20000 });
    assert.ok(await alex.locator('#document .commented').count() || await alex.locator('#document mark').count(), 'Anchored feedback has a visible source highlight.');
    await alex.locator('#actor-id').fill(f.creator.id); await alex.locator('#actor-name').fill(f.creator.displayName);
    await alex.locator('[data-action="resolve"]').first().click(); await saveDialog(alex, 'Resolved by the initiator.');
    await sam.waitForFunction(() => !!document.querySelector('#threads .closed'), { timeout: 20000 });
    assert.equal(await sam.locator('[data-action="reply"]').count(), 0);
    await alex.locator('[data-action="reopen"]').first().click(); await saveDialog(alex, 'Reopened for clarification.');
    await sam.locator('[data-action="reply"]').first().waitFor({ state: 'visible', timeout: 20000 });
    await sam.locator('#approve').click(); await verifiedDialog(sam, 'The pinned revision is approved.');
    assert.equal(await sam.locator('#approve').isVisible(), false); assert.equal(await sam.locator('#withdraw').isVisible(), true);
    await sam.locator('#withdraw').click(); await verifiedDialog(sam, 'Withdrawn for an additional check.');
    await sam.locator('#finish-review').click(); await verifiedDialog(sam, 'My review is complete.');
    await alex.waitForFunction(() => !!document.querySelector('[data-reviewer-status="finished"]'), { timeout: 20000 });
    assert.equal(await alex.locator('[data-reviewer-status="finished"] .badge').first().evaluate(el => getComputedStyle(el).color), 'rgb(22, 101, 52)');
    assert.equal(await sam.locator('#comment').isDisabled(), true);
    await sam.locator('#reopen-review').click(); await saveDialog(sam, 'One additional check.');
    assert.equal(await sam.locator('#comment').isEnabled(), true);
    await sam.reload(); await sam.locator('#workspace').waitFor({ state: 'visible', timeout: 60000 });
    assert.equal(await sam.locator('#actor-id').inputValue(), 'sam@example.com', 'The helper remembers only the locally entered participant.');
    await alex.locator('#export').click();
    await alex.waitForFunction(() => document.getElementById('export-result')?.dataset.kind === 'success' || document.getElementById('export-result')?.dataset.kind === 'error', { timeout: 90000 });
    assert.equal(await alex.locator('#export-result').getAttribute('data-kind'), 'success', await alex.locator('#export-result-message').innerText());
    const verified = new ReviewSession(new NativeStorage(f.root, path.join(f.temporary, 'verification-journal'))); await verified.open();
    const exported = verified.events.find(event => event.type === 'export.created'); assert.ok(exported?.type === 'export.created');
    const bytes = await readFile(path.join(f.root, exported.pdf.path)); assert.equal(digest(bytes), exported.pdf.digest); assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    const download = alex.waitForEvent('download'); await alex.locator('#download-export').click(); assert.ok((await download).suggestedFilename().endsWith('.pdf'));
    assert.equal((await verified.audit(verified.context(f.creator))).inventory.policyResult, 'not-evaluated');
    await alex.locator('#export-mode').selectOption('clean'); await alex.locator('#export').click();
    await alex.waitForFunction(() => document.getElementById('export-result')?.dataset.kind === 'success' || document.getElementById('export-result')?.dataset.kind === 'error', { timeout: 90000 });
    assert.equal(await alex.locator('#export-result').getAttribute('data-kind'), 'success', await alex.locator('#export-result-message').innerText());
    const cleanDownload = alex.waitForEvent('download'); await alex.locator('#download-export').click(); assert.ok((await cleanDownload).suggestedFilename().endsWith('-document.pdf'));
    await verified.refresh(); assert.equal(verified.events.filter(e => e.type === 'export.created').length, 1, 'Clean output does not falsely assert an audit archive event.');
    await alex.reload(); await alex.locator('#workspace').waitFor({ state: 'visible', timeout: 60000 });
    await alex.locator('#export-mode').selectOption('clean'); await alex.locator('#export-result[data-kind="success"]').waitFor();
    assert.match(await alex.locator('#export-result-message').innerText(), /clean document PDF/);
    assert.ok(verified.events.some(e => e.type === 'review.completed')); assert.ok(verified.events.some(e => e.type === 'review.reopened'));
    assert.ok(verified.events.some(e => e.type === 'review.approved')); assert.ok(verified.events.some(e => e.type === 'review.withdrawn'));
    for (const filename of await readdir(path.join(f.root, 'events'))) { const eventBytes = await readFile(path.join(f.root, 'events', filename)); assert.equal(filename, `${digest(eventBytes).slice(7)}.json`); }
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
    await alex.evaluate(() => window.scrollTo(0, 0));
    const screenshot = path.join(f.temporary, 'companion-review.png'); await alex.screenshot({ path: screenshot });
    console.log(`Local companion UI evidence: ${screenshot}`);
    sam.on('dialog', dialog => { void dialog.accept(); }); await sam.locator('#stop-companion').click(); await peer.closed;
    // The process exit can arrive before the browser handles the stop response.
    await sam.waitForFunction(() => document.getElementById('status')?.textContent?.includes('stopped'));
    assert.match(await sam.locator('#status').innerText(), /stopped/);
  } finally { releaseSecondDocument(); await browser.close(); await peer.close(); await f.helper.close(); }
});
