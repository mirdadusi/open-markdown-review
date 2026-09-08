import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorReview } from '../src/professional/authoring';
import { digest } from '../src/professional/bytes';

/** Actual extension host smoke test; browser tests separately exercise shared UI actions. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('mirdadusi.open-markdown-review');
  assert.ok(extension); await extension.activate(); assert.ok(extension.isActive);
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['initialize', 'connectReview', 'openPackage05', 'updatePortableBrowserClient', 'addComment', 'exportPdf']) assert.ok(commands.includes(`openMarkdownReview.${name}`), `Missing command: ${name}`);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omr-extension-')), source = path.join(temporary, 'source'), root = path.join(temporary, 'review');
  await mkdir(source); await writeFile(path.join(source, 'a.md'), '# Extension-host review\n\nExact frozen source.\n');
  await authorReview({ source, store: root, rootDocument: 'a.md', actor: { id: 'author' }, operationId: 'extension_test', journalRoot: path.join(temporary, 'journal'), clientArtifact: path.join(extension.extensionPath, 'dist/OpenMarkdownReview.html') });
  const before = digest(await readFile(path.join(root, 'manifest.json'))), names = await readdir(path.join(root, 'events'));
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(path.join(root, 'OpenMarkdownReview.html')), 'openMarkdownReview.entryFile');
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(tab?.input instanceof vscode.TabInputCustom); assert.equal(tab.input.viewType, 'openMarkdownReview.entryFile');
  await vscode.commands.executeCommand('openMarkdownReview.openPackage05', root);
  assert.equal(digest(await readFile(path.join(root, 'manifest.json'))), before);
  assert.deepEqual(await readdir(path.join(root, 'events')), names, 'Opening the entry file must not create protocol events.');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  process.stdout.write('VS Code activation, contributed commands, same-file custom editor and read-only opening passed.\n');
}
