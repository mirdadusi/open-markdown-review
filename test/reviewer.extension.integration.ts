import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { AuthorRequest, authorReview } from '../src/professional/authoring';
import { ProfessionalHost } from '../src/professional/extensionHost';
import { ReviewsProvider } from '../src/reviewsView';
import { ThreadsProvider } from '../src/threadsView';
import { ReviewSidebar } from '../src/reviewSidebar';
import { ReviewManifest } from '../src/protocol/types';
import { removeReview, ReviewActivity } from '../src/reviewRemoval';

export function memento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return { keys: () => [...values.keys()], get: <T>(key: string, fallback?: T) => (values.has(key) ? structuredClone(values.get(key)) : fallback) as T, update: async (key, value) => { if (value === undefined) values.delete(key); else values.set(key, structuredClone(value)); } };
}
function delayedMemento() {
  const values = new Map<string, unknown>();
  let delayedKey: string | undefined, release: (() => void) | undefined, started: (() => void) | undefined;
  const memento: vscode.Memento = {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => (values.has(key) ? structuredClone(values.get(key)) : fallback) as T,
    update: async (key, value) => {
      if (key === delayedKey) {
        delayedKey = undefined;
        started?.();
        await new Promise<void>((resolve) => { release = resolve; });
      }
      if (value === undefined) values.delete(key); else values.set(key, structuredClone(value));
    },
  };
  return {
    memento,
    delayNext: (key: string) => {
      delayedKey = key;
      return {
        started: new Promise<void>((resolve) => { started = resolve; }),
        release: () => release?.(),
      };
    },
  };
}
function panelFixture() {
  const disposed = new vscode.EventEmitter<void>(), view = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
  let receive!: (message: unknown) => Promise<void>, sequence = 0;
  const messages: Array<Record<string, any>> = [];
  const panel = {
    webview: { html: '', options: {}, postMessage: async (message: Record<string, unknown>) => { messages.push(message); return true; }, onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return new vscode.Disposable(() => {}); } },
    onDidDispose: disposed.event, onDidChangeViewState: view.event, reveal: () => {}, dispose: () => disposed.fire(),
  } as unknown as vscode.WebviewPanel;
  return { panel, messages, activate: () => view.fire({ webviewPanel: { ...panel, active: true } }), request: async (method: string, args: unknown[] = []) => { const id = `fixture_${++sequence}`; await receive({ id, method, args }); const response = messages.find(item => item.id === id); assert.ok(response); return response; } };
}

/** Real authoring/VS Code host code; controlled panels expose the host-side bridge. */
export async function reviewerAndSidebar(extensionPath: string, temporary: string): Promise<void> {
  const source = path.join(temporary, 'identity-source'), root = path.join(temporary, 'identity-review'), journalRoot = path.join(temporary, 'identity-journal');
  await mkdir(source); await writeFile(path.join(source, 'a.md'), '# Identity handover\n');
  const context = { globalState: memento(), workspaceState: memento(), globalStorageUri: vscode.Uri.file(journalRoot), extensionPath } as vscode.ExtensionContext;
  const activity = new ReviewActivity(), host = new ProfessionalHost(context, activity), legacy = new ReviewsProvider(), threads = new ThreadsProvider();
  const list = new ReviewSidebar(legacy, host), active = new ReviewSidebar(legacy, host, threads);
  const panels = new Map<string, ReturnType<typeof panelFixture>>(), originalOpen = host.open.bind(host);
  host.open = async (target, source, panel, actor) => {
    if (!panels.has(target)) { const fixture = panelFixture(); panels.set(target, fixture); fixture.panel.onDidDispose(() => panels.delete(target)); panel ??= fixture.panel; }
    return originalOpen(target, source, panel, actor);
  };
  try {
    const author = { id: 'creation-reviewer', displayName: 'Creation Reviewer' };
    const request: AuthorRequest = { source, store: root, title: 'Zulu review', include: ['a.md'], rootDocument: 'a.md', actor: author, operationId: 'native_identity', journalRoot, clientArtifact: path.join(extensionPath, 'dist/OpenMarkdownReview.html') };
    await (host as unknown as { runCreation(request: AuthorRequest): Promise<void> }).runCreation(request);
    const fixture = panels.get(root)!;
    assert.deepEqual((await fixture.request('info')).value.reviewer, author, 'Creation passes both identity fields to the toolbox bridge.');
    assert.equal(host.active?.root, root); assert.equal(list.getChildren().length, 1);
    assert.equal(list.getChildren()[0].contextValue, 'markdownReview05Active'); assert.equal(active.getChildren()[0].label, host.active?.title);
    const metadata = JSON.parse(await readFile(path.join(extensionPath, 'package.json'), 'utf8'));
    assert.deepEqual(metadata.contributes.views.openMarkdownReview.map((item: { id: string }) => item.id), ['openMarkdownReview.reviews', 'openMarkdownReview.threads'], 'Only one review list and one Active Review pane are contributed.');
    const manifest = await readFile(path.join(root, 'manifest.json'), 'utf8'), events = await readdir(path.join(root, 'events'));
    const grouped = new ReviewsProvider(), secondWorkspaceRoot = path.join(temporary, 'other-workspace'), secondReviewRoot = path.join(secondWorkspaceRoot, '.review');
    grouped.setReviews([{ reviewRoot: root, manifest: JSON.parse(manifest) as ReviewManifest }], root, source);
    grouped.setWorkspaceReviews([{ reviewRoot: secondReviewRoot, manifest: { ...JSON.parse(manifest), reviewId: 'second-workspace', title: 'Second workspace review' } as ReviewManifest }], secondWorkspaceRoot);
    assert.equal(grouped.getChildren().length, 2, 'Refreshing one workspace root does not erase reviews from another root.');
    grouped.setWorkspaceSnapshot([{ sourceRoot: secondWorkspaceRoot, reviews: [{ reviewRoot: secondReviewRoot, manifest: { ...JSON.parse(manifest), reviewId: 'second-workspace', title: 'Second workspace review' } as ReviewManifest }] }], secondReviewRoot);
    assert.deepEqual(grouped.getChildren().map(item => item.label), ['Second workspace review'], 'A workspace snapshot removes only roots no longer in the workspace.');
    const alias = process.platform === 'win32' ? root.toUpperCase() : path.join(root, '.');
    // Bypass only the fixture's case-sensitive panel map, not the real host implementation.
    await originalOpen(alias);
    assert.equal(host.getChildren().length, 1, 'Reopening a path alias reuses the existing connection.');
    assert.equal(host.active?.root, root, 'The original connection and journal path spelling is retained.');
    assert.deepEqual(JSON.parse(manifest).createdBy, author);
    const participant = { id: 'local-reviewer', displayName: 'Local Reviewer' };
    assert.equal((await fixture.request('rememberReviewer', [participant])).value, true);
    assert.ok((await fixture.request('rememberReviewer', [{ id: 'bad\0id' }])).error);
    assert.deepEqual((await fixture.request('info')).value.reviewer, participant);
    assert.deepEqual(context.globalState.get<Array<{ reviewer: unknown }>>('professional.packages')![0].reviewer, participant);
    fixture.panel.dispose();
    assert.equal(host.active?.root, root, 'Closing the toolbox retains the selected review.');
    await host.forward('threads');
    const reopened = panels.get(root)!;
    assert.deepEqual((await reopened.request('info')).value.reviewer, participant);
    assert.equal(reopened.messages.filter(m => m.command === 'toolbox-action').length, 0, 'Actions wait for toolbox readiness.');
    await reopened.request('toolboxReady');
    assert.equal(reopened.messages.find(m => m.command === 'toolbox-action')?.buttonId, 'threads');
    await host.open(root, source, undefined, author);
    assert.deepEqual(reopened.messages.find(m => m.command === 'reviewer-identity')?.reviewer, author, 'An already open panel receives the explicitly chosen revision author.');

    const received = path.join(temporary, 'received-identity-review');
    await authorReview({ ...request, store: received, title: 'Alpha review', operationId: 'received_identity', actor: { id: 'someone-else', displayName: 'Someone Else' } });
    const receivedManifest = await readFile(path.join(received, 'manifest.json'));
    await host.open(received);
    assert.equal((await panels.get(received)!.request('info')).value.reviewer, undefined, 'Receiving a review never takes the creator identity from its manifest.');
    assert.equal(host.active?.root, received); assert.equal(list.getChildren().filter(i => i.contextValue === 'markdownReview05Active').length, 1);
    assert.deepEqual(list.getChildren().map(item => item.label), ['Alpha review', 'Zulu review'], 'Opening a review keeps a deterministic alphabetical list.');
    assert.equal(new Set(list.getChildren().map(item => item.id)).size, 2, 'Every list entry has a stable, unique filesystem identity.');
    reopened.activate(); assert.equal(host.active?.root, root, 'Focusing a review tab updates the active selection.');
    const restored = new ProfessionalHost(context);
    await restored.restore(); assert.equal(restored.active?.root, root, 'The local active choice survives extension restart.'); restored.dispose();
    const legacyRoot = path.join(temporary, 'legacy-review');
    legacy.setReviews([{ reviewRoot: legacyRoot, manifest: { title: 'Legacy review', reviewId: 'legacy' } as ReviewManifest }], legacyRoot, temporary);
    assert.equal(list.getChildren().length, 3); assert.equal(list.getChildren().filter(i => i.contextValue === 'markdownReview05Active' || i.contextValue === 'markdownReviewActive').length, 1);
    assert.deepEqual(list.getChildren().map(item => item.label), ['Alpha review', 'Legacy review', 'Zulu review'], 'Protocol versions share one sorted list.');
    await host.deactivate(); assert.equal(list.getChildren().find(i => i.label === 'Legacy review')?.contextValue, 'markdownReviewActive'); assert.deepEqual(active.getChildren(), []);
    assert.equal(await readFile(path.join(root, 'manifest.json'), 'utf8'), manifest);
    assert.deepEqual(await readdir(path.join(root, 'events')), events, 'Identity, switching and sidebar navigation do not modify shared review evidence.');
    const raceState = delayedMemento();
    const raceContext = { ...context, workspaceState: raceState.memento } as vscode.ExtensionContext;
    const raceHost = new ProfessionalHost(raceContext);
    const raceEntries = raceHost.getChildren();
    const alpha = raceEntries.find(item => item.entry.title === 'Alpha review')!.entry;
    const zulu = raceEntries.find(item => item.entry.title === 'Zulu review')!.entry;
    const gate = raceState.delayNext('professional.activeRoot');
    const firstSelection = (raceHost as unknown as { select(entry: typeof alpha): Promise<void> }).select(zulu);
    await gate.started;
    const secondSelection = (raceHost as unknown as { select(entry: typeof alpha): Promise<void> }).select(alpha);
    gate.release();
    await Promise.all([firstSelection, secondSelection]);
    assert.equal(raceHost.active?.root, received);
    assert.equal(raceState.memento.get('professional.activeRoot'), received, 'A slow earlier persistence write cannot overwrite the latest active review.');
    raceHost.dispose();

    await unlink(path.join(received, 'manifest.json'));
    await host.refreshList();
    assert.equal(host.getChildren().find(item => item.entry.root === received)?.entry.availability, 'unavailable');
    assert.equal(host.getChildren().length, 2, 'A temporarily unavailable shared review remains visible and retryable.');
    await writeFile(path.join(received, 'manifest.json'), receivedManifest);
    await host.refreshList();
    assert.equal(host.getChildren().find(item => item.entry.root === received)?.entry.availability, 'available');
    await host.open(root);
    const duplicate = panelFixture(); await host.open(root, source, duplicate.panel);
    const pending = [{ ...request, operationId: 'resume_removed' }, { ...request, store: received, operationId: 'keep_other_resume' }];
    await context.globalState.update('professional.pendingAuthoring', pending);
    await activity.exclusive(async () => {
      assert.match((await duplicate.request('journalPut', ['key', {}])).error, /removal is in progress/);
      const removed = await removeReview({ root, title: 'Identity', protectedPaths: [source] }, 'forget', {
        confirm: async () => true, close: () => host.closeReview(root),
        trash: async () => assert.fail('Removing from the list must not delete files'), forget: () => host.forgetReview(root),
      });
      assert.equal(removed, true);
    });
    assert.equal(host.active, undefined);
    assert.ok(!host.getChildren().some(item => item.entry.root === root));
    assert.ok(host.getChildren().some(item => item.entry.root === received), 'Other review connections are retained.');
    assert.equal(context.workspaceState.get('professional.activeRoot'), undefined);
    assert.deepEqual(context.globalState.get<AuthorRequest[]>('professional.pendingAuthoring'), [pending[1]]);
    assert.match((await reopened.request('write', ['events/late.json', [], false])).error, /closed/);
    assert.match((await duplicate.request('rememberReviewer', [author])).error, /closed/);
    duplicate.activate(); assert.equal(host.active, undefined, 'Disposed duplicate panels cannot reactivate a forgotten review.');
    const afterRemoval = new ProfessionalHost(context); await afterRemoval.restore(); assert.equal(afterRemoval.active, undefined); afterRemoval.dispose();
    assert.equal(await readFile(path.join(root, 'manifest.json'), 'utf8'), manifest);
    assert.deepEqual(await readdir(path.join(root, 'events')), events);
    const activeRoot = () => host.active?.root;
    await host.open(root); assert.equal(activeRoot(), root, 'A forgotten review can be connected again.');
    await host.forgetReview(received); assert.equal(activeRoot(), root, 'Removing an inactive review preserves the active review.');
  } finally { list.dispose(); active.dispose(); host.dispose(); }
  process.stdout.write('Creation identity handover, private persistence, unified sidebar, active selection and queued toolbox navigation passed.\n');
  process.stdout.write('Review removal: all toolbox tabs close, late writes fail, active/recovery state clears, other reviews survive and reconnect works.\n');
}
