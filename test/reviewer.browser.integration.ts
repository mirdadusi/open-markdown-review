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

test('VS Code bridge hands creation identity to the real toolbox and first event; edits survive reopen privately', { timeout: 90000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omr-reviewer-ui-')), source = path.join(temporary, 'source'), root = path.join(temporary, 'review'), journal = path.join(temporary, 'journal');
  await mkdir(source); await writeFile(path.join(source, 'a.md'), '# Review\n\nSelect these words.\n');
  const author = { id: 'creation-reviewer', displayName: 'Creation Reviewer' };
  await authorReview({ source, store: root, rootDocument: 'a.md', actor: author, operationId: 'identity_fixture', journalRoot: journal, clientArtifact: path.resolve('dist/OpenMarkdownReview.html') });
  const originalManifest = await readFile(path.join(root, 'manifest.json'), 'utf8'), originalHtml = await readFile(path.join(root, 'OpenMarkdownReview.html'), 'utf8');
  const store = new NativeStorage(root, journal), state = { reviewer: author as ActorRef | undefined, ready: 0 };
  const browser = await chromium.launch({ headless: true, channel: 'chromium', ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const page = await browser.newPage(), errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await bridge(page, store, state);
    await page.addInitScript(() => { if (!localStorage.getItem('omr.identity')) localStorage.setItem('omr.identity', JSON.stringify({ id: 'stale-cache', displayName: 'Stale cached name' })); });
    const url = pathToFileURL(path.join(root, 'OpenMarkdownReview.html')).href;
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
    assert.equal(await readFile(path.join(root, 'OpenMarkdownReview.html'), 'utf8'), originalHtml);
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
