import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, Frame } from 'playwright';
import { authorReview } from '../src/professional/authoring';
import { ReviewSession } from '../src/professional/session';
import { NativeStorage } from '../src/professional/nativeStorage';
import { pdfTemplatePresets } from '../src/professional/pdfTemplate';
import packageJson from '../package.json';

/** Isolated real Electron webview; never installs into the user's VS Code profile. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(`${packageJson.publisher}.${packageJson.name}`); assert.ok(extension); await extension.activate();
  const temp = await mkdtemp(path.join(os.tmpdir(), 'omr-template-vscode-')), source = path.join(temp, 'source'), root = path.join(temp, 'review'); await mkdir(source);
  await writeFile(path.join(source, 'index.md'), '# Template test\n\nPříliš žluťoučký kůň → ✓.\n\n| Requirement | State |\n|---|---|\n| Offline PDF | Required |\n');
  const actor = { id: 'creator@example.com' };
  const created = await authorReview({ source, store: root, rootDocument: 'index.md', actor, operationId: 'template_extension', clientArtifact: path.join(extension.extensionPath, 'dist/OpenMarkdownReview.html'), journalRoot: path.join(temp, 'author-journal') });
  const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.OMR_TEST_CDP_PORT}`);
  try {
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(created.browserClientPath), 'openMarkdownReview.entryFile');
    let frame: Frame | undefined;
    for (let attempt = 0; attempt < 300 && !frame; attempt++) {
      for (const page of cdp.contexts().flatMap(c => c.pages())) for (const candidate of page.frames()) if (await candidate.locator('#workspace:visible').count().catch(() => 0)) { frame = candidate; break; }
      if (!frame) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(frame, 'The real VS Code PDF toolbox did not open.');
    await vscode.commands.executeCommand('notifications.clearAll');
    await frame.locator('#actor-id').fill(actor.id);
    await vscode.commands.executeCommand('openMarkdownReview.exportPdf');
    await frame.locator('#pdf-template-dialog').waitFor({ state: 'visible' });
    assert.equal(await frame.locator('#pdf-template-select').inputValue(), 'Default');
    assert.deepEqual(await frame.locator('#pdf-template-select option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)), ['Default'], 'The public VS Code toolbox ships no additional preset.');
    assert.equal(await frame.locator('#pdf-orientation').inputValue(), 'auto');
    await frame.locator('#pdf-template-cancel').click();
    const preset = pdfTemplatePresets()[0];
    const output = path.resolve('output/pdf-template-vscode'); await mkdir(output, { recursive: true });
    for (const mode of ['review', 'clean']) {
      await frame.locator('#export').click(); await frame.locator('#pdf-template-dialog').waitFor();
      if (preset) await frame.locator('#pdf-template-select').selectOption(preset.id);
      await frame.locator('#pdf-cover').check();
      if (preset?.coverSections) {
        assert.deepEqual(await frame.locator('#pdf-template-sections legend').allTextContents(), preset.coverSections.map(section => section.title));
        assert.deepEqual(await frame.locator('#pdf-template-sections input').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).dataset.label)), preset.coverSections.flatMap(section => section.fields.map(field => field.label)));
      }
      await frame.locator('#pdf-meta-title').fill('Synthetic document'); await frame.locator('#pdf-meta-project').fill('User project');
      await frame.locator('#pdf-meta-product').fill('User product'); await frame.locator('#pdf-meta-author').fill('Document author');
      await frame.locator('#export-mode').selectOption(mode);
      await frame.locator('#pdf-orientation').selectOption('portrait');
      await frame.locator('#pdf-document-list').setChecked(mode === 'clean');
      if (mode === 'review') await frame.page().screenshot({ path: path.join(output, 'export-config.png') });
      await vscode.commands.executeCommand('notifications.clearAll');
      await frame.locator('#pdf-export-confirm').click();
      await frame.waitForFunction(() => ['success', 'error'].includes(document.getElementById('export-result')?.dataset.kind ?? ''), undefined, { timeout: 90000 });
      assert.equal(await frame.locator('#export-result').getAttribute('data-kind'), 'success', await frame.locator('#export-result-message').innerText());
      assert.equal(await frame.locator('#open-export').isVisible(), true); assert.equal(await frame.locator('#reveal-export').isVisible(), true);
    }
    await frame.locator('#export').click(); await frame.locator('#pdf-template-dialog').waitFor(); await frame.locator('#pdf-template-import summary').click();
    await frame.locator('#pdf-template-file').setInputFiles({ name: 'template.json', mimeType: 'application/json', buffer: await readFile(path.join(extension.extensionPath, 'examples/pdf-template.json')) });
    await frame.waitForFunction(() => (document.getElementById('pdf-template-select') as HTMLSelectElement).value === '__imported');
    assert.equal(await frame.locator('#pdf-meta-documentId').getAttribute('required'), '');
    assert.equal(await frame.locator('#pdf-meta-documentId-help').innerText(), 'Use the assigned document identifier.');
    await frame.locator('#pdf-export-confirm').click();
    assert.match(await frame.locator('#pdf-template-error').innerText(), /Specification number is required/);
    assert.equal(await frame.locator('#pdf-meta-documentId').evaluate(input => input === document.activeElement), true);
    await frame.locator('#pdf-meta-documentId').fill('USER-SPEC-123'); await frame.locator('#pdf-export-confirm').click();
    await frame.waitForFunction(() => ['success', 'error'].includes(document.getElementById('export-result')?.dataset.kind ?? ''), undefined, { timeout: 90000 });
    assert.equal(await frame.locator('#export-result').getAttribute('data-kind'), 'success', await frame.locator('#export-result-message').innerText());
    const session = new ReviewSession(new NativeStorage(root, path.join(temp, 'verify-journal'))); await session.open();
    assert.deepEqual(session.diagnostics.filter(d => d.severity === 'error'), []);
    const exports = session.events.filter(e => e.type === 'export.created'); assert.equal(exports.length, 1);
    assert.ok(exports[0].type === 'export.created' && exports[0].renderer.pdfEngine.includes('omr-pdf-template-v1='));
    assert.ok(exports[0].type === 'export.created' && exports[0].renderer.pdfEngine.includes('omr-document-list-v1=omitted'));
    assert.ok(exports[0].type === 'export.created' && exports[0].renderer.pdfEngine.includes('omr-pdf-orientation-v1=portrait'));
    await frame.page().screenshot({ path: path.join(output, 'toolbox.png') });
    const pdf = await readFile(path.join(root, exports[0].type === 'export.created' ? exports[0].pdf.path : '')); assert.equal(pdf.subarray(0, 8).toString(), '%PDF-1.7');
    console.log('PASS actual VS Code template-defined groups/labels, imported required fields, metadata, audited and clean PDF publication, and verified native open/reveal controls.');
  } finally { await cdp.close(); }
}
