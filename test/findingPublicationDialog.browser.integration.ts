import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { FindingPublicationPreview, FindingSelection } from '../src/professional/findingPublication';

test('compact publication picker: optional notes, grouped unfinished work, lazy completed history and exact partial retry', { timeout: 60000 }, async () => {
  const script = await build({ stdin: { contents: `import { FindingPublicationDialog } from './src/professional/findingPublicationDialog'; window.testDialog = new FindingPublicationDialog();`, resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', write: false });
  const browser = await chromium.launch({ headless: true, ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addStyleTag({ content: await readFile('media/professional.css', 'utf8') }); await page.addScriptTag({ content: script.outputFiles[0].text });
    const preview: FindingPublicationPreview = { operationId: 'finding_dialog', reviewTitle: 'Neutral design review', originRevisionId: 'revision_old', revisionId: 'revision_new', parents: ['revision_old'], sourceRoot: '/source', destination: '/review', documents: [{ path: 'a.md', changed: true, before: 'Original', after: 'Updated', truncated: false, afterDigest: 'sha256:123' }], resources: [], findings: [
      ...Array.from({ length: 90 }, (_, index) => ({ threadId: `done_${index}`, document: 'a.md', quote: `Implemented concern ${index}`, addressed: true, workflow: 'implemented' as const, open: false })),
      { threadId: 'pending_a', document: 'a.md', quote: 'Unfinished first concern', body: 'Explain the design.', author: 'Reviewer A', addressed: false, workflow: 'accepted-not-implemented', open: false },
      { threadId: 'pending_b', document: 'b.md', quote: 'Unfinished second concern', author: 'Reviewer B', addressed: false, workflow: 'accepted-not-implemented', open: true }
    ] };
    const intents: FindingSelection[][] = [];
    await page.exposeFunction('submitPreview', (selections: FindingSelection[]) => {
      intents.push(selections);
      return { revisionId: preview.revisionId, originRevisionId: preview.originRevisionId, records: selections.map((selection, index) => ({ threadId: selection.threadId, saved: intents.length > 1 || index === 0, ...(intents.length === 1 && index !== 0 ? { error: 'Disconnected.' } : {}) })) };
    });
    await page.evaluate(preview => { const win = window as any; void win.testDialog.show(preview, 'pending_a', win.submitPreview, async () => {}); }, preview);
    assert.equal(await page.locator('[data-finding]').count(), 2); assert.equal(await page.locator('[data-completed-content] p').count(), 0);
    assert.equal(await page.locator('[data-completed-count]').innerText(), '90');
    await page.locator('[data-completed-findings]>summary').click(); await page.locator('.publication-completed').nth(49).waitFor(); assert.equal(await page.locator('.publication-completed').count(), 50);
    await page.locator('[data-more-completed]').click(); await page.locator('.publication-completed').nth(89).waitFor(); assert.equal(await page.locator('.publication-completed').count(), 90);
    assert.equal(await page.locator('[data-completed-findings] input').count(), 0);
    await page.locator('[data-completed-findings]>summary').click();
    assert.equal(await page.locator('[data-finding="pending_a"] [data-summary]').isVisible(), true);
    assert.equal(await page.locator('[data-finding="pending_b"] [data-summary]').isVisible(), false);
    await page.locator('[data-finding-search]').fill('Reviewer B');
    assert.equal(await page.locator('[data-finding="pending_a"]').isVisible(), true, 'A selected finding stays visible when search matches another.');
    await page.locator('[data-finding="pending_b"] [data-selected]').check();
    await page.setViewportSize({ width: 352, height: 900 });
    assert.equal(await page.locator('#finding-publication-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), true);
    await page.locator('[data-publish]').click(); await page.locator('[data-publish]').getByText('Retry pending records', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-completed-count]').innerText(), '91');
    assert.equal(await page.locator('[data-finding="pending_a"]').isVisible(), false);
    assert.equal(await page.locator('[data-finding="pending_b"] [data-summary]').isVisible(), true);
    await page.locator('[data-publish]').click(); await page.locator('#finding-publication-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(intents[0], [{ threadId: 'pending_a', summary: '' }, { threadId: 'pending_b', summary: '' }]); assert.deepEqual(intents[1], intents[0]);
    // Reopened recovery can have omitted notes and a deliberately non-DOM selection order.
    const recovery = { ...preview, preparedSelections: [{ threadId: 'pending_b' }, { threadId: 'pending_a', summary: '' }], pending: { revisionId: preview.revisionId, originRevisionId: preview.originRevisionId, records: [{ threadId: 'pending_a', saved: true }, { threadId: 'pending_b', saved: false }] } };
    await page.evaluate(preview => { const win = window as any; void win.testDialog.show(preview, undefined, win.submitPreview, async () => {}); }, recovery);
    assert.equal(await page.locator('[data-finding]').count(), 1);
    await page.locator('[data-publish]').click(); await page.locator('#finding-publication-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(intents[2], recovery.preparedSelections, 'A retry retains omitted properties, saved records and exact ordering.');
  } finally { await browser.close(); }
});
