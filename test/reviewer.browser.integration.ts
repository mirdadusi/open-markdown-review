import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, Page } from 'playwright';
import { authorReview } from '../src/professional/authoring';
import { NativeStorage } from '../src/professional/nativeStorage';
import { storageResponse } from '../src/professional/bridge';
import { ActorRef } from '../src/professional/types';

async function until(check: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), 'The expected host notification did not arrive.');
}
async function bridge(page: Page, store: NativeStorage, state: { reviewer?: ActorRef; ready: number }, gate?: Promise<void>) {
  await page.exposeFunction('reviewerTestHost', async (message: { id: string; method: string; args: unknown[] }) => {
    if (message.method === 'info') { await gate; return { id: message.id, value: { identity: store.identity, writable: true, canRememberReviewer: true, canNotifyReady: true, reviewer: state.reviewer } }; }
    if (message.method === 'rememberReviewer') { state.reviewer = message.args[0] as ActorRef; return { id: message.id, value: true }; }
    if (message.method === 'toolboxReady') { state.ready++; return { id: message.id, value: true }; }
    const result = await storageResponse(store, message.method, message.args);
    return { id: message.id, ...('value' in result ? { value: result.value } : { error: result.error, code: result.code }) };
  });
  await page.addInitScript(() => {
    window.acquireVsCodeApi = () => ({ postMessage: message => {
      void (window as unknown as { reviewerTestHost(message: unknown): Promise<unknown> }).reviewerTestHost(message).then(data => window.dispatchEvent(new MessageEvent('message', { data })));
    } });
  });
}

test('VS Code rendered side panel defaults to all review documents and can follow the selected document', { timeout: 120000 }, async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium', ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const fixture = `<!doctype html><html><body><div class="layout">
      <nav class="sidebar left"><button class="document-button" data-document="a.md">a.md</button><button class="document-button" data-document="b.md">b.md</button><button class="document-button" data-document="c.md">c.md</button></nav>
      <main class="content"><article class="document" data-document="a.md"><span data-thread-ids="a">A anchor</span></article><article class="document" data-document="b.md"><span data-thread-ids="b">B anchor</span></article><article class="document" data-document="c.md"></article></main>
      <aside class="sidebar right"><select id="discussion-scope"><option value="all" selected>All review documents</option><option value="document">Selected document only</option></select>
        <p id="review-discussion-count"></p><p id="review-discussion-empty" hidden></p>
        <ul id="review-thread-list"><li id="thread-a" class="thread" data-thread-id="a" data-document="a.md">A concern</li><li id="thread-b" class="thread" data-thread-id="b" data-document="b.md">B concern</li></ul>
        <ul id="review-suggestion-list"><li class="suggestion" data-document="b.md">B edit</li></ul>
      </aside></div>
      <div id="toast"></div>
    </body></html>`;
    const open = async (initial: { document?: string; discussionScope?: 'all' | 'document' } = {}) => {
      const page = await browser.newPage(); await page.setContent(fixture);
      await page.evaluate(state => {
        let saved: unknown = state;
        const host = window as unknown as { savedReviewViewState?: unknown; acquireVsCodeApi: () => { postMessage(message: unknown): void; getState(): unknown; setState(value: unknown): void } };
        host.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => saved, setState: value => { saved = value; host.savedReviewViewState = value; } });
      }, initial);
      await page.addStyleTag({ path: path.resolve('media/review.css') });
      await page.addScriptTag({ path: path.resolve('media/review.js') }); return page;
    };
    const page = await open();
    assert.equal(await page.locator('#review-thread-list .thread:visible').count(), 2);
    assert.equal(await page.locator('#review-suggestion-list .suggestion:visible').count(), 1);
    assert.match(await page.locator('#review-discussion-count').innerText(), /2 comments and 1 edits across the review/);
    await page.locator('#review-thread-list .thread').filter({ hasText: 'B concern' }).click();
    assert.equal(await page.locator('.document-button[data-document="b.md"]').evaluate(element => element.classList.contains('active')), true, 'An all-review card navigates to its source document.');
    await page.locator('.document-button[data-document="a.md"]').click();
    await page.locator('#discussion-scope').selectOption('document');
    assert.equal(await page.locator('#review-thread-list .thread:visible').count(), 1);
    assert.equal(await page.locator('#review-suggestion-list .suggestion:visible').count(), 0);
    assert.match(await page.locator('#review-discussion-count').innerText(), /1 comments and 0 edits on a\.md/);
    await page.locator('.document-button[data-document="c.md"]').click();
    assert.equal(await page.locator('#review-thread-list .thread:visible').count(), 0);
    assert.equal(await page.locator('#review-discussion-empty').isVisible(), true);
    assert.match(await page.locator('#review-discussion-empty').innerText(), /No comments or suggested edits on c\.md/);
    await page.locator('.document-button[data-document="b.md"]').click();
    assert.equal(await page.locator('#review-thread-list .thread:visible').count(), 1);
    assert.equal(await page.locator('#review-suggestion-list .suggestion:visible').count(), 1);
    assert.match(await page.locator('#review-discussion-count').innerText(), /1 comments and 1 edits on b\.md/);
    const saved = await page.evaluate(() => (window as unknown as { savedReviewViewState: { document: string; discussionScope: string } }).savedReviewViewState);
    assert.equal(saved.document, 'b.md'); assert.equal(saved.discussionScope, 'document');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
      command: 'reviewState',
      threadsHtml: '<li class="thread" data-thread-id="a" data-document="a.md">A concern</li><li class="thread" data-thread-id="a2" data-document="a.md">New A concern</li><li class="thread" data-thread-id="b" data-document="b.md">B concern</li>',
      suggestionsHtml: '<li class="suggestion" data-document="b.md">B edit</li>', stats: {}, anchors: [],
    } })));
    assert.equal(await page.locator('#review-thread-list .thread:visible').count(), 1, 'Incremental updates retain selected-document scope.');
    await page.locator('#discussion-scope').selectOption('all');
    assert.equal(await page.locator('#review-thread-list .thread:visible').count(), 3, 'All-review scope includes an incrementally received off-document comment.');
    const restored = await open({ document: 'b.md', discussionScope: 'document' });
    assert.equal(await restored.locator('#discussion-scope').inputValue(), 'document');
    assert.equal(await restored.locator('.document-button[data-document="b.md"]').evaluate(element => element.classList.contains('active')), true);
    assert.equal(await restored.locator('#review-thread-list .thread:visible').count(), 1, 'VS Code restores the local scope and selected document.');
    assert.equal(await restored.locator('#review-suggestion-list .suggestion:visible').count(), 1);
    for (const width of [960, 720, 320]) {
      await restored.setViewportSize({ width, height: 900 });
      assert.equal(await restored.locator('.sidebar.right').isVisible(), true, `The complete findings panel remains reachable at ${width}px.`);
      assert.equal(await restored.locator('#discussion-scope').isVisible(), true);
    }
  } finally { await browser.close(); }
});

test('VS Code bridge hands creation identity to the real toolbox and first event; edits survive reopen privately', { timeout: 90000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omr-reviewer-ui-')), source = path.join(temporary, 'source'), root = path.join(temporary, 'review'), journal = path.join(temporary, 'journal');
  await mkdir(source); await writeFile(path.join(source, 'a.md'), '# Review\n\nSelect these words.\n');
  const author = { id: 'creation-reviewer', displayName: 'Creation Reviewer' };
  const created = await authorReview({ source, store: root, rootDocument: 'a.md', actor: author, operationId: 'identity_fixture', journalRoot: journal, clientArtifact: path.resolve('dist/OpenMarkdownReview.html') });
  const originalManifest = await readFile(path.join(root, 'manifest.json'), 'utf8'), originalHtml = await readFile(created.browserClientPath, 'utf8');
  const store = new NativeStorage(root, journal), state = { reviewer: author as ActorRef | undefined, ready: 0 };
  const browser = await chromium.launch({ headless: true, channel: 'chromium', ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const page = await browser.newPage(), errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await bridge(page, store, state);
    await page.addInitScript(() => { if (!localStorage.getItem('omr.identity')) localStorage.setItem('omr.identity', JSON.stringify({ id: 'stale-cache', displayName: 'Stale cached name' })); });
    const url = pathToFileURL(created.browserClientPath).href;
    await page.goto(url); await page.waitForSelector('#document [data-source-map]'); await until(() => state.ready === 1);
    assert.equal(await page.locator('#actor-id').inputValue(), author.id); assert.equal(await page.locator('#actor-name').inputValue(), author.displayName);
    await page.locator('#document [data-source-map]').filter({ hasText: 'Select these words.' }).evaluate(span => { const r = document.createRange(); r.selectNodeContents(span); const s = document.getSelection()!; s.removeAllRanges(); s.addRange(r); });
    await page.locator('#comment').click(); await page.locator('#body').fill('Comment without entering my identity again.'); await page.locator('#save').click();
    await page.waitForSelector('.thread');
    const files = await readdir(path.join(root, 'events'));
    const events = await Promise.all(files.map(file => readFile(path.join(root, 'events', file), 'utf8').then(JSON.parse)));
    assert.deepEqual(events.find(event => event.type === 'comment.created').actor, author);
    await page.locator('#actor-id').fill('local-participant'); await page.locator('#actor-name').fill('Local Participant'); await page.locator('#actor-name').press('Tab');
    await until(() => state.reviewer?.id === 'local-participant' && state.reviewer?.displayName === 'Local Participant');
    await page.reload(); await until(() => state.ready === 2);
    assert.equal(await page.locator('#actor-id').inputValue(), 'local-participant'); assert.equal(await page.locator('#actor-name').inputValue(), 'Local Participant');
    await page.locator('#actor-name').fill(''); await page.locator('#actor-name').press('Tab'); await until(() => state.reviewer?.displayName === undefined);
    await page.reload(); await until(() => state.ready === 3); assert.equal(await page.locator('#actor-name').inputValue(), '');
    assert.equal(await readFile(path.join(root, 'manifest.json'), 'utf8'), originalManifest);
    assert.equal(await readFile(created.browserClientPath, 'utf8'), originalHtml);
    assert.deepEqual(await readdir(path.join(root, 'events')), files, 'Editing local identity does not append review events.');
    assert.ok(!originalHtml.includes(author.id), 'The portable HTML must not embed the author as the participant.');

    const receiving = await browser.newPage(), receiverState = { ready: 0 };
    await bridge(receiving, store, receiverState); await receiving.goto(url); await until(() => receiverState.ready === 1);
    assert.equal(await receiving.locator('#actor-id').inputValue(), ''); assert.equal(await receiving.locator('#actor-name').inputValue(), '', 'A fresh recipient does not inherit manifest.createdBy.');

    const delayed = await browser.newPage(), delayedState = { reviewer: author, ready: 0 }; let release!: () => void;
    await bridge(delayed, store, delayedState, new Promise<void>(resolve => { release = resolve; }));
    await delayed.goto(url); await delayed.waitForFunction(() => document.documentElement.dataset.clientReady === 'true');
    await delayed.locator('#actor-id').fill('typed-before-load'); await delayed.locator('#actor-name').fill('Typed before load'); release();
    await until(() => delayedState.ready === 1);
    assert.equal(await delayed.locator('#actor-id').inputValue(), 'typed-before-load'); assert.equal(await delayed.locator('#actor-name').inputValue(), 'Typed before load');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { command: 'reviewer-identity', reviewer: { id: 'revision-author', displayName: 'Revision Author' } } })));
    assert.equal(await page.locator('#actor-id').inputValue(), 'revision-author'); assert.equal(await page.locator('#actor-name').inputValue(), 'Revision Author');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('two VS Code bridge toolboxes converge simultaneous and cross-document comments with creator-controlled closure', { timeout: 120000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omr-bridge-concurrency-')), source = path.join(temporary, 'source'), root = path.join(temporary, 'review');
  await mkdir(source);
  await writeFile(path.join(source, 'a.md'), `# Long review\n\n${Array.from({ length: 180 }, (_, index) => `Paragraph ${index + 1} for scrolling and review context.`).join('\n\n')}\n\nConcurrent target text.\n`);
  await writeFile(path.join(source, 'b.md'), '# Supporting document\n\nCross-document target text.\n');
  const created = await authorReview({ source, store: root, rootDocument: 'a.md', actor: { id: 'author', displayName: 'Review Creator' }, operationId: 'bridge_concurrency_fixture', journalRoot: path.join(temporary, 'author-journal'), clientArtifact: path.resolve('dist/OpenMarkdownReview.html') });
  const browser = await chromium.launch({ headless: true, channel: 'chromium', ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const a = await browser.newPage({ viewport: { width: 1280, height: 720 } }), b = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const aState = { reviewer: { id: 'alice', displayName: 'Alice' } as ActorRef, ready: 0 }, bState = { reviewer: { id: 'bob', displayName: 'Bob' } as ActorRef, ready: 0 };
    await bridge(a, new NativeStorage(root, path.join(temporary, 'alice-journal')), aState);
    await bridge(b, new NativeStorage(root, path.join(temporary, 'bob-journal')), bState);
    const url = pathToFileURL(created.browserClientPath).href;
    await Promise.all([a.goto(url), b.goto(url)]);
    await Promise.all([a.waitForSelector('#document [data-source-map]'), b.waitForSelector('#document [data-source-map]')]);
    assert.equal(await a.locator('#toolbar').evaluate(element => getComputedStyle(element).position), 'sticky');
    const select = async (page: Page) => {
      const target = page.locator('#document [data-source-map]').filter({ hasText: 'Concurrent target text.' });
      await target.scrollIntoViewIfNeeded();
      await target.evaluate(span => { const range = document.createRange(); range.selectNodeContents(span); const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
      await page.locator('#selection-actions').waitFor({ state: 'visible' });
      await page.locator('#selection-comment').click();
    };
    await Promise.all([select(a), select(b)]);
    await a.locator('#body').fill('Alice simultaneous concern.'); await b.locator('#body').fill('Bob simultaneous concern.');
    await Promise.all([a.locator('#save').click(), b.locator('#save').click()]);
    for (const page of [a, b]) {
      await page.waitForFunction(() => !(document.getElementById('composer') as HTMLDialogElement).open || !!document.getElementById('composer-error')!.textContent);
      assert.equal(await page.locator('#composer-error').textContent(), '');
      await page.waitForFunction(() => document.querySelectorAll('.thread').length === 2, undefined, { timeout: 20000 });
    }
    assert.equal(await a.locator('.thread [data-action="decide"], .thread [data-action="resolve"]').count(), 0, 'Ordinary reviewers cannot decide or close comment threads.');
    await select(a); await a.locator('#body').fill('Alice later concern for live refresh.'); await a.locator('#save').click();
    await a.waitForFunction(() => !(document.getElementById('composer') as HTMLDialogElement).open || !!document.getElementById('composer-error')!.textContent);
    await b.waitForFunction(() => document.querySelectorAll('.thread').length === 3 && document.getElementById('toast')!.textContent!.includes('new review event'), undefined, { timeout: 20000 });
    await a.locator('#documents [data-document="b.md"]').click();
    const crossDocumentTarget = a.locator('#document [data-source-map]').filter({ hasText: 'Cross-document target text.' });
    await crossDocumentTarget.evaluate(span => { const range = document.createRange(); range.selectNodeContents(span); const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
    await a.locator('#selection-actions').waitFor({ state: 'visible' }); await a.locator('#selection-comment').click();
    await a.locator('#body').fill('Cross-document live concern.'); await a.locator('#save').click();
    await a.waitForFunction(() => !(document.getElementById('composer') as HTMLDialogElement).open || !!document.getElementById('composer-error')!.textContent);
    await b.waitForFunction(() => document.querySelectorAll('.thread').length === 4 && document.getElementById('toast')!.textContent!.includes('new review event'), undefined, { timeout: 20000 });
    assert.equal(await b.locator('.thread:visible').count(), 4, 'All-document scope shows a live comment arriving for a non-selected document.');
    assert.match(await b.locator('#discussion-count').innerText(), /4 comments.*across all 2 review document/);
    await b.locator('#discussion-scope').selectOption('document');
    assert.equal(await b.locator('.thread:visible').count(), 3, 'Selected-document scope hides the off-document live comment.');
    assert.match(await b.locator('#discussion-count').innerText(), /3 comments.*on a\.md/);
    await b.locator('#discussion-scope').selectOption('all');
    const remote = b.locator('.thread').filter({ hasText: 'Cross-document live concern.' });
    await remote.locator('[data-action="locate"]').click();
    await b.locator('#documents [data-document="b.md"].active').waitFor();
    assert.ok(await b.locator('#document [data-thread-ids]').count(), 'Cross-document navigation reveals the highlighted target.');
    await a.locator('#actor-id').fill('author'); await a.locator('#actor-name').fill('Review Creator');
    assert.equal(await a.locator('.thread').first().locator('[data-action="decide"], [data-action="resolve"]').count(), 2, 'The review initiator receives decision and closure controls on open findings.');
    await a.locator('.thread').first().locator('[data-action="resolve"]').click(); await a.locator('#body').fill('Creator closed this concern.'); await a.locator('#save').click();
    await a.waitForSelector('.thread.closed');
    await b.waitForSelector('.thread.closed', { timeout: 20000 });
    const closed = b.locator('.thread.closed').first();
    assert.equal(await closed.locator('[data-action="reply"], [data-action="decide"], [data-action="reopen"]').count(), 0, 'Closed threads expose no participant write actions.');
    assert.match(await closed.innerText(), /locked until the review creator reopens/i);
    assert.equal(await a.locator('.thread.closed [data-action="reopen"]').count(), 1, 'The creator can explicitly reopen a closed thread.');
    process.stdout.write('Two VS Code bridge clients converged simultaneous and cross-document comments with creator-controlled closure.\n');
  } finally { await browser.close(); }
});
