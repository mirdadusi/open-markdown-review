import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, Frame, Page } from 'playwright';
import { authorReview } from '../src/professional/authoring';
import { startNativeCompanion } from './companionHost';
import packageJson from '../package.json';

type Surface = Frame | Page;

async function aligned(surface: Surface, selector: string) {
  await surface.waitForFunction(selector => {
    const target = document.querySelector(selector), toolbar = document.getElementById('toolbar');
    return target && toolbar && Math.abs(target.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom - 12) < 4;
  }, selector, { timeout: 15000 });
}

async function beginning(surface: Surface, document: string) {
  await aligned(surface, `[data-reading-document="${document}"]`);
}

async function exercise(surface: Surface, order: string[]) {
  const initial = order[0], second = order[1];
  await surface.locator('#workspace').waitFor({ state: 'visible', timeout: 45000 });
  await surface.locator('#open-progress').waitFor({ state: 'hidden', timeout: 45000 });
  const select = async (document: string) => {
    await surface.locator(`#documents [data-document="${document}"]`).click();
    await beginning(surface, document);
  };
  await select(initial);
  await surface.locator('[data-document-link="#target-heading"]').click();
  await aligned(surface, `[data-reading-document="${initial}"] h2`);
  // Wait beyond the click event so a host's second navigation cannot be hidden.
  await new Promise(resolve => setTimeout(resolve, 100));
  await aligned(surface, `[data-reading-document="${initial}"] h2`);
  await surface.locator('#reading-back').click(); await beginning(surface, initial);
  await surface.locator('[data-document-link="#target-heading"]').focus();
  await surface.locator('[data-document-link="#target-heading"]').press('Enter');
  await aligned(surface, `[data-reading-document="${initial}"] h2`);
  await surface.locator('#reading-back').click(); await beginning(surface, initial);
  await surface.locator('[data-document-link="nested/b.md#target-heading"]').click();
  await aligned(surface, '[data-reading-document="nested/b.md"] h2');
  await surface.locator('#reading-back').click(); await beginning(surface, initial);

  // Capture the document-relative position and invoke the actual control in
  // one turn. Playwright's pointer-click auto-scroll can otherwise move the
  // webview before the reader records its position on narrower host layouts.
  const before = await surface.evaluate(({ initial, second }) => {
    const section = document.querySelector<HTMLElement>(`[data-reading-document="${initial}"]`)!;
    const toolbar = document.getElementById('toolbar')!;
    const heading = section.querySelector('h2')!;
    window.scrollBy({ top: heading.getBoundingClientRect().top - toolbar.offsetHeight - 12, behavior: 'instant' });
    const offset = section.getBoundingClientRect().top - toolbar.offsetHeight - 12;
    document.querySelector<HTMLButtonElement>(`#documents [data-document="${second}"]`)!.click();
    return offset;
  }, { initial, second });
  assert.ok(before < -100, 'Back fixture must start well inside the original document.');
  await beginning(surface, second);
  await surface.locator('#reading-back').click();
  await surface.waitForFunction(({ initial, before }) => {
    const section = document.querySelector(`[data-reading-document="${initial}"]`), toolbar = document.getElementById('toolbar');
    return section && toolbar && document.getElementById('reading-position')?.title === initial
      && Math.abs(section.getBoundingClientRect().top - toolbar.offsetHeight - 12 - before) < 4;
  }, { initial, before });
  await select(initial);
  await surface.locator('#continuous-reading').uncheck();
  await surface.locator('#reading-next').click(); await beginning(surface, second);
  assert.equal(await surface.locator('#reading-position').innerText(), `2 / ${order.length}`);
  await surface.locator('#reading-previous').click(); await beginning(surface, initial);
  assert.equal(await surface.locator('#reading-position').innerText(), `1 / ${order.length}`);

  await surface.locator('#continuous-reading').check();
  for (const document of order) {
    await surface.locator(`[data-reading-document="${document}"]`).waitFor();
    await surface.locator(`[data-reading-document="${document}"] .document-end`).scrollIntoViewIfNeeded();
    assert.ok(await surface.locator('[data-reading-document]').count() <= 3, 'Continuous reading keeps at most three rendered documents.');
  }
  for (const document of [...order].reverse()) {
    await surface.locator(`[data-reading-document="${document}"]`).waitFor();
    await surface.locator(`[data-reading-document="${document}"] .document-boundary`).scrollIntoViewIfNeeded();
    assert.ok(await surface.locator('[data-reading-document]').count() <= 3, 'Backward continuous reading remains bounded.');
  }
  await select(initial);
  assert.equal(await surface.locator('#reading-position').innerText(), `1 / ${order.length}`);
}

/** Actual Electron webview plus the delivered native browser client. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(`${packageJson.publisher}.${packageJson.name}`);
  assert.ok(extension); await extension.activate();
  assert.ok(process.env.OMR_TEST_COMPANION && path.isAbsolute(process.env.OMR_TEST_COMPANION));
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omr-reading-clients-'));
  const source = path.join(temporary, 'source'), root = path.join(temporary, 'review');
  await mkdir(path.join(source, 'nested'), { recursive: true });
  for (const [index, name] of ['a.md', 'nested/b.md', 'c.md', 'd.md', 'e.md', 'f.md'].entries()) {
    const links = index === 0 ? '[This section](#target-heading) · [Other section](nested/b.md#target-heading)\n\n' : '';
    await writeFile(path.join(source, name), `# Document ${index + 1}\n\n${links}${Array.from({ length: 55 }, (_, n) => `${n === 35 ? '## Target heading\n\n' : ''}Document ${index + 1}, paragraph ${n + 1}.`).join('\n\n')}\n`);
  }
  const artifact = path.join(extension.extensionPath, 'dist/OpenMarkdownReview.html');
  const created = await authorReview({ source, store: root, rootDocument: 'a.md', actor: { id: 'creator@example.com' }, operationId: 'native_reading', clientArtifact: artifact, journalRoot: path.join(temporary, 'author-journal') });
  const revision = JSON.parse(await readFile(path.join(root, 'revisions', `${created.revisionId}.json`), 'utf8'));
  const order = ['a.md', 'nested/b.md', 'c.md', 'd.md', 'e.md', 'f.md'];
  const before = (await readdir(path.join(root, 'events'))).sort();
  const manifest = await readFile(path.join(root, 'manifest.json'));
  const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.OMR_TEST_CDP_PORT}`);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let helper: Awaited<ReturnType<typeof startNativeCompanion>> | undefined;
  const output = path.resolve('output/reading', `${process.platform}-${process.arch}`); await mkdir(output, { recursive: true });
  try {
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(created.browserClientPath), 'openMarkdownReview.entryFile');
    let frame: Frame | undefined;
    for (let attempt = 0; attempt < 300 && !frame; attempt++) {
      for (const page of cdp.contexts().flatMap(c => c.pages())) for (const candidate of page.frames()) {
        if (await candidate.locator('#workspace:visible').count().catch(() => 0)) { frame = candidate; break; }
      }
      if (!frame) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(frame, 'The actual VS Code reading webview did not open.');
    await exercise(frame, order);
    await frame.page().screenshot({ path: path.join(output, 'vscode-reading.png') });
    helper = await startNativeCompanion({ root, journalRoot: path.join(temporary, 'browser-journal'), html: await readFile(artifact, 'utf8') }, process.env.OMR_TEST_COMPANION);
    browser = await chromium.launch({ headless: true, channel: 'chromium', ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(helper.url);
    await exercise(page, order);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, 'browser-reading.png') });
    assert.deepEqual((await readdir(path.join(root, 'events'))).sort(), before, 'Navigation never completes, approves or otherwise changes a review.');
    assert.deepEqual(await readFile(path.join(root, 'manifest.json')), manifest);
    await writeFile(path.join(output, 'reading.json'), JSON.stringify({ version: packageJson.version, documents: order.length, clients: ['actual-vscode-webview', 'native-browser'], headingLinks: true, keyboardLinks: true, nextPrevious: true, backRestoresPosition: true, continuousForwardBackward: true, boundedDocuments: true, evidenceUnchanged: true }, null, 2));
    console.log(`PASS actual VS Code and native browser reading: section links, keyboard, page switching, Back and bounded continuous reading across ${order.length} documents.`);
  } finally {
    if (browser) await browser.close();
    if (helper) await helper.close();
    await cdp.close();
  }
}
