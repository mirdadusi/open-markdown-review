import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, Frame } from 'playwright';
import { authorReview } from '../src/professional/authoring';
import { commentFixture, initiator, owner } from './commentEdits.fixture';
import { ProfessionalHost } from '../src/professional/extensionHost';
import { memento } from './reviewer.extension.integration';
import { fold } from '../src/professional/state';
import packageJson from '../package.json';

/** Real isolated VS Code webview; no main-profile or ongoing-review mutations. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(`${packageJson.publisher}.${packageJson.name}`)!; assert.ok(extension); await extension.activate();
  const f = await commentFixture(false, path.join(extension.extensionPath, 'dist/OpenMarkdownReview.html')); await writeFile(path.join(f.source, 'index.md'), '# Latest native snapshot\n\nLatest saved text.\n');
  const next = await authorReview({ source: f.source, store: f.root, rootDocument: 'index.md', actor: initiator, operationId: 'native_comment_export_next', parents: [f.origin], journalRoot: f.journal, clientArtifact: path.join(extension.extensionPath, 'dist/OpenMarkdownReview.html') });
  const context = { globalState: memento(), workspaceState: memento(), globalStorageUri: vscode.Uri.file(path.join(f.temp, 'host-journal')), extensionPath: extension.extensionPath } as vscode.ExtensionContext;
  const host = new ProfessionalHost(context), cdp = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.OMR_TEST_CDP_PORT}`);
  try {
    await host.open(f.root, f.source, undefined, owner);
    let frame: Frame | undefined;
    for (let attempt = 0; attempt < 300 && !frame; attempt++) {
      for (const page of cdp.contexts().flatMap(c => c.pages())) for (const candidate of page.frames()) {
        if (await candidate.locator('#workspace:visible').count().catch(() => 0)) {
          const identity = await candidate.evaluate(() => (window as Window & { omrAutomation?: { session(): { storage: { identity: string } } } }).omrAutomation?.session()?.storage.identity).catch(() => '');
          if (identity === f.root) { frame = candidate; break; }
        }
      }
      if (!frame) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(frame, 'Native comment/export workbench did not open.');
    await vscode.commands.executeCommand('notifications.clearAll');
    assert.equal(await frame.locator('#revisions').inputValue(), next.revisionId);
    await frame.locator('[data-action=edit-comment][data-comment=edit_comment]').click();
    await frame.locator('#body').fill('Edited in the real VS Code client.'); await frame.locator('#save').click(); await frame.locator('#composer').waitFor({ state: 'hidden' });
    await f.session.refresh(); assert.equal(fold(f.session.events, f.origin).comments.get('edit_comment')!.body.text, 'Edited in the real VS Code client.');
    assert.equal(await frame.locator('#revisions').inputValue(), next.revisionId);
    await frame.locator('#revisions').selectOption(f.origin);
    await frame.locator('#export').click(); await frame.locator('#pdf-template-dialog').waitFor();
    assert.equal(await frame.locator('#pdf-revision').inputValue(), next.revisionId);
    await frame.locator('#pdf-revision').selectOption(f.origin); await frame.locator('#pdf-export-confirm').click();
    await frame.locator('#export-result[data-kind=success],#export-result[data-kind=error]').waitFor({ timeout: 90000 });
    assert.equal(await frame.locator('#export-result').getAttribute('data-kind'), 'success', await frame.locator('#export-result-message').innerText());
    await f.session.refresh(); const exported = f.session.events.find(e => e.type === 'export.created'); assert.ok(exported?.type === 'export.created');
    assert.equal(exported.revisionId, f.origin); const inventory = JSON.parse(await readFile(path.join(f.root, exported.inventory.path), 'utf8'));
    assert.equal(inventory.revisionId, f.origin); assert.ok(inventory.representedEventIds.includes(f.session.events.find(e => e.type === 'comment.edited')!.id));
    assert.equal(await frame.locator('#revisions').inputValue(), f.origin);
    await frame.locator('#export').click(); await frame.locator('#pdf-template-dialog').waitFor(); assert.equal(await frame.locator('#pdf-revision').inputValue(), next.revisionId); await frame.locator('#pdf-template-cancel').click();
    console.log('PASS actual VS Code: own append-only edit on original snapshot, latest export default, explicit old snapshot PDF/inventory, unchanged document pin.');
  } finally { host.dispose(); await cdp.close(); }
}
