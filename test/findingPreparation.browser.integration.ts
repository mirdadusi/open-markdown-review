import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { actor, findingFixture, rewrite } from './findingPublication.fixture';
import { storageResponse } from '../src/professional/bridge';
import { ProtocolError } from '../src/professional/types';

test('Edit source stays clickable beneath the toolbar in a short, narrow review', { timeout: 30000 }, async () => {
  const f = await findingFixture();
  const browser = await chromium.launch({ headless: true, ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 320 } });
    const reveals: unknown[][] = [];
    await page.exposeFunction('omrHost', async (method: string, args: unknown[]) => {
      if (method === 'info') return { ok: true, value: { identity: f.store.identity, writable: true, canAuthorFindings: true, canApply: true, reviewer: actor } };
      if (method === 'revealSource') { reveals.push(args); return { ok: true, value: { confidence: 'exact' } }; }
      return storageResponse(f.store, method, args);
    });
    await page.goto(pathToFileURL(f.created.browserClientPath).href);
    const edit = page.locator('#thread-finding_0').getByRole('button', { name: 'Edit source', exact: true });
    await edit.evaluate(button => button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    await edit.click({ timeout: 5000 });
    const toast = page.locator('#toast.visible');
    await toast.waitFor({ timeout: 5000 });
    assert.equal(await toast.textContent(), 'Opened and selected the finding in the linked source workspace.');
    assert.deepEqual(reveals, [[f.origin, 'finding_0']]);
    assert.equal(await page.locator('#toast').evaluate(element => getComputedStyle(element).pointerEvents), 'none', 'Status notifications must not block controls.');
    const toolbar = page.locator('#toolbar');
    const bounds = (await toolbar.boundingBox())!;
    assert.ok(bounds.y >= -1 && bounds.y + bounds.height < 160, 'The sticky toolbar must leave most of the viewport for the review.');
    // The compact toolbar can still be scrolled to its own controls.
    await toolbar.locator('#export').focus();
    await toolbar.locator('#export').click({ timeout: 5000 });
    await page.locator('#pdf-template-dialog').waitFor({ timeout: 5000 });
  } finally { await browser.close(); }
});

test('comparison feedback: immediate progress, correlated updates, cancellation, errors and lazy document rendering', { timeout: 120000 }, async () => {
  const f = await findingFixture(); await rewrite(f.source);
  const manifest = await readFile(path.join(f.root, 'manifest.json')), events = await readdir(path.join(f.root, 'events'));
  const browser = await chromium.launch({ headless: true, ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let mode: 'wait' | 'error' | 'success' = 'wait', calls = 0, requestId = '', rejectWait: ((error: unknown) => void) | undefined;
    await page.exposeFunction('omrHost', async (method: string, args: unknown[]) => {
      try {
        if (method === 'info') return { ok: true, value: { identity: f.store.identity, writable: true, canAuthorFindings: true, canApply: true, reviewer: actor } };
        if (method === 'prepareFindingPublication') {
          calls++; requestId = String(args[2]);
          if (mode === 'wait') await new Promise((_resolve, reject) => { rejectWait = reject; });
          if (mode === 'error') throw new ProtocolError('permission', 'Source folder is temporarily unavailable.');
          return { ok: true, value: await f.publisher.prepare(f.origin, actor) };
        }
        if (method === 'cancelFindingPreparation') { assert.equal(args[2], requestId); rejectWait?.(new ProtocolError('cancelled', 'Preparation cancelled.')); return { ok: true, value: true }; }
        if (method === 'discardFindingPublication') { await f.publisher.discard(f.origin, actor, String(args[2])); return { ok: true, value: null }; }
        return storageResponse(f.store, method, args);
      } catch (error) { return { ok: false, code: error instanceof ProtocolError ? error.code : 'uncertain', error: error instanceof Error ? error.message : String(error) }; }
    });
    await page.goto(pathToFileURL(f.created.browserClientPath).href); await page.locator('#workspace').waitFor();
    const button = page.locator('#thread-finding_0 [data-primary-actions] [data-action=publish-fix]');
    await button.click(); await page.locator('#finding-preparation-dialog').waitFor();
    await page.waitForFunction(() => !!document.querySelector('#finding-preparation-dialog progress'));
    for (let i = 0; i < 100 && !requestId; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(requestId, 'The progress dialog is shown before the delayed host request settles.');
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('#publish-documents')!.click());
    assert.equal(calls, 1, 'A second invocation cannot enqueue duplicate preparation.');
    await page.evaluate(() => window.postMessage({ command: 'finding-preparation-progress', requestId: 'wrong-request', message: 'WRONG OPERATION' }));
    assert.doesNotMatch(await page.locator('#finding-preparation-dialog').innerText(), /WRONG OPERATION/);
    await page.evaluate(id => window.postMessage({ command: 'finding-preparation-progress', requestId: id, message: 'Capturing saved documents and attachments…' }), requestId);
    await page.locator('#finding-preparation-dialog [data-phase]').getByText('Capturing saved documents and attachments…', { exact: true }).waitFor();
    const output = path.resolve('output/finding-workflow'); await mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'comparison-preparing.png') });
    await page.locator('[data-cancel-preparation]').click(); await page.locator('#finding-preparation-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#finding-publication-dialog').count(), 0);
    mode = 'error'; await button.click(); await page.locator('#finding-preparation-dialog [data-error]').getByText('Source folder is temporarily unavailable.').waitFor();
    await page.locator('#finding-preparation-dialog button').click(); await page.locator('#finding-preparation-dialog').waitFor({ state: 'hidden' });
    mode = 'success'; await button.click(); await page.locator('#finding-publication-dialog').waitFor();
    assert.equal(await page.locator('.publication-diff').count(), 1, 'Only the first changed document is rendered initially.');
    await page.locator('[data-diff-index="1"] summary').click(); await page.waitForFunction(() => document.querySelectorAll('.publication-diff').length === 2);
    await page.locator('#finding-publication-dialog [data-cancel]').click(); await page.locator('#finding-publication-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await readFile(path.join(f.root, 'manifest.json')), manifest); assert.deepEqual(await readdir(path.join(f.root, 'events')), events);
    assert.equal((await readdir(path.join(f.root, 'revisions'))).length, 1);
  } finally { await browser.close(); }
});

test('publication feedback stays visible, scopes host progress, prevents duplicate publish and retains exact retry', { timeout: 120000 }, async () => {
  const f = await findingFixture(); await rewrite(f.source);
  const browser = await chromium.launch({ headless: true, ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let requestId = '', calls = 0, fail = true, release: (() => void) | undefined;
    await page.exposeFunction('omrHost', async (method: string, args: unknown[]) => {
      try {
        if (method === 'info') return { ok: true, value: { identity: f.store.identity, writable: true, canAuthorFindings: true, canApply: true, reviewer: actor } };
        if (method === 'prepareFindingPublication') return { ok: true, value: await f.publisher.prepare(f.origin, actor) };
        if (method === 'finishFindingPublication') {
          calls++; const request = args[2] as { requestId: string; operationId: string; selections: import('../src/professional/findingPublication').FindingSelection[] }; requestId = request.requestId;
          await new Promise<void>(resolve => { release = resolve; });
          if (fail) throw new Error('Temporary publication error.');
          return { ok: true, value: await f.publisher.finish(request.operationId, actor, request.selections) };
        }
        return storageResponse(f.store, method, args);
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    });
    await page.goto(pathToFileURL(f.created.browserClientPath).href); await page.locator('#workspace').waitFor();
    await page.locator('#thread-finding_0 [data-primary-actions] [data-action=publish-fix]').click();
    await page.locator('#finding-publication-dialog').waitFor(); await page.locator('[data-publish]').click();
    const dialog = page.locator('#finding-publication-dialog'); await dialog.locator('.publication-progress:visible').waitFor();
    assert.equal(await dialog.getAttribute('aria-busy'), 'true'); assert.equal(await dialog.locator('[data-cancel]').isDisabled(), true);
    await page.waitForFunction(() => document.querySelector('[data-publication-elapsed]')!.textContent!.includes('1s elapsed'));
    assert.match(requestId, /^publish_/);
    await page.evaluate(id => window.postMessage({ command: 'finding-preparation-progress', requestId: id, message: 'Rechecking saved source documents (35/50)…' }), requestId);
    await dialog.locator('[data-publication-phase]').getByText('Rechecking saved source documents (35/50)…', { exact: true }).waitFor();
    await page.evaluate(() => window.postMessage({ command: 'finding-preparation-progress', requestId: 'publish_other', message: 'WRONG PUBLICATION' }));
    assert.doesNotMatch(await dialog.innerText(), /WRONG PUBLICATION/);
    await dialog.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { cancelable: true }))); assert.equal(calls, 1);
    release!(); await dialog.locator('#publication-error').getByText('Temporary publication error.').waitFor();
    assert.equal(await dialog.getAttribute('aria-busy'), 'false'); assert.equal(await dialog.locator('.publication-progress').isVisible(), false);
    fail = false; await dialog.locator('[data-publish]').click(); await dialog.locator('.publication-progress:visible').waitFor();
    for (let i = 0; i < 100 && calls < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 2); release!(); await dialog.waitFor({ state: 'hidden' });
    await f.session.refresh(); assert.equal(f.session.revisions.size, 2); assert.equal(f.session.events.filter(event => event.type === 'thread.addressed').length, 1);
  } finally { await browser.close(); }
});
