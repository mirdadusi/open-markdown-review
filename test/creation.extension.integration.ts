import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { reviewSetupHtml, reviewSetupSubmission, ReviewSetupDefaults } from '../src/setupView';
import { ProfessionalHost } from '../src/professional/extensionHost';
import { AuthorRequest } from '../src/professional/authoring';
import { NativeStorage } from '../src/professional/nativeStorage';
import { ReviewSession } from '../src/professional/session';
import { COMPANION_TARGETS } from '../src/professional/companionTargets';
import { nativeTarget } from './nativeCompanion';
import { memento } from './reviewer.extension.integration';

export async function creationSetup(extensionPath: string, temporary: string): Promise<void> {
  const source = path.join(temporary, 'creation-source'), root = path.join(temporary, 'created-platform-review'); await mkdir(source);
  await writeFile(path.join(source, 'index.md'), '# Platform selection\n\nExact review source.\n');
  const context = { extensionPath, extensionUri: vscode.Uri.file(extensionPath), globalState: memento(), workspaceState: memento(), globalStorageUri: vscode.Uri.file(path.join(temporary, 'creation-private')) } as vscode.ExtensionContext;
  const defaults: ReviewSetupDefaults = { initialized: false, workspaceName: 'Creation fixture', title: 'Selected platform review', availableDocuments: ['index.md'], selectedDocuments: ['index.md'], rootDocument: 'index.md', sourceRoot: source, storageRoot: root, storageEditable: true, portableBrowserDefault: true };
  const webview = { cspSource: 'https://creation.example', asWebviewUri: (uri: vscode.Uri) => vscode.Uri.parse('https://creation.example/' + path.basename(uri.fsPath)) } as unknown as vscode.Webview;
  const html = reviewSetupHtml(context, webview, defaults), browser = await chromium.launch({ headless: true, channel: 'chromium', ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  let payload: Record<string, unknown>;
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => { const state = window as unknown as { submissions: Record<string, unknown>[]; acquireVsCodeApi: () => unknown }; state.submissions = []; state.acquireVsCodeApi = () => ({ postMessage: (message: Record<string, unknown>) => state.submissions.push(message) }); });
    await page.route('https://creation.example/**', async route => {
      const name = new URL(route.request().url()).pathname;
      await route.fulfill({ contentType: name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: name === '/' ? html : await readFile(path.join(extensionPath, 'media', name.slice(1))) });
    });
    await page.goto('https://creation.example/');
    assert.equal(await page.locator('input[name="companion-target"]').count(), 3);
    for (const target of COMPANION_TARGETS) await page.locator(`input[value="${target.id}"]`).check();
    await page.locator('#reviewer-emails').fill('alex@example.com\nsam@example.com'); await page.locator('#submit').click();
    payload = await page.evaluate(() => (window as unknown as { submissions: Record<string, unknown>[] }).submissions.at(-1)!);
    const validated = reviewSetupSubmission(defaults, payload); assert.deepEqual(validated.errors, []);
    assert.deepEqual(validated.result?.companionTargets, COMPANION_TARGETS.map(target => target.id));
    assert.deepEqual(validated.result?.reviewerEmails, ['alex@example.com', 'sam@example.com']);
    assert.ok(reviewSetupSubmission(defaults, { ...payload, companionTargets: ['unsupported'] }).errors.length);
    assert.ok(reviewSetupSubmission(defaults, { ...payload, companionTargets: ['win32-x64', 'win32-x64'] }).errors.length);
    assert.deepEqual(reviewSetupSubmission({ ...defaults, initialized: true }, payload).result?.companionTargets, [], 'Revision creation never changes companion distribution.');
    payload.companionTargets = process.env.OMR_TEST_COMPANION ? [nativeTarget()] : [];
  } finally { await browser.close(); }
  const selected = reviewSetupSubmission(defaults, payload).result!, host = new ProfessionalHost(context);
  try {
    await (host as unknown as { runCreation(request: AuthorRequest): Promise<void> }).runCreation({ source, store: selected.storageRoot, title: selected.title, include: selected.documentPaths, rootDocument: selected.rootDocument, reviewerEmails: selected.reviewerEmails, companionTargets: selected.companionTargets, actor: { id: 'creator@example.com' }, operationId: 'extension_platform_selection', clientArtifact: path.join(extensionPath, 'dist/OpenMarkdownReview.html'), journalRoot: context.globalStorageUri.fsPath });
    assert.equal(host.active?.root, root, 'Created review becomes active in the VS Code sidebar.');
    const session = new ReviewSession(new NativeStorage(root, context.globalStorageUri.fsPath)); await session.open();
    assert.equal(session.manifest.reviewers?.length, 2); assert.equal(session.events.length, 1);
    for (const id of selected.companionTargets ?? []) assert.ok((await readdir(root)).includes(COMPANION_TARGETS.find(target => target.id === id)!.filename));
  } finally { host.dispose(); await vscode.commands.executeCommand('workbench.action.closeAllEditors'); }
  process.stdout.write('Creation form: three platform checkboxes, participant handover, native validation, shared authoring and active-review registration passed.\n');
}
