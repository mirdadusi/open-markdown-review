import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { authorReview } from '../src/professional/authoring';
import { NativeStorage } from '../src/professional/nativeStorage';
import { ReviewSession } from '../src/professional/session';
import { storageResponse } from '../src/professional/bridge';
import { pointAt } from '../src/professional/bytes';
import { PdfTemplate, PdfTemplateOptions, pdfTemplatePresets, selectPdfTemplate } from '../src/professional/pdfTemplate';
import { startCompanion } from './companionHost';

test('shared client template exports preserve native comments, clean projection, links, Unicode and recovery', { timeout: 180000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'omr-pdf-template-')), source = path.join(temp, 'source'), root = path.join(temp, 'review'), journalRoot = path.join(temp, 'journal');
  await mkdir(source);
  const unc = String.raw`\\files.example.test\Project Share\080_Quality\20_Checklists`;
  const requirements = String.raw`\\files.example.test\Project Share\Example_Project\Technical_Documentation\020_Product\15_Requirements`;
  const mdPath = (value: string) => value.replaceAll('\\', '\\\\');
  const markdown = '# Synthetic specification\n\nPříliš žluťoučký kůň → ✓. Review this exact sentence.\n\n[Next document](second.md#table) · [Reference](https://example.com/specification) · [Checklist](<' + mdPath(unc) + '>)\n\n'
    + `Requirements specification folder:\n[${mdPath(requirements)}](<${mdPath(requirements + '\\')}>)\n\nFile name recorded in Word: Sample_Requirements.\n\n`
    + '![Architecture](diagram.svg)\n\n```mermaid\nflowchart LR\n A[Source] --> B[Review]\n```\n';
  await writeFile(path.join(source, 'index.md'), markdown);
  await writeFile(path.join(source, 'second.md'), '# Supporting specification\n\n## Table\n\n| Parameter | A | B | C | D | E | F | G | Description |\n|---|---|---|---|---|---|---|---|---|\n' + Array.from({ length: 35 }, (_, i) => `| Key_${i} | 1 | 2 | 3 | 4 | 5 | 6 | 7 | Proportional pictures, safe links and wrapped technical content. |`).join('\n'));
  await writeFile(path.join(source, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="100"><rect width="320" height="100" fill="#e5eef8"/><text x="20" y="55" font-size="22">Frozen architecture</text></svg>');
  const actor = { id: 'creator@example.com', displayName: 'Initiator' };
  const created = await authorReview({ source, store: root, rootDocument: 'index.md', title: 'Synthetic review', actor, reviewerEmails: ['reviewer@example.com'], operationId: 'pdf_template_fixture', clientArtifact: path.resolve('dist/OpenMarkdownReview.html'), journalRoot });
  const storage = new NativeStorage(root, journalRoot), session = new ReviewSession(storage); await session.open();
  const ctx = session.context({ id: 'reviewer@example.com', displayName: 'Reviewer' }), start = markdown.indexOf('Příliš'), quote = 'Příliš žluťoučký kůň → ✓.';
  await session.save(ctx, session.makeEvent(ctx, { type: 'comment.created', threadId: 'template_thread', commentId: 'template_comment', anchor: { document: 'index.md', documentDigest: session.revision!.documents.find(d => d.path === 'index.md')!.digest, range: { start: pointAt(markdown, start), end: pointAt(markdown, start + quote.length) }, quote: { exact: quote }, target: { kind: 'text' } }, body: { format: 'markdown', text: 'NATIVE_TEMPLATE_FINDING: Please check this requirement.' } }));
  await session.save(ctx, session.makeEvent(ctx, { type: 'comment.replied', threadId: 'template_thread', commentId: 'template_reply', inReplyTo: 'template_comment', body: { format: 'markdown', text: 'NATIVE_TEMPLATE_REPLY: Confirmed with evidence.' } }));
  const folderLabel = '15_Requirements', folderStart = markdown.indexOf(folderLabel);
  await session.save(ctx, session.makeEvent(ctx, { type: 'comment.created', threadId: 'network_thread', commentId: 'network_comment', anchor: { document: 'index.md', documentDigest: session.revision!.documents.find(d => d.path === 'index.md')!.digest, range: { start: pointAt(markdown, folderStart), end: pointAt(markdown, folderStart + folderLabel.length) }, quote: { exact: folderLabel }, target: { kind: 'text' } }, body: { format: 'markdown', text: 'UNC_LABEL_FINDING: Confirm this folder.' } }));
  const frozenRevision = await readFile(path.join(root, `revisions/${created.revisionId}.json`));
  const helper = process.env.OMR_PDF_TEMPLATE_HTTP === 'true' || process.env.OMR_GO_COMPANION ? await startCompanion({ root, journalRoot: path.join(temp, 'http-journal'), html: await readFile(created.browserClientPath, 'utf8') }) : undefined;
  const browser = await chromium.launch({ headless: true, channel: 'chromium', ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const page = await browser.newPage(), requests: string[] = [];
    await page.route(/^https?:\/\//, route => { if (helper && route.request().url().startsWith(helper.origin + '/')) return route.continue(); requests.push(route.request().url()); return route.abort(); });
    if (!helper) await page.exposeFunction('omrHost', (method: string, args: unknown[]) => storageResponse(storage, method, args));
    await page.goto(helper?.url ?? pathToFileURL(created.browserClientPath).href); await page.waitForSelector('#document .diagram svg');
    const network = page.locator('#document a[data-network-path]').filter({ hasText: 'Checklist' });
    assert.equal(await network.getAttribute('data-network-path'), unc);
    assert.equal(await network.getAttribute('href'), null);
    await page.locator('#actor-id').fill(actor.id);
    const beforeDialog = (await storage.list('events')).length;
    await page.locator('#export').click(); await page.locator('#pdf-template-dialog').waitFor(); assert.equal(await page.locator('#pdf-template-select').inputValue(), 'Default');
    assert.deepEqual(await page.locator('#pdf-template-select option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)), ['Default'], 'Only the generic built-in template is offered in the public client.');
    assert.equal(await page.locator('#pdf-cover').isChecked(), false); assert.equal(await page.locator('#pdf-template-metadata').isVisible(), false);
    assert.equal(await page.locator('#pdf-template-select').evaluate(select => document.activeElement === select), true);
    assert.equal(await page.locator('#pdf-orientation').inputValue(), 'auto');
    await page.locator('#pdf-orientation').selectOption('portrait');
    await page.locator('#pdf-cover').check(); await page.locator('#pdf-meta-project').fill('Cancelled project');
    await page.locator('#pdf-template-cancel').click();
    assert.equal((await storage.list('events')).length, beforeDialog, 'Opening/cancelling options publishes nothing.');
    await page.locator('#export').click(); await page.locator('#pdf-template-dialog').waitFor(); assert.equal(await page.locator('#pdf-cover').isChecked(), false); assert.equal(await page.locator('#pdf-meta-project').inputValue(), '');
    assert.equal(await page.locator('#pdf-orientation').inputValue(), 'auto', 'Cancel does not persist orientation.');
    await page.locator('#pdf-orientation').selectOption('portrait');
    await page.locator('#pdf-cover').check();
    await page.locator('#pdf-meta-project').fill('USER_PROJECT_LABEL'); await page.locator('#pdf-meta-product').fill('USER_PRODUCT_LABEL');
    await page.locator('#pdf-meta-title').fill('USER_DOCUMENT_TITLE'); await page.locator('#pdf-meta-author').fill('Document Author');
    await page.locator('#pdf-meta-version').fill('D-2');
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileBounds = await page.locator('#pdf-template-dialog').boundingBox(); assert.ok(mobileBounds && mobileBounds.x >= 0 && mobileBounds.x + mobileBounds.width <= 390);
    await page.locator('#pdf-template-dialog').evaluate(dialog => { dialog.scrollTop = 0; });
    const confirmBounds = await page.locator('#pdf-export-confirm').boundingBox(); assert.ok(confirmBounds && confirmBounds.y + confirmBounds.height <= mobileBounds.y + mobileBounds.height, 'The confirmation button remains entirely inside the mobile dialog.');
    await mkdir('output/pdf-export-ux', { recursive: true }); await page.screenshot({ path: 'output/pdf-export-ux/mobile-config.png' });
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.locator('#pdf-template-dialog').evaluate(dialog => { dialog.scrollTop = 0; }); await page.screenshot({ path: 'output/pdf-export-ux/default-config.png' });
    await page.locator('#pdf-export-confirm').evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await page.locator('#export-result[data-kind="success"],#export-result[data-kind="error"]').waitFor({ timeout: 90000 });
    assert.equal(await page.locator('#export-result').getAttribute('data-kind'), 'success', await page.locator('#export-result-message').innerText());
    const uiPdf = (await page.locator('#export-result-path').innerText()).match(/exports\/[a-f0-9]{64}\.pdf/)![0];
    assert.equal((await storage.list('events')).length, beforeDialog + 1, 'Confirming twice does not duplicate export events.');
    await page.evaluate(() => localStorage.clear());
    await page.reload(); await page.waitForSelector('#document .diagram svg'); await page.locator('#actor-id').fill(actor.id); await page.locator('#export').click(); await page.locator('#pdf-template-dialog').waitFor();
    assert.equal(await page.locator('#pdf-orientation').inputValue(), 'portrait');
    assert.equal(await page.locator('#pdf-cover').isChecked(), true); assert.equal(await page.locator('#pdf-meta-project').inputValue(), 'USER_PROJECT_LABEL');
    if (pdfTemplatePresets().length) { await page.locator('#pdf-template-select').selectOption(pdfTemplatePresets()[0].id); assert.equal(await page.locator('#pdf-cover').isChecked(), true); assert.equal(await page.locator('#pdf-meta-project').inputValue(), 'USER_PROJECT_LABEL'); }
    await page.locator('#export-mode').selectOption('clean');
    await page.screenshot({ path: 'output/pdf-export-ux/selected-config.png' });
    await page.locator('#pdf-export-confirm').click();
    await page.locator('#export-result[data-kind="success"],#export-result[data-kind="error"]').waitFor({ timeout: 90000 });
    assert.equal(await page.locator('#export-result').getAttribute('data-kind'), 'success', await page.locator('#export-result-message').innerText());
    const uiCleanPdf = (await page.locator('#export-result-path').innerText()).match(/exports\/[a-f0-9]{64}\.pdf/)![0];
    await page.reload(); await page.waitForSelector('#document .diagram svg'); await page.locator('#export').click(); await page.locator('#pdf-template-dialog').waitFor();
    assert.equal(await page.locator('#export-mode').inputValue(), 'clean');
    await page.locator('#pdf-template-dialog').press('Escape'); assert.equal(await page.locator('#pdf-template-dialog').isVisible(), false);
    const inspect = await (new Function('specifier', 'return import(specifier)')(pathToFileURL(path.resolve('scripts/inspect-pdf.mjs')).href) as Promise<{ inspectPdf(bytes: Uint8Array): Promise<any> }>);
    await mkdir('output/pdf', { recursive: true });
    for (const [file, clean] of [[uiPdf, false], [uiCleanPdf, true]] as const) {
      const inspected = await inspect.inspectPdf(await readFile(path.join(root, file)));
      assert.deepEqual(inspected.violations, []);
      assert.ok(inspected.pages.every((page: { width: number; height: number }) => Math.abs(page.width - 595.28) < 0.1 && Math.abs(page.height - 841.89) < 0.1));
      assert.match(inspected.metadata.Keywords, /omr-pdf-orientation-v1=portrait/);
      assert.ok(!inspected.links.some((link: { url?: string }) => link.url?.includes('files.example.test')));
      const text = inspected.pages.map((page: { text: string }) => page.text).join('\n');
      assert.ok(text.includes(unc), 'The full UNC path must be selectable text, with backslashes and spaces intact.');
      const section = text.slice(text.indexOf('Requirements specification folder:'), text.indexOf('File name recorded in Word:'));
      assert.equal(section.trim(), `Requirements specification folder:\n${requirements}\\`, 'A matching UNC label must not print a second, split copy. Preserve the exact destination including its trailing backslash.');
      assert.match(text, /External network path/);
      assert.doesNotMatch(text, /target not in this archive/);
      assert.match(text, /Key_34/);
      for (const label of ['USER_PROJECT_LABEL', 'USER_PRODUCT_LABEL', 'USER_DOCUMENT_TITLE', 'Document Author', 'D-2']) assert.ok(text.includes(label), label);
      if (clean) { assert.equal(inspected.annotations.length, 0); assert.ok(!text.includes('reviewer@example.com')); }
      else {
        assert.ok(inspected.annotations.length >= 2);
        assert.ok(inspected.annotations.some((annotation: { subtype: string; contents: string }) => annotation.subtype === 'Highlight' && annotation.contents.includes('UNC_LABEL_FINDING')), 'Findings on the deduplicated label still highlight the rendered path.');
      }
      await writeFile(`output/pdf/templates-user-configured-${clean ? 'clean' : 'review'}.pdf`, await readFile(path.join(root, file)));
    }
    const scenarios: Array<{ name: string; mode: 'review' | 'clean'; options: PdfTemplateOptions }> = [
      { name: 'default-review', mode: 'review', options: {} }, { name: 'default-clean', mode: 'clean', options: {} },
      ...(['review', 'clean'] as const).map(mode => ({ name: `portrait-${mode}`, mode, options: { orientation: 'portrait' as const } })),
      { name: 'custom-review', mode: 'review', options: { customTemplate: { schemaVersion: 'omr-pdf-template/1', id: 'Neutral', version: '1.0.0', label: 'Neutral', distribution: 'all', cover: true, css: ':root { --heading-color: #204060; --body-size: 11pt; }' }, metadata: { title: 'A neutral document title', project: 'Synthetic product', version: '2', status: 'Draft', confidentiality: 'Synthetic fixture only' } } },
      ...pdfTemplatePresets().flatMap(preset => (['review', 'clean'] as const).map(mode => ({ name: `preset-${mode}`, mode, options: { templateId: preset.id, metadata: { title: 'Feature specification', project: 'Synthetic product', documentId: 'DOC-123', version: '2', date: '2026-10-30', status: 'Draft', classification: 'Test fixture' } } })))
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const operation = `pdf_template_export_${index}`;
      const result = await page.evaluate(async args => window.omrAutomation!.export({ id: 'creator@example.com' }, args.revision!, args.operation, args.mode, args.options), { revision: created.revisionId, operation, mode: scenario.mode, options: scenario.options }) as { pdfPath: string; inventoryPath?: string };
      const bytes = await readFile(path.join(root, result.pdfPath)), pdf = await inspect.inspectPdf(bytes);
      assert.deepEqual(pdf.violations, [], scenario.name + ': ' + JSON.stringify(pdf.violations));
      assert.ok(pdf.images.length >= 2);
      if (scenario.options.orientation === 'portrait') {
        assert.equal(pdf.landscapePages, 0);
        const mismatch = await page.evaluate(async ({ revision, operation, mode }) => {
          try { await window.omrAutomation!.export({ id: 'creator@example.com' }, revision!, operation, mode); return ''; }
          catch (error) { return String(error); }
        }, { revision: created.revisionId, operation, mode: scenario.mode });
        assert.match(mismatch, /different page orientation/);
      } else assert.ok(pdf.landscapePages > 0);
      assert.ok(pdf.links.some((link: { url?: string }) => link.url === 'https://example.com/specification'));
      assert.ok(pdf.links.some((link: { targetPage?: number }) => link.targetPage));
      const text = pdf.pages.map((p: { text: string }) => p.text).join('\n');
      assert.match(text, /Příliš/);
      if (scenario.mode === 'review') {
        assert.ok(pdf.annotations.some((a: { contents: string }) => a.contents.includes('NATIVE_TEMPLATE_FINDING')));
        assert.ok(pdf.annotations.some((a: { contents: string; inReplyTo?: string }) => a.contents.includes('NATIVE_TEMPLATE_REPLY') && a.inReplyTo));
        assert.match(text, /reviewer@example.com/);
        const inventory = JSON.parse(await readFile(path.join(root, result.inventoryPath!), 'utf8'));
        const selected = selectPdfTemplate(scenario.options);
        if (selected) { assert.ok(inventory.resources.some((f: { digest: string }) => f.digest === selected.digest)); assert.ok(inventory.renderer.pdfEngine.includes(selected.digest)); }
        else assert.ok(!inventory.renderer.pdfEngine.includes('omr-pdf-template-v1='));
      } else {
        assert.equal(pdf.annotations.length, 0); assert.equal(pdf.attachments, null); assert.equal(result.inventoryPath, undefined);
        for (const secret of [created.reviewId, created.revisionId!, 'reviewer@example.com', 'NATIVE_TEMPLATE_FINDING', 'Reviewer completion']) assert.ok(!(text + JSON.stringify(pdf.metadata)).includes(secret), secret);
      }
      await writeFile(`output/pdf/templates-${scenario.name}.pdf`, bytes);
      const recovered = await page.evaluate(async args => window.omrAutomation!.export({ id: 'creator@example.com' }, args.revision!, args.operation, args.mode, args.options), { revision: created.revisionId, operation, mode: scenario.mode, options: scenario.options }) as { pdfPath: string };
      assert.equal(recovered.pdfPath, result.pdfPath);
      const mismatch = await page.evaluate(async args => { try { await window.omrAutomation!.export({ id: 'creator@example.com' }, args.revision!, args.operation, args.mode, { customTemplate: { schemaVersion: 'omr-pdf-template/1', id: 'Changed', version: '1.0.0', label: 'Changed', distribution: 'all', cover: false, css: ':root {}' } }); return ''; } catch (error) { return String(error); } }, { revision: created.revisionId, operation, mode: scenario.mode });
      assert.match(mismatch, /different template/);
    }
    const deniedLogo = await page.evaluate(async revision => { try { await window.omrAutomation!.export({ id: 'creator@example.com' }, revision!, 'unsafe_template_logo', 'review', { customTemplate: { schemaVersion: 'omr-pdf-template/1', id: 'UnsafeLogo', version: '1.0.0', label: 'Unsafe', distribution: 'all', cover: true, css: ':root {}', logoSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="https://example.com/logo.svg"/></svg>' } }); return ''; } catch (error) { return String(error); } }, created.revisionId);
    assert.match(deniedLogo, /SVG/);
    await session.refresh(); assert.deepEqual(session.diagnostics.filter(d => d.severity === 'error'), []);
    assert.ok(!session.events.some(e => e.operationId === 'unsafe_template_logo'));
    assert.equal(session.events.filter(e => e.type === 'comment.created').length, 2); assert.equal(session.events.filter(e => e.type === 'comment.replied').length, 1);
    assert.deepEqual(await readFile(path.join(root, `revisions/${created.revisionId}.json`)), frozenRevision);
    assert.deepEqual(await readFile(path.join(source, 'index.md'), 'utf8'), markdown); assert.deepEqual(requests, []);
    const preferenceKey = `pdf-export-preferences-v1:${created.reviewId}`;
    await storage.journalPut(preferenceKey, { path: 'exports', acknowledged: true, bytes: new TextEncoder().encode(JSON.stringify({ kind: 'omr-pdf-export-preferences/1', reviewId: created.reviewId, mode: 'clean' })) });
    await page.reload(); await page.waitForSelector('#document .diagram svg'); await page.locator('#actor-id').fill(actor.id);
    await page.locator('#export').click(); await page.locator('#pdf-template-dialog').waitFor(); assert.equal(await page.locator('#pdf-template-dialog').isVisible(), true, 'Malformed private preferences cannot block export configuration.');
    await page.locator('#pdf-template-import summary').click(); await page.locator('#pdf-template-file').setInputFiles({ name: 'unsafe.css', mimeType: 'text/css', buffer: Buffer.from('@import url(https://example.com/style.css)') });
    await page.waitForFunction(() => !!document.getElementById('pdf-template-error')!.textContent); assert.equal(await page.locator('#pdf-template-dialog').isVisible(), true);
  } finally { await browser.close(); if (helper) await helper.close(); }
});

test('template-driven popup renders only declared fields, validates requirements and exports exactly the visible configuration', { timeout: 120000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'omr-pdf-form-')), source = path.join(temp, 'source'), root = path.join(temp, 'review'), journalRoot = path.join(temp, 'journal');
  await mkdir(source); await writeFile(path.join(source, 'index.md'), '# Frozen specification\n\nUnchanged source with Unicode: Příliš → ✓.\n');
  const created = await authorReview({ source, store: root, rootDocument: 'index.md', actor: { id: 'creator@example.com' }, operationId: 'pdf_form_fixture', clientArtifact: path.resolve('dist/OpenMarkdownReview.html'), journalRoot });
  const storage = new NativeStorage(root, journalRoot);
  const helper = process.env.OMR_PDF_TEMPLATE_HTTP === 'true' || process.env.OMR_GO_COMPANION ? await startCompanion({ root, journalRoot: path.join(temp, 'http-journal'), html: await readFile(created.browserClientPath, 'utf8') }) : undefined;
  const browser = await chromium.launch({ headless: true, channel: 'chromium', ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  const template: PdfTemplate = { schemaVersion: 'omr-pdf-template/1', id: 'ReleaseSpec', version: '1.0.0', label: 'Release specification', distribution: 'all', cover: true, css: ':root {}',
    defaults: { title: 'TEMPLATE_TITLE', product: 'TEMPLATE_PRODUCT', confidentiality: 'TEMPLATE_NOTE' },
    coverSections: [
      { title: 'Delivery', fields: [
        { key: 'product', label: 'Product release', required: true, help: 'Use the released product name.', placeholder: 'Product 2.1' },
        { key: 'documentId', label: 'Specification number', required: true }
      ] },
      { title: 'Ownership', showEmpty: true, fields: [{ key: 'author', label: 'Prepared by' }] }
    ], pageFields: [
      { key: 'title', label: 'Specification title' },
      { key: 'division', label: 'Owning organization', required: true, help: 'Organization printed in page headers.' },
      { key: 'confidentiality', label: 'Document note' }
    ]
  };
  try {
    const page = await browser.newPage();
    if (!helper) await page.exposeFunction('omrHost', (method: string, args: unknown[]) => storageResponse(storage, method, args));
    await page.goto(helper?.url ?? pathToFileURL(created.browserClientPath).href); await page.locator('#document h1').waitFor(); await page.locator('#actor-id').fill('creator@example.com');
    const before = (await storage.list('events')).length;
    await page.locator('#export').click(); await page.locator('#pdf-template-dialog').waitFor(); await page.locator('#pdf-cover').check();
    await page.locator('#pdf-meta-project').fill('HIDDEN_PROJECT_MUST_NOT_LEAK'); await page.locator('#pdf-meta-product').fill('SHARED_TYPED_PRODUCT');
    await page.locator('#pdf-template-import summary').click();
    const load = async (value: PdfTemplate) => {
      await page.locator('#pdf-template-file').setInputFiles({ name: 'template.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
      await page.waitForFunction(label => (document.getElementById('pdf-template-select') as HTMLSelectElement).selectedOptions[0]?.textContent === 'Imported: ' + label, value.label);
    };
    await load(template);
    assert.deepEqual(await page.locator('#pdf-template-sections legend').allTextContents(), ['Delivery', 'Ownership']);
    assert.deepEqual(await page.locator('#pdf-template-sections input').evaluateAll(inputs => inputs.map(input => input.id)), ['pdf-meta-product', 'pdf-meta-documentId', 'pdf-meta-author']);
    assert.equal(await page.locator('#pdf-meta-project').count(), 0);
    assert.equal(await page.locator('#pdf-meta-classification').count(), 0);
    assert.equal(await page.locator('#pdf-meta-product').inputValue(), 'SHARED_TYPED_PRODUCT');
    assert.equal(await page.locator('#pdf-meta-product').getAttribute('placeholder'), 'Product 2.1');
    assert.equal(await page.locator('#pdf-meta-product-help').innerText(), 'Use the released product name.');
    assert.equal(await page.locator('#pdf-meta-title').inputValue(), 'TEMPLATE_TITLE');
    assert.equal(await page.locator('#pdf-page-labels').getAttribute('open'), '', 'Required page labels cannot be hidden in a collapsed section.');
    await page.locator('#pdf-export-confirm').click();
    assert.match(await page.locator('#pdf-template-error').innerText(), /Specification number is required/);
    assert.equal(await page.locator('#pdf-meta-documentId').evaluate(input => input === document.activeElement), true);
    assert.equal((await storage.list('events')).length, before);
    await page.locator('#pdf-meta-documentId').fill('DOC-USER-123');
    await page.locator('#pdf-export-confirm').click();
    assert.match(await page.locator('#pdf-template-error').innerText(), /Owning organization is required/);
    await page.locator('#pdf-meta-division').fill('USER_ORGANIZATION');
    await page.locator('#pdf-meta-product').fill('   ');
    await page.locator('#pdf-export-confirm').click(); assert.match(await page.locator('#pdf-template-error').innerText(), /Product release is required/);
    await page.locator('#pdf-meta-product').fill('USER_PRODUCT_RELEASE'); await page.locator('#pdf-meta-author').fill('USER_DOCUMENT_AUTHOR');
    // Untouched defaults follow their template. Explicit user edits, including clears, do not.
    await load({ ...template, id: 'Alternate', label: 'Alternate specification', defaults: { title: 'ALTERNATE_TITLE', product: 'ALTERNATE_PRODUCT' }, pageFields: [] });
    assert.equal(await page.locator('#pdf-meta-title').count(), 0);
    await page.locator('#pdf-template-select').selectOption('Default'); await page.locator('#pdf-cover').check();
    assert.equal(await page.locator('#pdf-meta-project').inputValue(), 'HIDDEN_PROJECT_MUST_NOT_LEAK');
    assert.equal(await page.locator('#pdf-meta-title').inputValue(), '', 'An untouched template default must not leak to another template.');
    await load(template);
    assert.equal(await page.locator('#pdf-meta-title').inputValue(), 'TEMPLATE_TITLE');
    await page.locator('#pdf-meta-title').fill('');
    await page.locator('#pdf-cover').uncheck(); await page.locator('#pdf-cover').check();
    assert.equal(await page.locator('#pdf-meta-title').inputValue(), '', 'An explicitly cleared value must not be refilled.');
    assert.equal(await page.locator('#pdf-meta-product').inputValue(), 'USER_PRODUCT_RELEASE');
    const unsafeLabels = { ...template, id: 'PlainText', label: 'Plain text', pageFields: [], coverSections: [{ title: '<img src=x onerror=alert(1)>', fields: [{ key: 'product' as const, label: '<b>Product</b>', help: '<script>throw 1</script>' }] }] };
    await load(unsafeLabels); assert.equal(await page.locator('#pdf-template-sections img,#pdf-template-sections script,#pdf-template-sections b').count(), 0);
    assert.equal(await page.locator('#pdf-template-sections legend').innerText(), unsafeLabels.coverSections[0].title);
    await load(template); await page.locator('#pdf-meta-title').fill('USER_SPECIFICATION_TITLE');
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await page.locator('#pdf-template-dialog').boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
    await page.locator('#pdf-template-dialog').evaluate(dialog => { dialog.scrollTop = 0; });
    const button = await page.locator('#pdf-export-confirm').boundingBox(); assert.ok(button && button.y + button.height <= bounds.y + bounds.height);
    await mkdir('output/pdf-export-ux', { recursive: true }); await page.screenshot({ path: 'output/pdf-export-ux/template-driven-mobile.png' });
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.locator('#pdf-template-dialog').evaluate(dialog => { dialog.scrollTop = 0; });
    await page.screenshot({ path: 'output/pdf-export-ux/template-driven.png' });
    await page.locator('#pdf-export-confirm').click();
    await page.locator('#export-result[data-kind="success"],#export-result[data-kind="error"]').waitFor({ timeout: 90000 });
    assert.equal(await page.locator('#export-result').getAttribute('data-kind'), 'success', await page.locator('#export-result-message').innerText());
    const session = new ReviewSession(storage); await session.open();
    const event = session.events.find(event => event.type === 'export.created'); assert.ok(event?.type === 'export.created');
    const inventory = JSON.parse(await readFile(path.join(root, event.inventory.path), 'utf8'));
    const receiptDigest = inventory.renderer.pdfEngine.match(/omr-pdf-template-v1=(sha256:[a-f0-9]{64})/)[1];
    const receiptFile = inventory.resources.find((file: { digest: string }) => file.digest === receiptDigest);
    const receipt = JSON.parse(await readFile(path.join(root, receiptFile.path), 'utf8'));
    assert.deepEqual(Object.keys(receipt.metadata).sort(), ['author', 'confidentiality', 'division', 'documentId', 'product', 'title']);
    assert.equal(receipt.template.coverSections[0].fields[0].required, true); assert.equal(receipt.metadata.project, undefined);
    const inspect = await (new Function('specifier', 'return import(specifier)')(pathToFileURL(path.resolve('scripts/inspect-pdf.mjs')).href) as Promise<{ inspectPdf(bytes: Uint8Array): Promise<any> }>);
    const bytes = await readFile(path.join(root, event.pdf.path)), pdf = await inspect.inspectPdf(bytes);
    assert.deepEqual(pdf.violations, []);
    const text = pdf.pages.map((page: { text: string }) => page.text).join('\n');
    for (const value of ['Delivery', 'Product release', 'Specification number', 'Ownership', 'Prepared by', 'USER_SPECIFICATION_TITLE', 'USER_PRODUCT_RELEASE', 'DOC-USER-123', 'USER_DOCUMENT_AUTHOR', 'USER_ORGANIZATION']) assert.ok(text.includes(value), value);
    for (const value of ['HIDDEN_PROJECT_MUST_NOT_LEAK', 'TEMPLATE_TITLE', 'TEMPLATE_PRODUCT', 'ALTERNATE_TITLE']) assert.ok(!text.includes(value), value);
    await mkdir('output/pdf', { recursive: true }); await writeFile('output/pdf/template-driven-configuration.pdf', bytes);
    await page.reload(); await page.locator('#document h1').waitFor(); await page.locator('#actor-id').fill('creator@example.com'); await page.locator('#export').click(); await page.locator('#pdf-template-dialog').waitFor();
    assert.equal(await page.locator('#pdf-meta-product').inputValue(), 'USER_PRODUCT_RELEASE');
    assert.equal(await page.locator('#pdf-meta-project').count(), 0, 'Only confirmed template fields survive in private settings.');
    assert.equal(await page.locator('#pdf-meta-confidentiality').inputValue(), 'TEMPLATE_NOTE');
    await page.locator('#pdf-template-select').selectOption('Default'); await page.locator('#pdf-cover').check();
    assert.equal(await page.locator('#pdf-meta-confidentiality').inputValue(), '', 'After reopening, an untouched template default is not treated as a user edit.');
    await page.locator('#pdf-template-select').selectOption('__imported');
    assert.equal(await page.locator('#pdf-meta-confidentiality').inputValue(), 'TEMPLATE_NOTE');
    await page.locator('#pdf-meta-product').fill('CANCELLED_CHANGE'); await page.locator('#pdf-template-dialog').press('Escape');
    await page.locator('#export').click(); await page.locator('#pdf-template-dialog').waitFor(); assert.equal(await page.locator('#pdf-meta-product').inputValue(), 'USER_PRODUCT_RELEASE');
    await page.locator('#pdf-template-cancel').click();
    assert.equal((await storage.list('events')).length, before + 1);
    assert.equal(await readFile(path.join(source, 'index.md'), 'utf8'), '# Frozen specification\n\nUnchanged source with Unicode: Příliš → ✓.\n');
    assert.deepEqual(session.diagnostics.filter(d => d.severity === 'error'), []);
  } finally { await browser.close(); if (helper) await helper.close(); }
});
