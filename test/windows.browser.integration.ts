import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { authorReview } from '../src/professional/authoring';
import { NativeStorage } from '../src/professional/nativeStorage';
import { ReviewSession } from '../src/professional/session';

test('Windows CI real file entry and native folder permission: comment persists on SMB without a bridge', { timeout: 120000 }, async () => {
  assert.equal(process.platform, 'win32'); assert.equal(process.env.CI, 'true');
  const share = process.env.OMR_TEST_REVIEW_ROOT; assert.ok(share && share.startsWith('\\\\localhost\\omr_ci_'));
  const local = await mkdtemp(path.join(os.tmpdir(), 'omr-permission-source-')), source = path.join(local, 'source'); await mkdir(source);
  await writeFile(path.join(source, 'a.md'), '# Real folder grant\n\nSelect this reviewed sentence.\n');
  const root = path.join(await mkdtemp(path.join(share, 'omr-permissions-')), 'review');
  const created = await authorReview({ source, store: root, rootDocument: 'a.md', actor: { id: 'author' }, operationId: 'real_grant', journalRoot: path.join(local, 'journal'), clientArtifact: path.resolve('dist/OpenMarkdownReview.html') });
  const server = await chromium.launchServer({ headless: false }), browser = await chromium.connect(server.wsEndpoint());
  try {
    const page = await browser.newPage(); await page.goto(pathToFileURL(created.browserClientPath).href);
    assert.equal(await page.evaluate(() => !!window.omrHost), false, 'No native storage bridge is permitted in this qualification.');
    const grant = promisify(execFile)('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/select-ci-review-folder.ps1'), '-BrowserPid', String(server.process().pid), '-Folder', root], { timeout: 35000 });
    // Start both promises before waiting so failures cannot become unhandled.
    await Promise.all([grant, page.locator('#connect').click()]);
    await page.waitForSelector('#document [data-source-map]', { timeout: 20000 });
    await page.locator('#actor-id').fill('windows-ci-participant');
    await page.locator('#document [data-source-map]').filter({ hasText: 'Select this reviewed sentence.' }).evaluate(span => { const range = document.createRange(); range.selectNodeContents(span); const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
    await page.locator('#comment').click(); await page.locator('#body').fill('Saved through a real Windows browser folder grant.'); await page.locator('#save').click();
    await page.waitForSelector('.thread', { timeout: 20000 });
    const session = new ReviewSession(new NativeStorage(root, path.join(local, 'native-reader'))); await session.open();
    assert.equal(session.events.filter(e => e.type === 'comment.created').length, 1);
    assert.equal((await readdir(path.join(root, 'events'))).length, 2);
    await page.reload(); await page.waitForFunction(() => document.documentElement.dataset.clientReady === 'true');
    await page.waitForFunction(() => !document.getElementById('workspace')!.hidden || !document.getElementById('reconnect')!.hidden);
    assert.ok(await page.locator('#workspace').isVisible() || await page.locator('#reconnect').isVisible(), 'A granted folder reopens automatically when permission persists; otherwise one Resume action remains.');
  } finally { await browser.close(); await server.close(); }
});
