import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { authorReview } from '../src/professional/authoring';
import { NativeStorage } from '../src/professional/nativeStorage';
import { ReviewSession } from '../src/professional/session';
import { storageResponse } from '../src/professional/bridge';
import { pointAt } from '../src/professional/bytes';
import { reviewerRoster } from '../src/professional/reviewer';
import { fold } from '../src/professional/state';
import { startCompanion } from './companionHost';

test('PDF summary is table-only and document-list choice preserves evidence, comments, navigation and clean privacy', { timeout: 180000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'omr-pdf-summary-')), source = path.join(temp, 'source'), root = path.join(temp, 'review'), journalRoot = path.join(temp, 'journal');
  await mkdir(source);
  const markdown = '# Primary specification\n\nBODY_PRIMARY: Příliš žluťoučký kůň → ✓.\n\n[Next document](second.md)\n';
  await writeFile(path.join(source, 'index.md'), markdown);
  await writeFile(path.join(source, 'second.md'), '# Supporting specification\n\nBODY_SECONDARY: All source documents stay in either export.\n');
  const creator = { id: 'creator@example.com' };
  const created = await authorReview({ source, store: root, rootDocument: 'index.md', title: 'PDF summary fixture', actor: creator,
    reviewerEmails: ['active@example.com', 'finished@example.com', 'not-started@example.com'], operationId: 'summary_fixture', clientArtifact: path.resolve('dist/OpenMarkdownReview.html'), journalRoot });
  const storage = new NativeStorage(root, journalRoot), session = new ReviewSession(storage); await session.open();
  const manifest = await readFile(path.join(root, 'manifest.json')), revision = await readFile(path.join(root, 'revisions', created.revisionId + '.json'));
  const author = session.context(creator), invite = session.makeEvent(author, { type: 'reviewer.invited', reviewer: reviewerRoster(['late@example.com'])[0] }); await session.save(author, invite);
  const active = session.context({ id: 'active@example.com' }), start = markdown.indexOf('BODY_PRIMARY'), quote = 'BODY_PRIMARY';
  const comment = session.makeEvent(active, { type: 'comment.created', threadId: 'summary_thread', commentId: 'summary_comment', anchor: { document: 'index.md', documentDigest: session.revision!.documents.find(d => d.path === 'index.md')!.digest,
    range: { start: pointAt(markdown, start), end: pointAt(markdown, start + quote.length) }, quote: { exact: quote }, target: { kind: 'text' } }, body: { format: 'markdown', text: 'SUMMARY_FINDING preserved in native comments.' } }); await session.save(active, comment);
  const finisher = session.context({ id: 'finished@example.com' });
  await session.save(finisher, session.makeEvent(finisher, { type: 'comment.replied', threadId: 'summary_thread', commentId: 'summary_reply', inReplyTo: 'summary_comment', body: { format: 'markdown', text: 'SUMMARY_REPLY preserved with its parent.' } }));
  const approvalAudit = await session.audit(finisher), verification = await session.verificationBlob(approvalAudit, 'summary_approval');
  await session.save(finisher, session.makeEvent(finisher, { type: 'review.approved', stancePredecessors: [], verification }, 'summary_approval'));
  const finish = async (operation: string) => {
    const ctx = session.context({ id: 'finished@example.com' }), audit = await session.audit(ctx), verification = await session.verificationBlob(audit, operation);
    const event = session.makeEvent(ctx, { type: 'review.completed', completionPredecessors: fold(audit.events, ctx.revision.id).register(`completion:${ctx.revision.id}:${ctx.actor.id}`).heads.map(e => e.id), verification, note: 'DO_NOT_PRINT_COMPLETION_DETAIL' }, operation);
    await session.save(ctx, event); return event;
  };
  const firstFinish = await finish('summary_first_finish');
  const reopened = session.makeEvent(finisher, { type: 'review.reopened', completionPredecessors: [firstFinish.id], note: 'DO_NOT_PRINT_REOPEN_DETAIL' }, 'summary_reopen'); await session.save(finisher, reopened);
  const lastFinish = await finish('summary_last_finish'), before = (await storage.list('events')).length;
  const helper = process.env.OMR_PDF_TEMPLATE_HTTP === 'true' || process.env.OMR_GO_COMPANION ? await startCompanion({ root, journalRoot: path.join(temp, 'http-journal'), html: await readFile(created.browserClientPath, 'utf8') }) : undefined;
  const browser = await chromium.launch({ headless: true, channel: 'chromium', ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const page = await browser.newPage();
    if (!helper) await page.exposeFunction('omrHost', (method: string, args: unknown[]) => storageResponse(storage, method, args));
    await page.goto(helper?.url ?? pathToFileURL(created.browserClientPath).href); await page.locator('#document h1').first().waitFor(); await page.locator('#actor-id').fill(creator.id);
    await page.locator('#export').click(); await page.locator('#pdf-template-dialog').waitFor(); assert.equal(await page.locator('#pdf-document-list').isChecked(), true);
    await page.locator('#export-mode').selectOption('clean'); assert.equal(await page.locator('#pdf-document-list').isChecked(), false);
    await page.locator('#export-mode').selectOption('review'); assert.equal(await page.locator('#pdf-document-list').isChecked(), true);
    await page.locator('#pdf-document-list').uncheck(); await page.locator('#pdf-template-cancel').click();
    assert.equal((await storage.list('events')).length, before);
    await page.locator('#export').click(); await page.locator('#pdf-template-dialog').waitFor(); assert.equal(await page.locator('#pdf-document-list').isChecked(), true); await page.locator('#pdf-template-cancel').click();
    const inspect = await (new Function('specifier', 'return import(specifier)')(pathToFileURL(path.resolve('scripts/inspect-pdf.mjs')).href) as Promise<{ inspectPdf(bytes: Uint8Array): Promise<any> }>);
    await mkdir('output/pdf', { recursive: true });
    const generated: Array<{ mode: 'review' | 'clean'; list: boolean; pdf: any }> = [];
    for (const [mode, list] of [['review', true], ['review', false], ['clean', true], ['clean', false]] as const) {
      await page.locator('#export').click(); await page.locator('#pdf-template-dialog').waitFor(); await page.locator('#export-mode').selectOption(mode); await page.locator('#pdf-document-list').setChecked(list);
      assert.equal(await page.locator('#pdf-cover').isChecked(), false, 'Document-list selection must not turn on a template cover.');
      await page.locator('#pdf-export-confirm').click(); await page.locator('#export-result[data-kind="success"],#export-result[data-kind="error"]').waitFor({ timeout: 90000 });
      assert.equal(await page.locator('#export-result').getAttribute('data-kind'), 'success', await page.locator('#export-result-message').innerText());
      const relative = (await page.locator('#export-result-path').innerText()).match(/exports\/[a-f0-9]{64}\.pdf/)![0], bytes = await readFile(path.join(root, relative)), pdf = await inspect.inspectPdf(bytes);
      generated.push({ mode, list, pdf }); assert.deepEqual(pdf.violations, []);
      const text = pdf.pages.map((page: { text: string }) => page.text).join('\n').replace(/\s+/g, ' ');
      for (const body of ['BODY_PRIMARY', 'BODY_SECONDARY', 'Primary specification', 'Supporting specification']) assert.ok(text.includes(body), body);
      assert.ok(pdf.links.some((link: { targetPage?: number }) => link.targetPage), 'Document links stay usable with or without a list.');
      assert.equal(pdf.metadata.Keywords.includes('omr-document-list-v1=' + (list ? 'included' : 'omitted')), true);
      if (mode === 'review') {
        assert.equal(pdf.links.some((link: { destination?: string }) => link.destination === 'review-documents'), list);
        assert.equal(text.includes('clickable contents'), list);
        assert.ok(!/\bcutoff\b|\bstances?\b/i.test(text));
        const begin = text.indexOf('Reviewer completion and participation'), end = text.indexOf('Approvals, rejections and outcome', begin);
        assert.ok(begin >= 0 && end > begin); const table = text.slice(begin, end);
        for (const value of ['active@example.com', 'finished@example.com', 'not-started@example.com', 'late@example.com', 'In progress', 'Finished', 'Not started', 'Review decision', 'Approved']) assert.ok(table.includes(value), value);
        for (const hidden of ['Participant ID', 'Event:', 'added by', 'Recorded against revision', 'Status for revision', 'Reviewers added after creation', 'DO_NOT_PRINT_COMPLETION_DETAIL', 'DO_NOT_PRINT_REOPEN_DETAIL', firstFinish.id, reopened.id, lastFinish.id, invite.id]) assert.ok(!table.includes(hidden), hidden);
        assert.ok(pdf.annotations.some((a: { contents: string }) => a.contents.includes('SUMMARY_FINDING')));
        assert.ok(pdf.annotations.some((a: { contents: string; inReplyTo?: string }) => a.contents.includes('SUMMARY_REPLY') && a.inReplyTo));
        await session.refresh(); const event = session.events.filter(event => event.type === 'export.created').at(-1)!; assert.ok(event.type === 'export.created');
        const inventory = JSON.parse(await readFile(path.join(root, event.inventory.path), 'utf8'));
        assert.equal(inventory.renderer.pdfEngine.includes('omr-document-list-v1=' + (list ? 'included' : 'omitted')), true);
        assert.ok(Number.isFinite(Date.parse(inventory.verifiedAt)), 'Verification time remains in machine-verifiable evidence.');
        for (const id of [invite.id, firstFinish.id, reopened.id, lastFinish.id]) assert.ok(inventory.representedEventIds.includes(id));
        const rejected = await page.evaluate(async ({ revision, operation, list }) => { try { await window.omrAutomation!.export({ id: 'creator@example.com' }, revision!, operation, 'review', { includeDocumentList: !list }); return ''; } catch (error) { return String(error); } }, { revision: created.revisionId, operation: event.operationId, list });
        assert.match(rejected, /different document-list/);
      } else {
        assert.equal(text.includes('Contents'), list); assert.equal(pdf.annotations.length, 0); assert.equal(pdf.attachments, null);
        for (const hidden of [created.reviewId, created.revisionId!, 'active@example.com', 'finished@example.com', 'Reviewer completion', 'Audit appendix', 'SUMMARY_FINDING']) assert.ok(!(text + JSON.stringify(pdf.metadata)).includes(hidden), hidden);
      }
      await writeFile(`output/pdf/summary-${mode}-${list ? 'with' : 'without'}-document-list.pdf`, bytes);
    }
    assert.ok(generated[0].pdf.pageCount > generated[1].pdf.pageCount);
    assert.ok(generated[2].pdf.pageCount > generated[3].pdf.pageCount);
    assert.equal(generated[0].pdf.annotations.length, generated[1].pdf.annotations.length);
    await page.reload(); await page.locator('#document h1').first().waitFor(); await page.locator('#actor-id').fill(creator.id); await page.locator('#export').click(); await page.locator('#pdf-template-dialog').waitFor();
    assert.equal(await page.locator('#export-mode').inputValue(), 'clean'); assert.equal(await page.locator('#pdf-document-list').isChecked(), false);
    await page.locator('#export-mode').selectOption('review'); assert.equal(await page.locator('#pdf-document-list').isChecked(), false, 'The explicitly confirmed choice is remembered.');
    await page.locator('#pdf-template-cancel').click();
    const args = { revision: created.revisionId, operation: 'summary_clean_recovery' };
    const clean = await page.evaluate(async args => window.omrAutomation!.export({ id: 'creator@example.com' }, args.revision!, args.operation, 'clean', { includeDocumentList: false }), args) as { pdfPath: string };
    const resumed = await page.evaluate(async args => window.omrAutomation!.export({ id: 'creator@example.com' }, args.revision!, args.operation, 'clean', { includeDocumentList: false }), args) as { pdfPath: string };
    assert.equal(resumed.pdfPath, clean.pdfPath);
    const denied = await page.evaluate(async args => { try { await window.omrAutomation!.export({ id: 'creator@example.com' }, args.revision!, args.operation, 'clean', { includeDocumentList: true }); return ''; } catch (error) { return String(error); } }, args);
    assert.match(denied, /different document-list/);
    assert.equal((await storage.list('events')).length, before + 2, 'Only audited exports append events.');
    assert.deepEqual(await readFile(path.join(root, 'manifest.json')), manifest); assert.deepEqual(await readFile(path.join(root, 'revisions', created.revisionId + '.json')), revision);
    await session.refresh(); assert.deepEqual(session.diagnostics.filter(d => d.severity === 'error'), []);
  } finally { await browser.close(); if (helper) await helper.close(); }
});
