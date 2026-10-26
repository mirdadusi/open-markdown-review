import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, Page } from 'playwright';
import { authorReview } from '../src/professional/authoring';
import { NativeStorage } from '../src/professional/nativeStorage';
import { storageResponse } from '../src/professional/bridge';
import { ReviewSession } from '../src/professional/session';
import { pointAt } from '../src/professional/bytes';

async function beginning(page: Page, path: string) {
  await page.waitForFunction(path => {
    const section = [...document.querySelectorAll<HTMLElement>('[data-reading-document]')].find(e => e.dataset.readingDocument === path);
    return section && Math.abs(section.getBoundingClientRect().top - document.getElementById('toolbar')!.getBoundingClientRect().bottom - 12) < 3;
  }, path);
}
async function compactReadingToolbar(page: Page, evidence: string, mode: string) {
  assert.equal(await page.locator('#toolbar > #reader-navigation').count(), 1, 'Reading controls share the existing action bar.');
  assert.equal(await page.locator('main #reader-navigation').count(), 0, 'No extra header occupies the document column.');
  assert.equal(await page.locator('#export').evaluate(button => button.nextElementSibling?.id), 'reader-navigation');
  assert.equal(await page.locator('#reader-navigation').getAttribute('role'), 'group');
  assert.equal(await page.locator('#reader-navigation').getAttribute('aria-label'), 'Document reading');
  assert.equal(await page.locator('#continuous-reading').getAttribute('aria-describedby'), 'continuous-help');
  assert.match(await page.locator('#continuous-reading').getAttribute('title') ?? '', /does not finish your review/);
  assert.equal(await page.locator('#reading-position').innerText(), '1 / 6');
  assert.equal(await page.locator('#reading-position').getAttribute('title'), 'a.md');
  assert.equal(await page.locator('#reading-position').getAttribute('aria-label'), 'Document 1 of 6: a.md');
  assert.equal(await page.getByRole('status', { name: 'Document 1 of 6: a.md' }).count(), 1, 'The current document is named in the accessibility tree without live scroll announcements.');
  assert.equal(await page.locator('#reading-back').isDisabled(), true);
  assert.equal(await page.locator('#reading-previous').isDisabled(), true);
  for (const width of [1440, 1024, 640, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const toolbar = document.getElementById('toolbar')!.getBoundingClientRect();
      const controls = [...document.querySelectorAll<HTMLElement>('#reader-navigation button, #reading-position, #reader-navigation label')].map(el => {
        const box = el.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      });
      return { left: toolbar.left, right: toolbar.right, top: toolbar.top, bottom: toolbar.bottom, controls, direction: getComputedStyle(document.querySelector('#reader-navigation label')!).flexDirection };
    });
    assert.equal(layout.direction, 'row', 'The checkbox and its text stay inline.');
    if (width <= 850) {
      await page.locator('.discussion').scrollIntoViewIfNeeded();
      const panels = await page.evaluate(() => ({ documents: document.querySelector('.documents')!.getBoundingClientRect().bottom, discussion: document.querySelector('.discussion')!.getBoundingClientRect().top }));
      assert.ok(panels.documents <= panels.discussion + 1, `Document navigation cannot stick over the stacked discussion panel at ${width}px.`);
      await page.locator('#documents [data-document="a.md"]').click(); await beginning(page, 'a.md');
    }
    for (const box of layout.controls) {
      assert.ok(box.left >= layout.left && box.right <= layout.right && box.top >= layout.top && box.bottom <= layout.bottom,
        `Reading controls remain within the existing toolbar at ${width}px.`);
    }
    if (width === 1440 || width === 640) await page.locator('#toolbar').screenshot({ path: path.join(evidence, `toolbar-${mode}-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
for (const mode of ['vscode-bridge', 'browser-directory'] as const) test(`${mode}: document top, heading, back, bounded continuous reading and factual email guidance`, { timeout: 120000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'omr-reader-')), source = path.join(temp, 'source'), root = path.join(temp, 'review');
  await mkdir(path.join(source, 'nested'), { recursive: true });
  const texts = new Map<string, string>();
  for (let i = 0; i < 6; i++) {
    const name = i === 1 ? 'nested/b.md' : `${String.fromCharCode(97 + i)}.md`;
    const links = i === 0 ? '[Other document](nested/b.md) · [Heading reference](nested/b.md#target-heading)\n\n' : i === 1 ? '[Sibling from nested](../c.md)\n\n' : '';
    const text = `# Document ${i + 1}\n\n${links}${Array.from({ length: 55 }, (_, n) => `${n === 35 ? '## Target heading\n\n' : ''}Document ${i + 1}, paragraph ${n + 1}, exact review passage.`).join('\n\n')}\n\nLast passage ${i + 1}.\n`;
    texts.set(name, text); await writeFile(path.join(source, name), text);
  }
  const creator = { id: 'initiator' }, created = await authorReview({ source, store: root, rootDocument: 'a.md', actor: creator, reviewerEmails: ['alex@example.com'], operationId: 'reader_fixture', journalRoot: path.join(temp, 'journal'), clientArtifact: path.resolve('dist/OpenMarkdownReview.html') });
  const store = new NativeStorage(root, path.join(temp, 'client-journal'));
  const initial = new ReviewSession(store); await initial.open();
  const order = ['a.md', ...initial.revision!.documents.map(d => d.path).filter(p => p !== 'a.md')];
  const browser = await chromium.launch({ headless: true, channel: 'chromium', ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    if (mode === 'vscode-bridge') {
      await page.exposeFunction('omrHost', async (method: string, args: unknown[]) => method === 'info' ? { ok: true, value: { identity: store.identity, writable: true } } : storageResponse(store, method, args));
      await page.goto(pathToFileURL(created.browserClientPath).href);
    } else {
      const html = await readFile(created.browserClientPath, 'utf8');
      await context.route('https://reader.invalid/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      await page.addInitScript(() => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('review', { create: true }); });
      await page.goto('https://reader.invalid/review');
      const files: Array<{ path: string; bytes: number[] }> = [];
      const collect = async (dir: string) => { for (const file of await readdir(path.join(root, dir), { withFileTypes: true })) { const name = dir ? `${dir}/${file.name}` : file.name; if (file.isDirectory()) await collect(name); else if (!name.endsWith('.html')) files.push({ path: name, bytes: [...await readFile(path.join(root, name))] }); } };
      await collect('');
      await page.evaluate(async files => {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('review', { create: true });
        for (const file of files) { const parts = file.path.split('/'), name = parts.pop()!; let parent = root; for (const segment of parts) parent = await parent.getDirectoryHandle(segment, { create: true }); const writer = await (await parent.getFileHandle(name, { create: true })).createWritable(); await writer.write(new Uint8Array(file.bytes)); await writer.close(); }
      }, files);
      await page.locator('#connect').click();
    }
    await page.waitForSelector('#document [data-source-map]');
    assert.match(await page.locator('#reviewer-guidance').innerText(), /email address you were invited with/);
    assert.equal(await page.locator('#comment').isDisabled(), true);
    await page.locator('#set-reviewer').click(); assert.equal(await page.locator('#actor-id').evaluate(e => e === document.activeElement), true);
    await page.locator('#actor-id').fill('outsider@example.com'); assert.equal(await page.locator('#actor-id').getAttribute('aria-invalid'), 'true');
    assert.match(await page.locator('#reviewer-guidance').innerText(), /not on the reviewer list/);
    await page.locator('#actor-id').fill('ALEX@EXAMPLE.COM'); assert.match(await page.locator('#reviewer-guidance').innerText(), /Reviewing as alex@example.com/);
    assert.equal(await page.locator('#comment').isEnabled(), true);
    assert.match(await page.locator('#identity-help').innerText(), /self-asserted/);
    await compactReadingToolbar(page, temp, mode);
    await page.locator('#continuous-reading').uncheck();
    await page.locator('#reading-next').click(); await beginning(page, order[1]);
    assert.equal(await page.locator('#reading-position').innerText(), '2 / 6');
    assert.equal(await page.locator('#reading-position').getAttribute('title'), order[1]);
    await page.locator('#reading-previous').click(); await beginning(page, 'a.md');
    await page.locator('[data-reading-document="a.md"] h2').scrollIntoViewIfNeeded();
    await page.locator('#documents [data-document="nested/b.md"]').click(); await beginning(page, 'nested/b.md');
    await page.locator('[data-reading-document="nested/b.md"] h2').scrollIntoViewIfNeeded();
    await page.locator('#documents [data-document="nested/b.md"]').click(); await beginning(page, 'nested/b.md');
    await page.locator('#documents [data-document="a.md"]').click(); await beginning(page, 'a.md');
    await page.locator('[data-document-link="nested/b.md#target-heading"]').click();
    await page.waitForFunction(() => Math.abs(document.querySelector('[data-reading-document="nested/b.md"] h2')!.getBoundingClientRect().top - document.getElementById('toolbar')!.getBoundingClientRect().bottom - 12) < 3);
    await page.locator('#reading-back').click(); await beginning(page, 'a.md');
    await page.locator('[data-reading-document="a.md"] p').filter({ hasText: 'paragraph 30,' }).scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => window.scrollY);
    await page.locator('#documents [data-document="c.md"]').click(); await beginning(page, 'c.md');
    await page.locator('#reading-back').click();
    assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - before) < 4, 'Back restores the previous document position.');
    await page.locator('#continuous-reading').check();
    for (const name of order) {
      await page.locator(`[data-reading-document="${name}"]`).waitFor();
      await page.locator(`[data-reading-document="${name}"] .document-end`).scrollIntoViewIfNeeded();
      assert.ok(await page.locator('[data-reading-document]').count() <= 3, 'Rendered document memory is bounded.');
    }
    for (const name of [...order].reverse()) {
      await page.locator(`[data-reading-document="${name}"]`).waitFor();
      await page.locator(`[data-reading-document="${name}"] .document-boundary`).scrollIntoViewIfNeeded();
    }
    await page.locator('[data-document-link="nested/b.md"]').click(); await beginning(page, 'nested/b.md');
    await page.locator('[data-document-link="../c.md"]').click(); await beginning(page, 'c.md');
    const passage = page.locator('[data-reading-document="c.md"] [data-source-map]').filter({ hasText: 'paragraph 25,' }); await passage.scrollIntoViewIfNeeded();
    await passage.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
    await page.locator('#selection-comment').click(); await page.locator('#body').fill('Anchored in the continuous reader.');
    await page.locator('#save').click(); await page.locator('#composer').waitFor({ state: 'hidden' });
    await page.locator('.thread [data-action="locate"]').click();
    assert.equal(await page.locator('[data-reading-document="c.md"] .commented').count(), 1);
    if (mode === 'vscode-bridge') {
      const session = new ReviewSession(store); await session.open();
      const comment = session.events.find(e => e.type === 'comment.created'); assert.ok(comment?.type === 'comment.created');
      assert.equal(comment.anchor.document, 'c.md'); assert.equal(comment.anchor.quote.exact, 'Document 3, paragraph 25, exact review passage.');
      const text = texts.get('c.md')!, start = text.indexOf('Document 3, paragraph 26,');
      const peer = session.context(creator), anchor = { document: 'c.md', documentDigest: session.revision!.documents.find(d => d.path === 'c.md')!.digest, range: { start: pointAt(text, start), end: pointAt(text, start + 10) }, quote: { exact: text.slice(start, start + 10) } };
      const y = await page.evaluate(() => scrollY); await session.save(peer, session.makeEvent(peer, { type: 'comment.created', threadId: 'thread_peer', commentId: 'comment_peer', anchor, body: { format: 'markdown', text: 'Peer update without a jump.' } }));
      await page.waitForFunction(() => document.querySelectorAll('.thread').length === 2, undefined, { timeout: 15000 });
      assert.ok(Math.abs(await page.evaluate(() => scrollY) - y) < 4, 'Live feedback does not move the reader.');
      assert.equal(session.events.some(e => e.type === 'review.completed'), false, 'Scrolling never finishes a review.');
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(temp, `reader-${mode}.png`) }); console.log(`Reading UX evidence: ${temp}`);
  } finally { await browser.close(); }
});

test('adjacent read failure exposes retry and rapid navigation cannot commit a stale document', { timeout: 60000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'omr-reader-recovery-')), source = path.join(temp, 'source'), root = path.join(temp, 'review');
  await mkdir(source);
  for (const name of ['a', 'b', 'c']) await writeFile(path.join(source, `${name}.md`), `# ${name}\n\n${Array.from({ length: 45 }, (_, i) => `${name} passage ${i}.`).join('\n\n')}`);
  const created = await authorReview({ source, store: root, rootDocument: 'a.md', actor: { id: 'creator' }, operationId: 'recovery_fixture', journalRoot: path.join(temp, 'journal'), clientArtifact: path.resolve('dist/OpenMarkdownReview.html') });
  const store = new NativeStorage(root, path.join(temp, 'client-journal')), initial = new ReviewSession(store); await initial.open();
  const originalEvents = await readdir(path.join(root, 'events'));
  const b = initial.revision!.documents.find(d => d.path === 'b.md')!.blobPath, c = initial.revision!.documents.find(d => d.path === 'c.md')!.blobPath;
  let fail = true, release!: () => void, requested!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), arrived = new Promise<void>(resolve => { requested = resolve; });
  const browser = await chromium.launch({ headless: true, channel: 'chromium', ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.exposeFunction('omrHost', async (method: string, args: unknown[]) => {
      if (method === 'info') return { ok: true, value: { identity: store.identity, writable: true } };
      if (method === 'read' && args[0] === b && fail) return { ok: false, code: 'uncertain', error: 'Simulated slow-share read failure.' };
      if (method === 'read' && args[0] === c) { requested(); await gate; }
      return storageResponse(store, method, args);
    });
    await page.goto(pathToFileURL(created.browserClientPath).href); await page.waitForSelector('#document [data-source-map]');
    await page.locator('[data-reading-document="a.md"] .document-end').scrollIntoViewIfNeeded();
    await page.locator('.reader-loading button').waitFor(); assert.match(await page.locator('.reader-loading').innerText(), /Simulated slow-share read failure/);
    assert.equal(await page.locator('[data-reading-document]').count(), 1);
    fail = false; await page.locator('.reader-loading button').click(); await beginning(page, 'b.md');
    await page.locator('#continuous-reading').uncheck();
    await page.locator('#documents [data-document="c.md"]').click(); await arrived;
    await page.locator('#documents [data-document="a.md"]').click(); await beginning(page, 'a.md'); release();
    await page.waitForFunction(() => !document.getElementById('status')!.textContent!.startsWith('Loading'));
    assert.equal(await page.locator('#documents .active').getAttribute('data-document'), 'a.md');
    assert.equal(await page.locator('[data-reading-document="c.md"]').count(), 0, 'Aborted rendering never replaces the latest requested page.');
    assert.doesNotMatch(await page.locator('#status').innerText(), /aborted|cancelled/i);
    assert.deepEqual(await readdir(path.join(root, 'events')), originalEvents, 'Navigation and retries write no review events.');
  } finally { release(); await browser.close(); }
});
