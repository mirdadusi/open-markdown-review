import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { chromium, Frame, Page } from 'playwright';
import { actor, findingFixture } from './findingPublication.fixture';
import { memento } from './reviewer.extension.integration';
import { ProfessionalHost, PackageItem } from '../src/professional/extensionHost';
import { NativeStorage } from '../src/professional/nativeStorage';
import { nativeSourceUri, openSourceWorkspaces } from '../src/professional/workspaceSourceUi';
import packageJson from '../package.json';

async function until<T>(work: () => T | undefined | Promise<T | undefined>, message: string): Promise<NonNullable<T>> {
  const end = Date.now() + 30000;
  while (Date.now() < end) { const result = await work(); if (result) return result as NonNullable<T>; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error(message);
}
async function settled<T>(pending: PromiseLike<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([Promise.resolve(pending), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Source-link action did not settle within 30 seconds.')), 30000); })]); }
  finally { clearTimeout(timer); }
}
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(`${packageJson.publisher}.${packageJson.name}`)!; assert.ok(extension); await extension.activate();
  assert.ok((await vscode.commands.getCommands(true)).includes('openMarkdownReview.linkSourceWorkspace'));
  assert.equal(nativeSourceUri(vscode.Uri.parse('git:/virtual/a.md')), false);
  assert.equal(nativeSourceUri(vscode.Uri.parse('vscode-remote://other-host/a.md')), false);
  const initial = vscode.workspace.workspaceFolders![0]; assert.ok(initial);
  const f = await findingFixture(path.join(extension.extensionPath, 'dist/OpenMarkdownReview.html'));
  await cp(f.source, initial.uri.fsPath, { recursive: true });
  const globalState = memento(), context = { globalState, workspaceState: memento(), globalStorageUri: vscode.Uri.file(path.join(f.temp, 'host-private')), extensionPath: extension.extensionPath } as vscode.ExtensionContext;
  const host = new ProfessionalHost(context), browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.OMR_TEST_CDP_PORT}`);
  const workbench = await until<Page>(() => browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('workbench.html')), 'VS Code workbench not found.');
  const quick = workbench.locator('.quick-input-widget');
  const choice = (name: string) => quick.getByText(name, { exact: true });
  const savedSource = () => globalState.get<Array<{ root: string; source?: string }>>('professional.packages', []).find(e => e.root === f.root)?.source;
  const reviewFrame = (root: string) => until(async () => {
    for (const page of browser.contexts().flatMap(c => c.pages())) for (const candidate of page.frames()) {
      const identity = await candidate.evaluate(() => (window as Window & { omrAutomation?: { session(): { storage: { identity: string } } } }).omrAutomation?.session()?.storage.identity).catch(() => '');
      if (identity === root && await candidate.locator('#workspace:visible').count()) return candidate;
    }
  }, 'The selected review toolbox did not open.');
  const revealWorkingSource = async (surface: Frame) => {
    const control = surface.locator('#thread-finding_0 [data-action=reveal-source]');
    await control.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    await control.click();
  };
  const waitForWorkingSource = async (file: string, message: string) => {
    const expected = await realpath(file);
    await until(async () => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.scheme === 'file'
        && await realpath(editor.document.uri.fsPath).catch(() => undefined) === expected;
    }, message);
  };
  let frame: Frame | undefined;
  try {
    await host.open(f.root, undefined, undefined, actor);
    frame = await reviewFrame(f.root);
    assert.equal(savedSource(), undefined, 'Opening a review alone must not save a source link.');
    assert.equal(await frame.locator('#thread-finding_0 [data-action=link-source]').count(), 0, 'Edit source must not be replaced with a linking prerequisite.');
    const originalEvents = await readdir(path.join(f.root, 'events')), originalManifest = await readFile(path.join(f.root, 'manifest.json'));
    const initialEntry = host.active!;
    await vscode.commands.executeCommand('notifications.clearAll');

    let pending = host.linkSourceWorkspace(new PackageItem(initialEntry, true));
    await choice('Use current workspace').waitFor();
    assert.match(await quick.innerText(), /2 unchanged, 0 with saved changes/);
    const output = path.resolve('output/source-workspace'); await mkdir(output, { recursive: true });
    await workbench.screenshot({ path: path.join(output, 'use-current-workspace.png') });
    await quick.locator('input').press('Escape'); assert.equal(await settled(pending), false); assert.equal(savedSource(), undefined);
    await workbench.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ state: 'hidden' });

    pending = host.linkSourceWorkspace(f.root); await choice('Use current workspace').waitFor();
    await workbench.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await settled(pending), false); await quick.waitFor({ state: 'hidden' }); assert.equal(savedSource(), undefined);

    // No explicit linking prerequisite: this first source action binds the one
    // verified open workspace, opens the file, and never shows a source picker.
    await revealWorkingSource(frame);
    const initialSource = await realpath(initial.uri.fsPath);
    await waitForWorkingSource(path.join(initialSource, 'a.md'), 'Edit source did not open the linked working document.');
    assert.equal(savedSource(), initialSource); assert.equal(await quick.isVisible(), false);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

    // Publication also discovers source lazily. Preparation/cancellation is not
    // publication, and must not add any revision or finding event.
    const publication = await findingFixture(path.join(extension.extensionPath, 'dist/OpenMarkdownReview.html'));
    const publicationEvents = await readdir(path.join(publication.root, 'events'));
    await writeFile(path.join(initialSource, 'b.md'), '# Saved supporting draft\n\nNot yet published.\n');
    await host.open(publication.root, undefined, undefined, actor); const publicationFrame = await reviewFrame(publication.root);
    // Deliberately block a native file read, proving feedback is visible and
    // cancellation is dispatched before preparation can finish (no timing guess).
    const originalRead = NativeStorage.prototype.read; let release!: () => void, block = true;
    const gate = new Promise<void>(resolve => { release = resolve; });
    NativeStorage.prototype.read = async function (file, limit) {
      if (this.identity === publication.store.identity && file === 'manifest.json' && block) { block = false; await gate; }
      return originalRead.call(this, file, limit);
    };
    try {
      await publicationFrame.locator('#publish-documents').click(); await publicationFrame.locator('#finding-preparation-dialog').waitFor();
      const internal = host as unknown as { findingPreparations: Map<string, unknown>; findingPublication(entry: unknown, method: string, args: unknown[]): Promise<unknown> };
      const requestId = await until(() => [...internal.findingPreparations.keys()][0], 'Native preparation was not registered.');
      assert.equal(await internal.findingPublication(host.active, 'cancelFindingPreparation', [publication.origin, { id: 'different@example.com' }, requestId]), false);
      assert.equal(await internal.findingPublication(initialEntry, 'cancelFindingPreparation', [publication.origin, actor, requestId]), false);
      await publicationFrame.locator('#finding-preparation-dialog [data-cancel-preparation]').click();
      await publicationFrame.locator('#finding-preparation-dialog').waitFor({ state: 'hidden' });
      assert.equal((await readdir(path.join(publication.root, 'revisions'))).length, 1);
      assert.deepEqual(await readdir(path.join(publication.root, 'events')), publicationEvents);
    } finally { release(); NativeStorage.prototype.read = originalRead; }
    await publicationFrame.locator('#publish-documents').click(); await publicationFrame.locator('#finding-publication-dialog').waitFor();
    assert.equal(await quick.isVisible(), false);
    assert.equal(globalState.get<Array<{ root: string; source?: string }>>('professional.packages', []).find(e => e.root === publication.root)?.source, initialSource);
    await publicationFrame.locator('#finding-publication-dialog [data-cancel]').click(); await publicationFrame.locator('#finding-publication-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await readdir(path.join(publication.root, 'events')), publicationEvents);
    assert.equal((await readdir(path.join(publication.root, 'revisions'))).length, 1);
    await writeFile(path.join(initialSource, 'b.md'), await readFile(path.join(f.source, 'b.md')));

    // Adding/removing later roots does not replace the first workspace folder or
    // restart the extension host. Ambiguous copies must use the native quick pick.
    const second = path.join(f.temp, 'second-workspace'); await cp(f.source, second, { recursive: true });
    await writeFile(path.join(second, 'a.md'), '# Edited alternate source\n');
    assert.equal(vscode.workspace.updateWorkspaceFolders(1, 0, { uri: vscode.Uri.file(second), name: 'Alternate source' }), true);
    await until(() => openSourceWorkspaces().length === 2, 'Second native workspace did not open.');
    const other = await findingFixture(path.join(extension.extensionPath, 'dist/OpenMarkdownReview.html'));
    await host.open(other.root, undefined, undefined, actor);
    const otherFrame = await reviewFrame(other.root);
    await revealWorkingSource(otherFrame); await choice('Use Alternate source').waitFor();
    await quick.locator('input').press('Escape'); await quick.waitFor({ state: 'hidden' });
    assert.equal(globalState.get<Array<{ root: string; source?: string }>>('professional.packages', []).find(e => e.root === other.root)?.source, undefined, 'Canceling ambiguous lazy discovery must not link a review.');
    pending = host.linkSourceWorkspace(new PackageItem(initialEntry, false));
    await quick.waitFor({ state: 'visible' });
    await quick.getByText('Use Alternate source', { exact: true }).click(); assert.equal(await settled(pending), true);
    assert.equal(savedSource(), await realpath(second));
    assert.equal(host.active?.root, other.root, 'Explicit linking must not retarget the other active review.');
    assert.equal(globalState.get<Array<{ root: string; source?: string }>>('professional.packages', []).find(e => e.root === other.root)?.source, undefined);
    await host.open(f.root, undefined, undefined, actor);
    frame = await reviewFrame(f.root);
    await revealWorkingSource(frame);
    const secondSource = await realpath(second);
    await waitForWorkingSource(path.join(secondSource, 'a.md'), 'Relinked Edit source did not use the selected alternate workspace.');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    pending = host.linkSourceWorkspace(f.root); await quick.waitFor({ state: 'visible' }); await quick.locator('input').press('Escape');
    assert.equal(await settled(pending), false); assert.equal(savedSource(), await realpath(second), 'Cancel keeps the existing binding.');
    // A stale dialog must not reconnect a forgotten review, or retarget another.
    pending = host.linkSourceWorkspace(f.root); await choice(`Use ${initial.name}`).waitFor();
    await host.forgetReview(f.root); await choice(`Use ${initial.name}`).click();
    await assert.rejects(settled(pending), /connection changed/); assert.equal(savedSource(), undefined);

    // Exercise the real registered command from the activated distribution as
    // well as the instrumented host above. In installed-VSIX qualification this
    // is the actual packaged dist/extension.js, not an unpacked source substitute.
    await vscode.commands.executeCommand('openMarkdownReview.openPackage05', f.root);
    frame = await reviewFrame(f.root);
    await frame.locator('#actor-id').fill(actor.id); await frame.locator('#actor-name').fill(actor.displayName); await frame.locator('#actor-name').press('Tab');
    await revealWorkingSource(frame);
    await choice(`Use ${initial.name}`).click();
    await waitForWorkingSource(path.join(initialSource, 'a.md'), 'The packaged command did not link the selected working source.');
    assert.deepEqual(await readdir(path.join(f.root, 'events')), originalEvents);
    assert.deepEqual(await readFile(path.join(f.root, 'manifest.json')), originalManifest);
    assert.equal((await readdir(path.join(f.root, 'revisions'))).length, 1);
    assert.deepEqual(await readFile(path.join(initial.uri.fsPath, 'a.md')), await readFile(path.join(f.source, 'a.md')));
    console.log('PASS actual VS Code source UX: no link on open, one-click edit and publication preparation, no automatic writes/publication, explicit override, ambiguous lazy choice/cancel, remembered source, stale connection protection, packaged lazy source action.');
  } finally { host.dispose(); await browser.close(); }
}
