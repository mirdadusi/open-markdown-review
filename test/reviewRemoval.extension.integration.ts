import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ReviewController } from '../src/extension';
import { ReviewsProvider, RegisteredReview } from '../src/reviewsView';
import { ThreadsProvider } from '../src/threadsView';
import { memento } from './reviewer.extension.integration';

export async function legacyRemoval(extensionPath: string, temporary: string): Promise<void> {
  const source = path.join(temporary, 'legacy-removal-source'), root = path.join(source, '.review');
  await mkdir(root, { recursive: true });
  const manifest = { protocol: 'open-markdown-review', protocolVersion: '0.4.0', reviewId: 'legacy_removal', title: 'Legacy removal fixture', createdAt: '2026-09-10T10:00:00.000Z', createdBy: { id: 'author' }, documents: ['a.md'], eventDirectory: 'events', revisionDirectory: 'revisions', blobDirectory: 'blobs/sha256', exportDirectory: 'exports', capabilities: ['quote-anchor-v1', 'range-anchor-v1', 'content-addressed-resources-v1'] };
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  const context = { globalState: memento(), workspaceState: memento(), globalStorageUri: vscode.Uri.file(path.join(temporary, 'legacy-removal-cache')), extensionUri: vscode.Uri.file(extensionPath) } as vscode.ExtensionContext;
  const list = new ReviewsProvider(), controller = new ReviewController(context, new ThreadsProvider(), list);
  const folder: vscode.WorkspaceFolder = { uri: vscode.Uri.file(source), name: 'Legacy fixture', index: 0 };
  const internal = controller as unknown as {
    registeredReviews(folder: vscode.WorkspaceFolder, force?: boolean): Promise<RegisteredReview[]>;
    registerReview(folder: vscode.WorkspaceFolder, root: string): Promise<void>;
    activeStorageRootFor(folder: vscode.WorkspaceFolder): Promise<string>;
    currentStorageRoot?: string; currentManifest?: unknown;
    workspaceFolderForDocument(): vscode.WorkspaceFolder;
  };
  internal.workspaceFolderForDocument = () => folder;
  try {
    assert.equal((await internal.registeredReviews(folder)).length, 1);
    const alias = process.platform === 'win32' ? root.toUpperCase() : path.join(root, '.');
    await internal.registerReview(folder, alias); await internal.activeStorageRootFor(folder);
    assert.equal(list.getChildren().length, 1, 'Casing aliases must not create duplicate review entries.');
    internal.currentStorageRoot = root; internal.currentManifest = manifest;
    assert.equal(list.getChildren()[0].contextValue, 'markdownReviewActive');
    await controller.forgetReview(alias);
    assert.equal(controller.hasActiveReview, false); assert.equal(list.getChildren().length, 0);
    assert.equal((await internal.registeredReviews(folder, true)).length, 0, 'Automatic discovery must not resurrect a forgotten package.');
    await controller.refresh(undefined, 'manual');
    assert.equal(controller.hasActiveReview, false, 'The .review default fallback must not reactivate a removed review.');
    assert.equal(list.getChildren().length, 0);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')), manifest);
    await internal.registerReview(folder, root);
    assert.equal((await internal.registeredReviews(folder, true)).length, 1, 'Explicit reconnection clears suppression.');
  } finally { controller.dispose(); }
  process.stdout.write('Legacy review removal clears active state, survives refresh/discovery and allows explicit reconnection.\n');
}
