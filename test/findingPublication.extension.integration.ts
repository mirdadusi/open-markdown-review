import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { chromium, Frame, Locator } from 'playwright';
import { actor, findingFixture } from './findingPublication.fixture';
import { memento } from './reviewer.extension.integration';
import { ProfessionalHost, PackageItem } from '../src/professional/extensionHost';
import { fold, threadWorkflowQueue } from '../src/professional/state';
import packageJson from '../package.json';

/** Actual Electron webview + native editor/authoring boundary, isolated from main VS Code. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(`${packageJson.publisher}.${packageJson.name}`)!; assert.ok(extension); await extension.activate();
  const fixture = await findingFixture(path.join(extension.extensionPath, 'dist/OpenMarkdownReview.html'));
  const context = { globalState: memento(), workspaceState: memento(), globalStorageUri: vscode.Uri.file(path.join(fixture.temp, 'host-journal')), extensionPath: extension.extensionPath } as vscode.ExtensionContext;
  const host = new ProfessionalHost(context);
  const nativePublication = (host as any).findingPublication.bind(host);
  const publicationPhases: string[] = []; let releasePublication: (() => void) | undefined;
  (host as any).findingPublication = async (entry: unknown, method: string, args: unknown[], onProgress?: (id: string, message: string) => void) => {
    if (method === 'finishFindingPublication') await new Promise<void>(resolve => { releasePublication = resolve; });
    return nativePublication(entry, method, args, (id: string, message: string) => { if (method === 'finishFindingPublication') publicationPhases.push(message); onProgress?.(id, message); });
  };
  await assert.rejects(host.publishUpdatedDocuments({ root: fixture.root }), /connected review/, 'An unrecognized explicit target must never fall back to the active review.');
  const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.OMR_TEST_CDP_PORT}`);
  try {
    assert.ok((await vscode.commands.getCommands(true)).includes('openMarkdownReview.publishUpdatedDocuments'));
    await host.open(fixture.root, fixture.source, undefined, actor);
    const originEntry = host.active!;
    const other = await findingFixture(path.join(extension.extensionPath, 'dist/OpenMarkdownReview.html'));
    await host.open(other.root, other.source, undefined, actor);
    await host.publishUpdatedDocuments(new PackageItem(originEntry, false));
    let frame: Frame | undefined;
    for (let attempt = 0; attempt < 300 && !frame; attempt++) {
      for (const page of cdp.contexts().flatMap(c => c.pages())) for (const candidate of page.frames()) {
        if (await candidate.locator('#workspace:visible').count().catch(() => 0) && await candidate.locator('#actor-id').inputValue().catch(() => '') === actor.id) {
          const identity = await candidate.evaluate(() => (window as Window & { omrAutomation?: { session(): { storage: { identity: string } } } }).omrAutomation?.session()?.storage.identity).catch(() => '');
          if (identity === fixture.root) { frame = candidate; break; }
        }
      }
      if (!frame) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(frame, 'The native finding workbench did not open.');
    const clickFindingControl = async (control: Locator) => {
      await frame!.locator('#toast.visible').waitFor({ state: 'hidden' });
      await control.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
      await control.click();
    };
    assert.equal(host.active!.root, fixture.root, 'An inactive review context argument, not the previously active review, chooses the publication destination.');
    await vscode.commands.executeCommand('notifications.clearAll');
    // Publishing unchanged source now reports a visible preparation error,
    // rather than an off-screen header message. Dismiss it before editing.
    await frame.locator('#finding-preparation-dialog [data-error]').getByText(/Source is unchanged/).waitFor();
    await frame.locator('#finding-preparation-dialog button').click();
    await frame.locator('#decision-status').selectOption('undecided'); assert.equal(await frame.locator('#threads .thread').count(), 0);
    await frame.locator('#decision-status').selectOption('accepted'); await frame.locator('#discussion-status').selectOption('closed'); assert.equal(await frame.locator('#threads .thread').count(), 2);
    await frame.locator('#show-all-findings').click();
    const finding = frame.locator('#thread-finding_0');
    await clickFindingControl(finding.locator('[data-action=reveal-source]'));
    await frame.locator('#toast.visible').getByText('Opened and selected the finding in the linked source workspace.', { exact: true }).waitFor();
    const sourceEditor = vscode.window.activeTextEditor;
    assert.ok(sourceEditor, 'The edit action opened a native source editor.');
    const document = sourceEditor.document;
    assert.equal(await realpath(document.uri.fsPath), await realpath(path.join(fixture.source, 'a.md')));
    assert.equal(document.getText(sourceEditor.selection), 'Original concern.');
    const edit = new vscode.WorkspaceEdit(); edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), '# Complete rewritten design\n\nThe entire document has been reworked.\n\n## New section\n\nThe fix is not limited to the original quote.\n\n[Implementation details](details/new.md)\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true); assert.equal(await document.save(), true);
    await writeFile(path.join(fixture.source, 'b.md'), '# Supporting chapter\n\nA change outside the anchored document.\n');
    await mkdir(path.join(fixture.source, 'details')); await writeFile(path.join(fixture.source, 'details/new.md'), '# New implementation detail\n\nNative scope addition.\n');
    // Return to the review after saving the source, as a native user would.
    // Leaving the split editor open can put the pointer target under the
    // wrapped sticky toolbar on the Windows runner's smaller display.
    await vscode.window.showTextDocument(document, { viewColumn: sourceEditor.viewColumn, preview: true });
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await host.open(fixture.root, fixture.source);
    await clickFindingControl(finding.locator('[data-action=publish-fix]')); await frame.locator('#finding-scope-dialog').waitFor();
    assert.equal(await frame.locator('[data-scope-path="details/new.md"]').isChecked(), false);
    assert.equal(await frame.locator('[data-scope-continue]').isDisabled(), true);
    await frame.locator('[data-scope-path="details/new.md"]').check(); await frame.locator('[data-scope-continue]').click(); await frame.locator('#finding-publication-dialog').waitFor();
    assert.match(await frame.locator('[aria-label="Changed documents"]').innerText(), /1 added/);
    assert.match(await frame.locator('#finding-publication-dialog').innerText(), /entire document has been reworked/);
    assert.equal(await frame.locator('[data-finding="finding_0"] [data-summary]').inputValue(), '', 'The native publication does not require an implementation note.');
    await frame.locator('[data-publish]').click(); await frame.locator('#finding-publication-dialog .publication-progress:visible').waitFor();
    assert.equal(await frame.locator('#finding-publication-dialog').getAttribute('aria-busy'), 'true');
    for (let attempt = 0; attempt < 100 && !releasePublication; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(releasePublication); releasePublication();
    await frame.locator('#finding-publication-dialog').waitFor({ state: 'hidden' });
    assert.ok(publicationPhases.some(message => message.includes('Rechecking saved source documents')));
    assert.ok(publicationPhases.some(message => message.includes('Verifying and publishing captured files')));
    assert.equal(await frame.locator('#revisions').inputValue(), fixture.origin);
    assert.match(await finding.innerText(), /Processing finished/);
    assert.equal(await finding.locator('[data-action=reply], [data-action=decide]').count(), 0);
    await clickFindingControl(finding.locator('[data-action=open-addressed]')); await frame.locator('#fix-inspection[data-ready="true"]').waitFor();
    assert.match(await frame.locator('[data-implementation]').innerText(), /entire document has been reworked/);
    assert.equal(await frame.locator('#revisions').inputValue(), fixture.origin);
    await frame.locator('#fix-view').selectOption('source'); await frame.locator('[data-implementation] pre').getByText(/# Complete rewritten design/).waitFor();
    assert.equal(await frame.locator('[data-verify]').count(), 0);
    await frame.locator('[data-close]').click();
    await fixture.session.refresh(); const threads = fold(fixture.session.events, fixture.origin).threads;
    assert.equal(threadWorkflowQueue(threads[0]), 'implemented'); assert.equal(threads[0].open, false);
    assert.equal(fixture.session.events.filter(e => e.type === 'thread.verification.recorded').length, 0);
    assert.equal(threadWorkflowQueue(threads[1]), 'accepted-not-implemented');
    assert.ok(fixture.session.revisions.get(threads[0].addressed!.toRevisionId)!.documents.some(doc => doc.path === 'details/new.md'));
    assert.match(threads[0].addressed!.summary, /Implementation recorded in published snapshot .* for a\.md\./);
    // A historical implemented finding may still have an open discussion.
    const originContext = fixture.session.context(actor, fixture.origin);
    await fixture.session.save(originContext, fixture.session.makeEvent(originContext, { type: 'thread.reopened', threadId: 'finding_0', reason: 'Close independently of implementation.', statusPredecessors: threads[0].status.heads.map(e => e.id) }));
    await frame.locator('#refresh').click(); await finding.locator('[data-action=resolve]').waitFor();
    await clickFindingControl(finding.locator('[data-action=resolve]')); await frame.locator('#save').click(); await frame.locator('#composer').waitFor({ state: 'hidden' });
    await fixture.session.refresh(); const independentlyClosed = fold(fixture.session.events, fixture.origin).threads[0];
    assert.equal(independentlyClosed.open, false); assert.equal(independentlyClosed.addressed!.id, threads[0].addressed!.id); assert.equal(threadWorkflowQueue(independentlyClosed), 'implemented');
    await frame.locator('#revisions').selectOption(threads[0].addressed!.toRevisionId);
    assert.equal(await frame.locator('#threads .thread').count(), 2, 'Publishing or viewing a newer snapshot cannot hide original findings by default.');
    assert.match(await finding.locator('.finding-origin').innerText(), /From another snapshot/);
    await clickFindingControl(finding.locator('[data-action=open-addressed]')); await frame.locator('#fix-inspection[data-ready=true]').waitFor();
    assert.match(await frame.locator('[data-original]').innerText(), /Original concern/);
    assert.equal(await frame.locator('#revisions').inputValue(), threads[0].addressed!.toRevisionId);
    await frame.locator('[data-close]').click();
    const sameIssue = frame.locator('#thread-finding_1');
    await clickFindingControl(sameIssue.locator('.finding-more>summary')); await clickFindingControl(sameIssue.locator('[data-action=record-addressed]'));
    await frame.locator('#composer:visible').waitFor();
    assert.match((await frame.locator('#choice option').allTextContents()).join(' '), /Snapshot 2.*recorded fix/);
    assert.ok((await frame.locator('#choice option').allTextContents()).every(label => !label.includes('revision_')));
    assert.equal(await frame.locator('#choice').inputValue(), threads[0].addressed!.toRevisionId);
    await frame.locator('[data-preview-snapshot]').click(); await frame.locator('#fix-inspection[data-ready=true]').waitFor();
    assert.match(await frame.locator('[data-implementation]').innerText(), /A change outside the anchored document/);
    await frame.locator('[data-close]').click(); await frame.locator('#save').click(); await frame.locator('#composer').waitFor({ state: 'hidden' });
    await fixture.session.refresh(); assert.equal(fold(fixture.session.events, fixture.origin).threads[1].addressed!.toRevisionId, threads[0].addressed!.toRevisionId);
    assert.equal((await readdir(path.join(fixture.root, 'revisions'))).length, 2);
    assert.equal((await readdir(path.join(other.root, 'revisions'))).length, 1, 'The other review was untouched.');
    const output = path.resolve('output/finding-workflow'); await mkdir(output, { recursive: true });
    await frame.page().screenshot({ path: path.join(output, 'actual-vscode-workbench.png') });
    console.log('PASS actual VS Code: explicit review target, whole-document editing and new-file scope, completed processing without verification, independent discussion closure, readable published-fix picker, read-only preview and snapshot reuse.');
  } finally { releasePublication?.(); host.dispose(); await cdp.close(); }
}
