import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import { authorReview } from '../src/professional/authoring';
import { NativeStorage } from '../src/professional/nativeStorage';
import { storageResponse } from '../src/professional/bridge';
import { ReviewSession } from '../src/professional/session';
import { pointAt, jsonBytes } from '../src/professional/bytes';
import { publishBlob } from '../src/professional/storage';

test('real browser SVG sanitizer permits legacy declarations but rejects active markup and external/entity payloads', { timeout: 45000 }, async () => {
  const bundle = await build({ entryPoints: ['src/professional/assets.ts'], bundle: true, platform: 'browser', format: 'iife', globalName: 'SvgTest', write: false });
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage(), requests: string[] = [];
    await page.route(/^https?:\/\//, route => { requests.push(route.request().url()); return route.abort(); });
    await page.setContent('<html><body></body></html>'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(() => {
      const sanitize = (window as unknown as { SvgTest: { sanitizeSvg(s: string): string } }).SvgTest.sanitizeSvg;
      const legacy = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">';
      const safe = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#2458a6"/></svg>';
      const bad = [
        safe.replace('/>', '/><script>alert(1)</script>'), safe.replace('<rect', '<rect onload="alert(1)"'),
        safe.replace('<rect', '<foreignObject/><rect'), safe.replace('<rect', '<image href="https://attacker.invalid/image"/><rect'),
        safe.replace('<rect', '<style>rect{fill:url(https://attacker.invalid/fill)}</style><rect'),
        '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///private/secret">]>' + safe,
        legacy.replace('www.w3.org', 'attacker.invalid') + safe,
      ];
      return { normalized: sanitize(legacy + safe), rejected: bad.map(value => { try { sanitize(legacy + value); return false; } catch { return true; } }) };
    });
    assert.ok(!result.normalized.includes('DOCTYPE')); assert.ok(result.normalized.includes('<rect'));
    assert.ok(result.rejected.every(Boolean)); assert.deepEqual(requests, []);
  } finally { await browser.close(); }
});

test('folder picker runs inside the click handler and managed-policy denial leaves actionable feedback', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.showDirectoryPicker = async () => {
        document.documentElement.dataset.pickerInClick = document.documentElement.dataset.clickStack ?? 'false';
        throw new DOMException('The request is not allowed by the user agent or the platform in the current context.', 'NotAllowedError');
      };
    });
    await page.goto(pathToFileURL(path.resolve('dist/OpenMarkdownReview.html')).href);
    await page.evaluate(() => {
      document.documentElement.dataset.clickStack = 'true';
      (document.getElementById('connect') as HTMLButtonElement).click();
      document.documentElement.dataset.clickStack = 'false';
    });
    await page.waitForFunction(() => document.getElementById('status')!.textContent!.includes('managed FileSystem policies'));
    assert.equal(await page.locator('html').getAttribute('data-picker-in-click'), 'true');
    assert.equal(await page.locator('#open-progress').isVisible(), false);
    assert.equal(await page.locator('#connect').isEnabled(), true);
    assert.match(await page.locator('#status').innerText(), /cannot override browser policy/);
  } finally { await browser.close(); }
});

test('archival PDF: printable wide/nested tables, natural-size images, Unicode, local links and front-page review information', { timeout: 120000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omr-pdf-layout-')), source = path.join(temporary, 'source'), root = path.join(temporary, 'review'), journalRoot = path.join(temporary, 'journal');
  await mkdir(source); const unicode = 'Příliš žluťoučký kůň - αβΓΔ Ω μ µ ± ≤ ≥ ≠ × − → ← ↔ ␣ ✓ ✗';
  const identifier = 'lldpXPnoConfigPortStatusTxEnable_LongMachineIdentifier_1234567890'.repeat(3);
  const markdown = `# Printable review\n\n${unicode}\n\n[Second document](second.md#risky-table) · [HTML bookmark](second.md#details) · [External evidence](https://example.com/evidence)\n\n![Small icon](small.svg)\n\n<img src="large.svg" width="120" alt="Declared size">\n\n| Identifier | Description |\n| --- | --- |\n| ${identifier} | Long prose must wrap without expanding every column or clipping a table. |\n\n<table><tr><th>Object</th><th>Picture and nested data</th></tr><tr><td>Nested image</td><td><img src="large.svg" alt="Cell picture"><table><tr><th>A</th><th>B</th></tr><tr><td>${identifier}</td><td>Nested value</td></tr></table></td></tr></table>\n\n\`\`\`text\n  ${identifier}\n  ${unicode}\n\`\`\`\n`;
  const richMarkdown = markdown + '\n<table><thead><tr><th rowspan="2">Merged proof</th><th colspan="2">Group header</th></tr><tr><th>First</th><th>Second</th></tr></thead><tbody><tr><td>Row label</td><td>Span value A</td><td>Span value B</td></tr></tbody></table>\n\n```mermaid\nflowchart LR\n  A[Žaneta] --> B[Review]\n```\n';
  await writeFile(path.join(source, 'index.md'), richMarkdown);
  await writeFile(path.join(source, 'second.md'), `# Second document\n\n## Risky table\n\n| Parameter | MF | PN | Type | Default | Short meaning |\n| --- | --- | --- | --- | --- | --- |\n${Array.from({ length: 70 }, (_, i) => `| Parameter_${i}_${identifier} | 32768 | true | UInt32 | 2880 | This column contains a substantial human-readable explanation, ${unicode}. |`).join('\n')}\n\n<a id="details"></a>\n\n${unicode}\n`);
  await writeFile(path.join(source, 'small.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="#2458a6"/></svg>');
  await writeFile(path.join(source, 'large.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="800"><rect width="1600" height="800" fill="#3d8260"/><text x="30" y="100" font-size="60">Frozen diagram</text></svg>');
  const author = { id: 'author@example.com', displayName: 'Žaneta - initiator' };
  const created = await authorReview({ source, store: root, rootDocument: 'index.md', title: 'PDF quality - Příliš žluťoučký', actor: author, reviewerEmails: ['finished@example.com', 'ongoing@example.com', 'reopened@example.com', 'waiting@example.com'], operationId: 'pdf_layout_fixture', clientArtifact: path.resolve('dist/OpenMarkdownReview.html'), journalRoot });
  const store = new NativeStorage(root, journalRoot), session = new ReviewSession(store); await session.open();
  const finished = session.context({ id: 'finished@example.com', displayName: 'Finished reviewer' }), ongoing = session.context({ id: 'ongoing@example.com', displayName: 'Ongoing reviewer' }), reopened = session.context({ id: 'reopened@example.com', displayName: 'Reopened reviewer' });
  const start = markdown.indexOf('Příliš'), end = start + unicode.length;
  const threadId = 'thread_pdf_layout';
  const rootComment = session.makeEvent(ongoing, { type: 'comment.created', threadId, commentId: 'comment_pdf_layout', anchor: { document: 'index.md', documentDigest: session.revision!.documents.find(d => d.path === 'index.md')!.digest, range: { start: pointAt(markdown, start), end: pointAt(markdown, end) }, quote: { exact: unicode, prefix: '', suffix: '' }, target: { kind: 'text' } }, body: { format: 'markdown', text: `CHALLENGE_VISIBLE_AT_FRONT: Check the symbols ${unicode}` } });
  await session.save(ongoing, rootComment);
  await session.save(finished, session.makeEvent(finished, { type: 'comment.replied', threadId, commentId: 'reply_pdf_layout', inReplyTo: 'comment_pdf_layout', body: { format: 'markdown', text: 'RESPONSE_VISIBLE_AT_FRONT: Příliš → response ␣ ✓' } }));
  const finishedVerification = await publishBlob(store, 'verify_pdf_finished', jsonBytes((await session.audit(finished)).inventory), 'application/json');
  await session.save(finished, session.makeEvent(finished, { type: 'review.completed', completionPredecessors: [], verification: finishedVerification }));
  const reopenedVerification = await publishBlob(store, 'verify_pdf_reopened', jsonBytes((await session.audit(reopened)).inventory), 'application/json');
  const completion = session.makeEvent(reopened, { type: 'review.completed', completionPredecessors: [], verification: reopenedVerification });
  await session.save(reopened, completion);
  await session.save(reopened, session.makeEvent(reopened, { type: 'review.reopened', completionPredecessors: [completion.id], note: 'Recheck requested' }));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage(); await page.route(/^https?:\/\//, route => route.abort());
    await page.exposeFunction('omrHost', (method: string, args: unknown[]) => storageResponse(store, method, args));
    await page.goto(pathToFileURL(created.browserClientPath).href); await page.waitForSelector('#document .diagram svg');
    const previewDiagramRatio = await page.locator('#document .diagram svg').evaluate((svg: SVGSVGElement) => svg.viewBox.baseVal.width / svg.viewBox.baseVal.height);
    const result = await page.evaluate(async revision => window.omrAutomation!.export({ id: 'author@example.com' }, revision!, 'pdf_layout_export'), created.revisionId) as { pdfPath: string };
    const inspect = await (new Function('specifier', 'return import(specifier)')(pathToFileURL(path.resolve('scripts/inspect-pdf.mjs')).href) as Promise<{ inspectPdf(bytes: Uint8Array): Promise<{ pages: Array<{ number: number; text: string; width: number; height: number }>; violations: unknown[]; links: Array<{ destination?: string; targetPage?: number; url?: string }>; images: Array<{ left: number; right: number; top: number; bottom: number }> }> }>);
    const inspected = await inspect.inspectPdf(await readFile(path.join(root, result.pdfPath)));
    assert.deepEqual(inspected.violations, [], 'Every page, not selected screenshots, must fit the printable area with valid links and glyphs.');
    const participants = inspected.pages.find(p => p.text.includes('Reviewer completion and participation'))!;
    const comments = inspected.pages.find(p => p.text.includes('CHALLENGE_VISIBLE_AT_FRONT'))!;
    assert.ok(participants.number <= 3); assert.ok(comments.number <= 5);
    for (const value of ['finished@example.com', 'ongoing@example.com', 'reopened@example.com', 'waiting@example.com', 'Finished', 'In progress', 'Reopened', 'Not started']) assert.ok(participants.text.includes(value), value);
    const compact = inspected.pages.map(p => p.text).join('').replace(/[\s\u200b]+/gu, '');
    assert.ok(compact.includes(unicode.replace(/\s/gu, ''))); assert.ok(compact.includes('RESPONSE_VISIBLE_AT_FRONT:'.replace(/\s/gu, '')));
    assert.ok(inspected.pages.some(p => p.width > p.height), 'Wide tables use landscape document pages.');
    assert.equal(inspected.images.length, 4, 'No standalone image, table-cell image or Mermaid diagram disappears.');
    const diagramImage = inspected.images[3]; assert.ok(Math.abs((diagramImage.right - diagramImage.left) / (diagramImage.top - diagramImage.bottom) - previewDiagramRatio) < 0.01, 'The PDF diagram preserves the preview aspect ratio.');
    for (const text of ['Merged proof', 'Group header', 'Span value A', 'Span value B']) assert.ok(compact.includes(text.replace(/\s/gu, '')));
    assert.ok(inspected.images.some(image => Math.abs(image.right - image.left - 18) < 0.1), 'A 24-pixel icon remains 18 points wide.');
    assert.ok(inspected.images.some(image => Math.abs(image.right - image.left - 90) < 0.1), 'An HTML image width of 120 pixels becomes 90 points.');
    assert.ok(inspected.links.some(link => link.destination?.startsWith('heading_') && link.targetPage));
    assert.ok(inspected.links.some(link => link.url === 'https://example.com/evidence'));
    assert.ok(inspected.links.some(link => link.destination === `finding-${rootComment.id}`));
    await writeFile(path.join(source, 'index.md'), richMarkdown + '\nUnsupported PDF glyph: \u{10ffff}\n');
    const next = await authorReview({ source, store: root, rootDocument: 'index.md', actor: author, parents: [created.revisionId!], operationId: 'pdf_unsupported_glyph', clientArtifact: path.resolve('dist/OpenMarkdownReview.html'), journalRoot });
    await page.reload(); await page.waitForFunction(revision => window.omrAutomation?.session()?.revision?.id === revision, next.revisionId, { timeout: 45000 });
    const denied = await page.evaluate(async revision => { try { await window.omrAutomation!.export({ id: 'author@example.com' }, revision!, 'no_silent_glyph_loss'); return ''; } catch (error) { return (error as Error).message; } }, next.revisionId);
    assert.match(denied, /U\+10FFFF.*No archive was published/);
    assert.equal(await page.evaluate(() => window.omrAutomation!.session()!.events.filter(e => e.type === 'export.created').length), 1);
    process.stdout.write(`PDF layout qualification fixture: ${path.join(root, result.pdfPath)}\n`);
  } finally { await browser.close(); }
});
