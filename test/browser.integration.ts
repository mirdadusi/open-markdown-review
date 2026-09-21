import test from 'node:test';
import './slidev.integration';
import './reviewer.browser.integration';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { authorReview } from '../src/professional/authoring';
import { NativeStorage } from '../src/professional/nativeStorage';
import { storageResponse } from '../src/professional/bridge';
import { digest, parseJson } from '../src/professional/bytes';
import { AuditInventory, LIMITS } from '../src/professional/types';

test('real Chromium bundle: create, images/Mermaid/tables, repeated selection, reply, resolution and whole audit PDF', { timeout: 120000 }, async () => {
  const temporary = await mkdtemp(path.join(process.env.OMR_TEST_REVIEW_ROOT || os.tmpdir(), 'omr-browser-')), source = path.join(temporary, 'source'), root = path.join(temporary, 'review'), journal = await mkdtemp(path.join(os.tmpdir(), 'omr-private-journal-'));
  await mkdir(path.join(source, 'images'), { recursive: true });
  await writeFile(path.join(source, 'a.md'), '# Architecture\n\nHello repeated repeated.\n\n![External diagram](images/diagram.svg)\n\n```mermaid\nflowchart LR\n  A[Author] --> B[Review]\n```\n\n| Name | Role |\n| --- | --- |\n| Mira | Author |\n\n<table id="html-risk" onclick="globalThis.compromised=true"><thead><tr><th rowspan="2">Risk</th><th>Owner</th></tr></thead><tbody><tr><td><u>Reviewer</u></td></tr></tbody></table>\n\n<img src="images/diagram.svg" alt="HTML diagram" onerror="globalThis.compromised=true">\n\n<a href="https://example.com/evidence" onclick="globalThis.compromised=true">External evidence</a>\n\n<script>globalThis.compromised=true</script>\n\n[Evidence](evidence.txt "review:attach")\n');
  await writeFile(path.join(source, 'b.md'), '# Second document\n\nThis must appear in the complete PDF.\n');
  await writeFile(path.join(source, 'evidence.txt'), 'Frozen reference evidence.');
  await writeFile(path.join(source, 'images/diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="#2458a6"/><text x="12" y="45" fill="white">Captured image</text></svg>');
  const artifact = path.resolve('dist/OpenMarkdownReview.html');
  const created = await authorReview({ source, store: root, rootDocument: 'a.md', actor: { id: 'author' }, operationId: 'browser_fixture', clientArtifact: artifact, journalRoot: journal });
  assert.equal(created.outcome, 'completed');
  const store = new NativeStorage(root, journal);
  let failNextPdf = false;
  const browser = await chromium.launch({ headless: true, channel: 'chromium', ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors: string[] = [];
    let releaseOpening!: () => void, delayManifest = true; const openingGate = new Promise<void>(resolve => { releaseOpening = resolve; });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.exposeFunction('omrHost', async (method: string, args: unknown[]) => {
      if (delayManifest && method === 'read' && args[0] === 'manifest.json') { delayManifest = false; await openingGate; }
      if (failNextPdf && method === 'write' && String(args[0]).endsWith('.pdf')) {
        failNextPdf = false; await store.write(String(args[0]), new Uint8Array(args[1] as number[]).slice(0, 17), false);
        return { ok: false, code: 'uncertain', error: 'Simulated network loss during PDF publication.' };
      }
      return storageResponse(store, method, args);
    });
    // Open the actual entry file beside the shared manifest, not the build template.
    const navigation = page.goto(pathToFileURL(created.browserClientPath).href);
    await page.locator('#open-progress').waitFor({ state: 'visible' });
    assert.match(await page.locator('#open-progress-message').innerText(), /manifest|Opening/);
    assert.equal(await page.locator('body').getAttribute('aria-busy'), 'true');
    releaseOpening(); await navigation;
    const submitted = async () => {
      await page.waitForFunction(() => !(document.getElementById('composer') as HTMLDialogElement).open || !!document.getElementById('composer-error')!.textContent);
      assert.equal(await page.locator('#composer-error').textContent(), '', `Browser error: ${await page.locator('#composer-error').textContent()}`);
    };
    await page.waitForSelector('#document img[src]', { timeout: 45000 });
    assert.equal(await page.locator('#open-progress').isVisible(), false); assert.equal(await page.locator('body').getAttribute('aria-busy'), 'false');
    await page.waitForSelector('#document .diagram svg', { timeout: 45000 });
    assert.equal(await page.locator('#document table').count(), 2);
    assert.equal(await page.locator('#document table[data-source-bookmark="html-risk"][data-kind="table"] [data-kind="table-cell"]').count(), 3);
    assert.equal(await page.locator('#document table[data-source-bookmark="html-risk"] th').first().getAttribute('rowspan'), '2');
    assert.equal(await page.locator('#document [onclick], #document [onerror], #document script').count(), 0);
    assert.equal(await page.evaluate(() => (globalThis as typeof globalThis & { compromised?: boolean }).compromised), undefined);
    assert.equal(await page.locator('#document a[href="https://example.com/evidence"][rel="noopener noreferrer"]').count(), 1);
    await page.locator('#actor-id').fill('reviewer'); await page.locator('#actor-name').fill('Review Participant');
    await page.locator('#document table[data-source-bookmark="html-risk"] [data-kind="table-cell"]').last().click();
    await page.locator('#comment').click(); assert.equal(await page.locator('#composer').evaluate(dialog => (dialog as HTMLDialogElement).open), true);
    await page.locator('#cancel').click();
    await page.locator('[data-zoom]').click(); await page.locator('#zoom-scale').focus(); await page.locator('#zoom-scale').press('End'); assert.equal(await page.locator('#zoom-content svg').evaluate(el => (el as SVGElement).style.width), '3200px'); await page.locator('#zoom-close').click();
    assert.equal(await page.locator('#document img').first().evaluate(img => (img as HTMLImageElement).naturalWidth), 240);
    await page.locator('#document [data-source-map]').filter({ hasText: 'Hello repeated repeated.' }).evaluate(span => {
      const text = span.firstChild!, range = document.createRange(); range.setStart(text, 15); range.setEnd(text, 23); const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    await page.locator('#comment').click(); await page.locator('#body').fill('Second repeated phrase needs attention.'); await page.locator('#save').click();
    await submitted(); assert.equal(await page.locator('.thread').count(), 1);
    await page.locator('.thread [data-action="reply"]').click(); await page.locator('#body').fill('Reply from the browser.'); await page.locator('#save').click(); await submitted();
    assert.match(await page.locator('.thread').innerText(), /Reply from the browser/);
    await page.locator('#documents [data-document="b.md"]').click();
    await page.locator('#document [data-source-map]').filter({ hasText: 'This must appear in the complete PDF.' }).evaluate(span => {
      const range = document.createRange(); range.selectNodeContents(span); const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    await page.locator('#comment').click(); await page.locator('#body').fill('Second document concern.'); await page.locator('#save').click(); await submitted();
    assert.equal(await page.locator('.thread:visible').count(), 2, 'All-document scope is the default for a multi-document review.');
    assert.match(await page.locator('#discussion-count').innerText(), /2 comments.*across all 2 review document/);
    await page.locator('#discussion-scope').selectOption('document');
    assert.equal(await page.locator('.thread:visible').count(), 1, 'Selected-document scope narrows the side panel.');
    assert.match(await page.locator('#discussion-count').innerText(), /1 comments.*on b\.md/);
    await page.locator('#documents [data-document="a.md"]').click();
    assert.equal(await page.locator('.thread:visible').count(), 1, 'Selected-document scope follows document navigation.');
    assert.match(await page.locator('#discussion-count').innerText(), /1 comments.*on a\.md/);
    await page.locator('#discussion-scope').selectOption('all');
    assert.equal(await page.locator('.thread:visible').count(), 2, 'All-document scope restores every review comment.');
    await page.locator('#document [data-source-map]').filter({ hasText: 'Hello repeated repeated.' }).evaluate(span => {
      const text = span.firstChild!, range = document.createRange(); range.setStart(text, 6); range.setEnd(text, 14); const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    await page.locator('#suggest').click(); await page.locator('#choice').selectOption('replace'); await page.locator('#body').fill('Use more precise terminology.'); await page.locator('#replacement').fill('specific'); await page.locator('#save').click(); await submitted();
    const suggestion = page.locator('.suggestion').first();
    assert.equal(await suggestion.locator('[data-action="locate"]').count(), 1, 'A suggested edit links to its exact source location.');
    await suggestion.locator('[data-action="locate"]').click(); await page.locator('#document [data-suggestion-jump]').waitFor();
    await page.locator('#document [data-suggestion-jump]').first().click();
    assert.equal(await suggestion.evaluate(element => element.classList.contains('focused')), true, 'Clicking suggested source text returns to its edit card.');
    await page.locator('#actor-id').fill('author');
    assert.equal(await page.locator('.thread [data-action="decide"]').count(), 2, 'Only the review initiator receives finding decision controls.');
    await page.locator('.thread [data-action="decide"]').first().click(); await page.locator('#choice').selectOption('accepted'); await page.locator('#body').fill('The challenge is valid.'); await page.locator('#save').click(); await submitted();
    await page.locator('.thread [data-action="resolve"]').first().click(); await page.locator('#body').fill('Checked and resolved.'); await page.locator('#save').click(); await submitted();
    assert.equal(await page.locator('.thread.closed').count(), 1);
    assert.equal(await page.locator('.thread.closed [data-action="reply"], .thread.closed [data-action="decide"]').count(), 0);
    assert.equal(await page.locator('.thread.closed [data-action="reopen"]').count(), 1);
    await page.locator('#actor-id').fill('reviewer');
    await page.locator('#approve').click(); await page.locator('#body').fill('Approved after reviewing the recorded challenge.'); await page.locator('#save').click();
    await page.waitForFunction(() => document.getElementById('composer-error')!.textContent?.includes('Press Save event again'));
    await page.locator('#save').click(); await submitted(); assert.match(await page.locator('#stance-status').innerText(), /approved/);
    // Filters and selected document must never reduce audit scope.
    await page.locator('#documents [data-document="b.md"]').click(); await page.locator('#open-only').check();
    const exported = await page.evaluate(async revision => window.omrAutomation!.export({ id: 'reviewer' }, revision!, 'browser_export'), created.revisionId) as { pdfPath: string; inventoryPath: string };
    const pdf = await readFile(path.join(root, exported.pdfPath)), inventory = parseJson<AuditInventory>(await readFile(path.join(root, exported.inventoryPath)), LIMITS.inventory);
    assert.ok(pdf.subarray(0, 5).toString() === '%PDF-'); assert.equal(inventory.pdf.digest, digest(pdf)); assert.equal(inventory.documents.length, 2); assert.equal(inventory.renderedDiagrams.length, 1); assert.equal(inventory.events.length, 8);
    for (const file of inventory.events) assert.equal(digest(await readFile(path.join(root, file.path))), file.digest);
    // The normal button, not just an automation operation ID, survives close/retry.
    failNextPdf = true; await page.locator('#export').click();
    await page.waitForFunction(() => document.getElementById('status')!.textContent!.includes('Export did not finish'));
    const pointerKey = `export-ui:${digest(`${created.revisionId}\0reviewer`).slice(7)}`;
    const pending = (await store.journalGet(pointerKey))!; assert.equal(pending.acknowledged, false);
    const pendingOperation = parseJson<{ operationId: string }>(new Uint8Array(pending.bytes)).operationId;
    await page.reload(); await page.waitForSelector('#document .diagram svg', { timeout: 45000 });
    await page.locator('#actor-id').fill('reviewer'); await page.locator('#export').click();
    await page.waitForFunction(() => document.getElementById('toast')!.textContent!.includes('Saved exports/'), { timeout: 45000 });
    const resumed = (await store.journalGet(pointerKey))!; assert.equal(resumed.acknowledged, true);
    assert.equal(parseJson<{ operationId: string }>(new Uint8Array(resumed.bytes)).operationId, pendingOperation);
    const exportsAfterRetry = await page.evaluate(() => window.omrAutomation!.session()!.events.filter(e => e.type === 'export.created').length);
    assert.equal(exportsAfterRetry, 2, 'One automation export plus exactly one recovered UI export.');
    for (const width of [320, 768, 1024, 1440]) { await page.setViewportSize({ width, height: 1000 }); assert.ok(await page.locator('#actor-id').isVisible()); }
    assert.deepEqual(errors, []);
    process.stdout.write(`Browser fixture and PDF: ${root}\n`);
  } finally { await browser.close(); }
});
test('browser adapter uses real directory handles and IndexedDB: two participants converge, approve/reject/withdraw, export and retry', { timeout: 120000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omr-browser-storage-')), source = path.join(temporary, 'source'), root = path.join(temporary, 'review'), journal = path.join(temporary, 'journal');
  await mkdir(source); await writeFile(path.join(source, 'a.md'), '# Review\n\nA concrete design.\n');
  const artifact = path.resolve('dist/OpenMarkdownReview.html');
  const created = await authorReview({ source, store: root, rootDocument: 'a.md', actor: { id: 'author' }, operationId: 'opfs_fixture', clientArtifact: artifact, journalRoot: journal });
  const html = await readFile(created.browserClientPath, 'utf8');
  const files: Array<{ path: string; bytes: number[] }> = [];
  const launcherName = path.basename(created.browserClientPath);
  const collect = async (dir: string) => { for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) { const relative = dir ? `${dir}/${entry.name}` : entry.name; if (entry.isDirectory()) await collect(relative); else if (entry.name !== launcherName) files.push({ path: relative, bytes: Array.from(await readFile(path.join(root, relative))) }); } };
  await collect('');
  const browser = await chromium.launch({ headless: true, channel: 'chromium', ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const context = await browser.newContext();
    // Only the picker is mocked. Reads, writes, close, resolve and IndexedDB are browser APIs.
    // OPFS is not a substitute for the separately required local-disk/SMB permission qualification.
    await context.route('https://review-test.invalid/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await context.addInitScript(() => {
      const fileSystem = globalThis as typeof globalThis & { FileSystemHandle?: { prototype: Record<string, unknown> } }, prototype = fileSystem.FileSystemHandle?.prototype;
      if (prototype && !prototype.queryPermission) Object.defineProperty(prototype, 'queryPermission', { value: async () => 'granted' });
      if (prototype && !prototype.requestPermission) Object.defineProperty(prototype, 'requestPermission', { value: async () => 'granted' });
      window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('review', { create: true });
    });
    const a = await context.newPage(); await a.goto('https://review-test.invalid/client');
    await a.evaluate(async files => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('review', { create: true });
      for (const file of files) { const parts = file.path.split('/'), name = parts.pop()!; let parent = root; for (const p of parts) parent = await parent.getDirectoryHandle(p, { create: true }); const writable = await (await parent.getFileHandle(name, { create: true })).createWritable(); await writable.write(new Uint8Array(file.bytes)); await writable.close(); }
      await root.getDirectoryHandle('exports', { create: true });
    }, files);
    await a.locator('#connect').click(); await a.waitForSelector('#document [data-source-map]'); await a.locator('#actor-id').fill('alice');
    const b = await context.newPage(); await b.goto('https://review-test.invalid/client'); await b.waitForSelector('#document [data-source-map]');
    assert.equal(await b.locator('#welcome').isVisible(), false, 'A remembered identity-bound handle reconnects without another picker when permission is already granted.');
    await b.locator('#actor-id').fill('bob');
    const select = async (page: typeof a) => { await page.locator('#document [data-source-map]').filter({ hasText: 'A concrete design.' }).evaluate(span => { const r = document.createRange(); r.selectNodeContents(span); const s = document.getSelection()!; s.removeAllRanges(); s.addRange(r); }); await page.locator('#comment').click(); };
    await select(a); await select(b); await a.locator('#body').fill('Alice concern'); await b.locator('#body').fill('Bob concern');
    await Promise.all([a.locator('#save').click(), b.locator('#save').click()]);
    for (const page of [a, b]) { await page.waitForFunction(() => !(document.getElementById('composer') as HTMLDialogElement).open || !!document.getElementById('composer-error')!.textContent); assert.equal(await page.locator('#composer-error').textContent(), '', 'Simultaneous comment must save without a manual retry.'); await page.waitForFunction(() => document.querySelectorAll('.thread').length === 2); }
    assert.equal(await a.locator('.thread').count(), 2); assert.equal(await b.locator('.thread').count(), 2);
    await a.locator('#discussion-search').fill('Alice concern'); assert.equal(await a.locator('.thread').count(), 1); await a.locator('#discussion-search').fill(''); assert.equal(await a.locator('.thread').count(), 2);
    const decision = async (button: string, reason: string) => {
      await a.locator(`#${button}`).click(); await a.locator('#body').fill(reason); await a.locator('#save').click();
      await a.waitForFunction(() => document.getElementById('composer-error')!.textContent?.includes('Press Save event again'));
      await a.waitForFunction(() => !(document.getElementById('save') as HTMLButtonElement).disabled); await a.locator('#save').click();
      await a.waitForFunction(() => !(document.getElementById('composer') as HTMLDialogElement).open || !!document.getElementById('composer-error')!.textContent);
      assert.equal(await a.locator('#composer-error').textContent(), '');
    };
    assert.match(await a.locator('#stance-status').innerText(), /not set/); assert.equal(await a.locator('#withdraw').isVisible(), false);
    await decision('approve', 'Approved with known open concerns.');
    assert.match(await a.locator('#stance-status').innerText(), /approved/); assert.equal(await a.locator('#approve').isVisible(), false); assert.equal(await a.locator('#reject').isVisible(), false); assert.equal(await a.locator('#withdraw').isVisible(), true);
    await decision('withdraw', 'Withdrawing my approval.');
    assert.match(await a.locator('#stance-status').innerText(), /withdrawn/); assert.equal(await a.locator('#approve').isVisible(), true); assert.equal(await a.locator('#reject').isVisible(), true); assert.equal(await a.locator('#withdraw').isVisible(), false);
    await decision('reject', 'Changed my assessment.');
    assert.match(await a.locator('#stance-status').innerText(), /rejected/); assert.equal(await a.locator('#approve').isVisible(), false); assert.equal(await a.locator('#reject').isVisible(), false); assert.equal(await a.locator('#withdraw').isVisible(), true);
    await decision('withdraw', 'Withdrawing my rejection.');
    assert.match(await a.locator('#stance-status').innerText(), /withdrawn/); assert.equal(await a.locator('#approve').isVisible(), true); assert.equal(await a.locator('#reject').isVisible(), true); assert.equal(await a.locator('#withdraw').isVisible(), false);
    const result = await a.evaluate(async revision => window.omrAutomation!.export({ id: 'alice' }, revision!, 'opfs_export'), created.revisionId) as { event: { id: string }; pdfPath: string };
    const repeated = await a.evaluate(async revision => window.omrAutomation!.export({ id: 'alice' }, revision!, 'opfs_export'), created.revisionId) as { event: { id: string }; pdfPath: string };
    assert.equal(repeated.event.id, result.event.id); assert.equal(repeated.pdfPath, result.pdfPath);
    const diagnostics = await a.evaluate(() => window.omrAutomation!.session()!.diagnostics); assert.deepEqual(diagnostics, []);
    const generated = await a.evaluate(async pdfPath => { let parent = await (await navigator.storage.getDirectory()).getDirectoryHandle('review'); const parts = pdfPath.split('/'), name = parts.pop()!; for (const p of parts) parent = await parent.getDirectoryHandle(p); return (await (await parent.getFileHandle(name)).getFile()).size; }, result.pdfPath);
    assert.ok(generated > 1000);
    const wrongContext = await browser.newContext();
    try {
      await wrongContext.route('https://wrong-review.invalid/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      await wrongContext.addInitScript(() => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('wrong', { create: true }); });
      const wrong = await wrongContext.newPage(); await wrong.goto('https://wrong-review.invalid/client');
      await wrong.evaluate(async packageFiles => {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('wrong', { create: true });
        for (const file of packageFiles) {
          const parts = file.path.split('/'), name = parts.pop()!; let parent = root; for (const p of parts) parent = await parent.getDirectoryHandle(p, { create: true });
          let bytes = new Uint8Array(file.bytes);
          if (file.path === 'manifest.json') { const manifest = JSON.parse(new TextDecoder().decode(bytes)); manifest.title = 'Different package bytes'; bytes = new TextEncoder().encode(JSON.stringify(manifest)); }
          const writable = await (await parent.getFileHandle(name, { create: true })).createWritable(); await writable.write(bytes); await writable.close();
        }
      }, files);
      await wrong.locator('#connect').click(); await wrong.waitForFunction(() => document.getElementById('status')!.textContent!.includes('different review'));
      assert.equal(await wrong.locator('#workspace').isVisible(), false, 'A launcher never opens a folder whose manifest digest differs from its binding.');
    } finally { await wrongContext.close(); }
  } finally { await browser.close(); }
});
