import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { authorReview } from '../src/professional/authoring';
import { NativeStorage } from '../src/professional/nativeStorage';
import { ReviewSession } from '../src/professional/session';
import { storageResponse } from '../src/professional/bridge';
import { digest, parseJson, decode } from '../src/professional/bytes';
import { SLIDEV_ID, SlidevProfile } from '../src/professional/profiles/slidev';
import { AuditInventory, LIMITS } from '../src/professional/types';

test('real Slidev capture → shared HTML/VS Code bundle → visual/source comments, reply, approval and audited slide PDF', { timeout: 240000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omr-slidev-e2e-')), root = path.join(temporary, 'review'), journal = path.join(temporary, 'journal');
  const created = await authorReview({ source: path.resolve('examples/slidev'), store: root, include: ['slides.md'], rootDocument: 'slides.md', actor: { id: 'author' }, operationId: 'slidev_e2e', clientArtifact: path.resolve('dist/OpenMarkdownReview.html'), journalRoot: journal,
    slidev: { notes: 'excluded', trustProject: true, browserExecutable: process.env.OMR_TEST_BROWSER ?? chromium.executablePath() } });
  assert.equal(created.outcome, 'completed');
  const store = new NativeStorage(root, journal), session = new ReviewSession(store); await session.open();
  assert.deepEqual(session.diagnostics, []);
  const profile = session.profiles.get(created.revisionId!)!.get(SLIDEV_ID) as SlidevProfile;
  assert.equal(profile.slides.length, 4); assert.equal(session.revision!.documents.length, 2);
  assert.notEqual(profile.slides[2].previewResourceId, profile.slides[3].previewResourceId);
  for (const doc of session.revision!.documents) { const source = decode(await session.content(doc)); assert.ok(!source.includes('Author-only talking point')); assert.ok(!source.includes('Speaker note:')); }
  const requests: string[] = [], errors: string[] = [];
  const browser = await chromium.launch({ headless: true, channel: 'chromium', ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
    await page.exposeFunction('omrHost', (method: string, args: unknown[]) => storageResponse(store, method, args));
    await page.goto(pathToFileURL(path.join(root, 'OpenMarkdownReview.html')).href);
    await page.waitForSelector('.slide-preview img[src]', { timeout: 45000 });
    await page.locator('[data-zoom]').click(); assert.equal(await page.locator('#zoom-content img').count(), 1); await page.locator('#zoom-close').click();
    assert.equal(await page.locator('#documents [data-slide]').count(), 4);
    assert.ok(await page.locator('.slide-preview img').evaluate(img => (img as HTMLImageElement).naturalWidth > 500));
    await page.locator('#actor-id').fill('reviewer');
    const submit = async () => { await page.locator('#save').click(); await page.waitForFunction(() => !(document.getElementById('composer') as HTMLDialogElement).open || !!document.getElementById('composer-error')!.textContent); assert.equal(await page.locator('#composer-error').textContent(), ''); };
    await page.locator('#documents [data-slide]').nth(2).click();
    await page.locator('.slide-preview').click(); await page.locator('#comment').click(); await page.locator('#body').fill('Visual layout needs more space.'); await submit();
    await page.locator('.thread [data-action="reply"]').click(); await page.locator('#body').fill('Response: spacing is intentional.'); await submit();
    await page.locator('#documents [data-slide]').nth(3).click(); assert.equal(await page.locator('.slide-preview.commented').count(), 0, 'Repeated imports have independent visual anchors.');
    await page.locator('.thread [data-action="locate"]').click(); assert.equal(await page.locator('.slide-preview.commented').count(), 1);
    await page.locator('.slide-preview.commented').click(); assert.ok(await page.locator('.thread.focused').count());
    await page.locator('.slide-source [data-source-map]').filter({ hasText: 'This source is imported twice' }).evaluate(span => {
      const text = span.firstChild!, range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 11); const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    await page.locator('#comment').click(); await page.locator('#body').fill('Source wording comment.'); await submit();
    await page.locator('#documents [data-slide]').nth(3).click(); assert.ok(await page.locator('.slide-source .commented').count(), 'Shared source wording comments follow both occurrences.');
    await page.locator('#approve').click(); await page.locator('#save').click(); await page.waitForFunction(() => document.getElementById('composer-error')!.textContent!.includes('Press Save event again'));
    await submit();
    const exported = await page.evaluate(async revision => window.omrAutomation!.export({ id: 'reviewer' }, revision!, 'slidev_export'), created.revisionId) as { pdfPath: string; inventoryPath: string };
    const pdf = await readFile(path.join(root, exported.pdfPath)), inventory = parseJson<AuditInventory>(await readFile(path.join(root, exported.inventoryPath)), LIMITS.inventory);
    assert.equal(inventory.pdf.digest, digest(pdf)); assert.equal(inventory.renderedDiagrams.length, 1);
    for (const slide of profile.slides) { const resource = session.revision!.resources.find(r => r.id === slide.previewResourceId)!; assert.ok(inventory.resources.some(r => r.digest === resource.digest)); }
    assert.ok(inventory.resources.some(r => r.digest === session.manifest.extensions![0].schemaDigest));
    await session.refresh(true); assert.ok(session.events.some(e => e.type === 'export.created')); assert.deepEqual(session.diagnostics, []);
    assert.deepEqual(requests, [], 'Participants need no network or Slidev server.'); assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(temporary, 'toolbox.png'), fullPage: true });
    process.stdout.write(`Slidev evidence: ${temporary}\nSlidev audit PDF: ${path.join(root, exported.pdfPath)}\n`);
    // A subsequent revision can share notes explicitly; neither existing
    // decisions nor the participant's pin may silently move to that revision.
    const request = { source: path.resolve('examples/slidev'), store: root, include: ['slides.md'], rootDocument: 'slides.md', actor: { id: 'author' }, operationId: 'slidev_notes_revision', parents: [created.revisionId!], clientArtifact: path.resolve('dist/OpenMarkdownReview.html'), journalRoot: journal,
      slidev: { notes: 'included' as const, trustProject: true, browserExecutable: process.env.OMR_TEST_BROWSER ?? chromium.executablePath() } };
    const next = await authorReview(request); await session.refresh(); assert.equal(session.pinnedRevisionId, created.revisionId);
    await session.pin(next.revisionId!);
    assert.ok(decode(await session.content(session.revision!.documents.find(d => d.path === 'slides.md')!)).includes('Author-only talking point'));
    const eventNames = await readdir(path.join(root, 'events'));
    const resumed = await authorReview({ ...request, resume: true }); assert.equal(resumed.revisionId, next.revisionId); assert.deepEqual(await readdir(path.join(root, 'events')), eventNames);
  } finally { await browser.close(); }
});
