import * as vscode from 'vscode';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ReviewSetupPanel } from '../setupView';
import { findMarkdownFiles } from '../protocol/snapshot';
import { authorReview, AuthorRequest, installClient, installedClientFile, parseClientBinding, updateClient } from './authoring';
import { NativeStorage } from './nativeStorage';
import { storageRequest } from './bridge';
import { ReviewSession } from './session';
import { digest, newId, parseJson } from './bytes';
import { ActorRef, LIMITS, Policy } from './types';
import { validate } from './validation';
import { applyAcceptedSuggestion } from './applySuggestion';
import { SLIDEV_ID, SLIDEV_VERSION } from './profiles/slidev';
import { SlidevOptions } from './profiles/slidevCapture';
import { reviewerIdentity } from './reviewer';
import { ReviewActivity } from '../reviewRemoval';
import { reviewPathKey, sameReviewPath } from '../reviewPaths';
import { mapWithConcurrency } from '../protocol/concurrency';
import { inspectSourceBinding, relocateReviewPackage } from './relocation';

export interface Entry { root: string; title: string; source?: string; reviewer?: ActorRef; reviewId?: string; availability?: 'available' | 'unavailable'; unavailableReason?: string }
export class PackageItem extends vscode.TreeItem {
  constructor(readonly entry: Entry, active: boolean) {
    super(entry.title, vscode.TreeItemCollapsibleState.None);
    const unavailable = entry.availability === 'unavailable';
    this.id = `review:${reviewPathKey(entry.root)}`;
    this.description = `${active ? 'Active · ' : ''}${unavailable ? 'Unavailable · ' : ''}${entry.root}`;
    this.tooltip = unavailable ? `${entry.root}\n\nTemporarily unavailable: ${entry.unavailableReason ?? 'The package could not be read.'}` : entry.root;
    this.iconPath = new vscode.ThemeIcon(unavailable ? 'warning' : active ? 'pass-filled' : 'archive');
    this.contextValue = active ? 'markdownReview05Active' : 'markdownReview05Inactive';
    this.command = { command: 'openMarkdownReview.switchReview', title: 'Make review active', arguments: [this] };
  }
}
export class ProfessionalHost implements vscode.TreeDataProvider<PackageItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>(); readonly onDidChangeTreeData = this.changed.event;
  private entries: Entry[]; private panels = new Map<string, vscode.WebviewPanel>(); private selected?: Entry;
  private activationGeneration = 0;
  private selectionPersistence?: Promise<void>;
  private selectionPersistenceRequested = false;
  private registryPersistence?: Promise<void>;
  private registryPersistenceRequested = false;
  private readonly revisions = new Map<string, boolean>();
  private readonly readyPanels = new Set<vscode.WebviewPanel>();
  private readonly pendingActions = new Map<vscode.WebviewPanel, unknown[]>();
  private readonly panelRoots = new Map<vscode.WebviewPanel, string>();
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  get active() { return this.selected; }
  constructor(private readonly context: vscode.ExtensionContext, private readonly activity = new ReviewActivity()) {
    const saved = context.globalState.get<Entry[]>('professional.packages', []), seen = new Set<string>();
    this.entries = saved.filter((entry): entry is Entry => !!entry && typeof entry.root === 'string' && path.isAbsolute(entry.root) && typeof entry.title === 'string' && !!entry.title.trim())
      .filter(entry => { const key = reviewPathKey(entry.root); if (seen.has(key)) return false; seen.add(key); return true; })
      .map(entry => ({ root: entry.root, title: entry.title, ...(entry.source ? { source: entry.source } : {}), ...(entry.reviewer ? { reviewer: entry.reviewer } : {}), ...(entry.reviewId ? { reviewId: entry.reviewId } : {}) }))
      .sort(this.compareEntries);
  }
  get sourceRoots(): string[] { return this.entries.flatMap(e => e.source ? [e.source] : []); }
  closeReview(root: string): void {
    for (const [panel, panelRoot] of this.panelRoots) if (sameReviewPath(panelRoot, root)) panel.dispose();
  }
  async forgetReview(root: string): Promise<void> {
    this.closeReview(root);
    this.entries = this.entries.filter(e => !sameReviewPath(e.root, root));
    for (const key of this.revisions.keys()) if (sameReviewPath(key, root)) this.revisions.delete(key);
    await this.persistEntries();
    // Retain private journals as evidence, but do not offer a resume that recreates this folder.
    const pending = this.context.globalState.get<AuthorRequest[]>('professional.pendingAuthoring', []);
    await this.context.globalState.update('professional.pendingAuthoring', pending.filter(p => !sameReviewPath(p.store, root)));
    if (sameReviewPath(this.active?.root, root)) await this.deactivate();
    else this.changed.fire();
  }
  getChildren() { return this.entries.map(e => new PackageItem(e, sameReviewPath(e.root, this.active?.root))); }
  getTreeItem(item: PackageItem) { return item; }
  getActiveChildren(): vscode.TreeItem[] {
    if (!this.active) return [];
    const title = new vscode.TreeItem(this.active.title); title.description = 'Active review'; title.tooltip = this.active.root;
    title.iconPath = new vscode.ThemeIcon('pass-filled'); title.command = { command: 'openMarkdownReview.openReview', title: 'Open review toolbox' };
    return [title, ...[['Comments', 'threads', 'comment-discussion'], ['Suggested edits', 'suggestions', 'diff'], ['Review history', 'history', 'history']].map(([label, section, icon]) => {
      const item = new vscode.TreeItem(label); item.iconPath = new vscode.ThemeIcon(icon);
      item.command = { command: 'openMarkdownReview.showPackageSection', title: `Open ${label.toLowerCase()}`, arguments: [section] }; return item;
    })];
  }
  private readonly compareEntries = (left: Entry, right: Entry): number => left.title.localeCompare(right.title) || left.root.localeCompare(right.root);
  private entryFor(argument?: unknown): Entry | undefined {
    if (argument instanceof PackageItem) return this.entries.find(entry => sameReviewPath(entry.root, argument.entry.root));
    if (typeof argument === 'string') return this.entries.find(entry => sameReviewPath(entry.root, argument));
    return this.active;
  }
  private replaceEntry(previous: Entry, replacement: Entry): void {
    this.entries = this.entries.map(entry => sameReviewPath(entry.root, previous.root) ? replacement : entry).sort(this.compareEntries);
    if (sameReviewPath(this.selected?.root, previous.root)) this.selected = replacement;
    this.changed.fire();
  }
  private persistedEntries(): Entry[] {
    return this.entries.map(({ root, title, source, reviewer, reviewId }) => ({ root, title, ...(source ? { source } : {}), ...(reviewer ? { reviewer } : {}), ...(reviewId ? { reviewId } : {}) }));
  }
  private persistEntries(): Promise<void> {
    this.registryPersistenceRequested = true;
    if (!this.registryPersistence) {
      const running = this.drainEntryPersistence();
      this.registryPersistence = running;
      void running.then(() => { if (this.registryPersistence === running) this.registryPersistence = undefined; }, () => { if (this.registryPersistence === running) this.registryPersistence = undefined; });
    }
    return this.registryPersistence;
  }
  private async drainEntryPersistence(): Promise<void> {
    do {
      this.registryPersistenceRequested = false;
      await this.context.globalState.update('professional.packages', this.persistedEntries());
    } while (this.registryPersistenceRequested);
  }
  private persistSelection(): Promise<void> {
    this.selectionPersistenceRequested = true;
    if (!this.selectionPersistence) {
      const running = this.drainSelectionPersistence();
      this.selectionPersistence = running;
      void running.then(() => { if (this.selectionPersistence === running) this.selectionPersistence = undefined; }, () => { if (this.selectionPersistence === running) this.selectionPersistence = undefined; });
    }
    return this.selectionPersistence;
  }
  private async drainSelectionPersistence(): Promise<void> {
    do {
      this.selectionPersistenceRequested = false;
      const entry = this.selected;
      await Promise.all([
        this.context.workspaceState.update('professional.activeRoot', entry?.root),
        vscode.commands.executeCommand('setContext', 'openMarkdownReview.initialized', !!entry),
        vscode.commands.executeCommand('setContext', 'openMarkdownReview.hasRevision', !!entry && !!this.revisions.get(entry.root)),
        vscode.commands.executeCommand('setContext', 'openMarkdownReview.hasUnresolved', false),
      ]);
    } while (this.selectionPersistenceRequested);
  }
  private async select(entry: Entry, generation = ++this.activationGeneration): Promise<void> {
    if (generation !== this.activationGeneration) return;
    this.selected = entry; this.changed.fire();
    this.status.text = `$(comment-discussion) ${entry.title}`; this.status.tooltip = `Active review: ${entry.root}`;
    this.status.command = 'openMarkdownReview.openReview'; this.status.show();
    await this.persistSelection();
  }
  async deactivate(): Promise<void> {
    this.activationGeneration++;
    this.selected = undefined; this.status.hide(); this.changed.fire();
    await this.persistSelection();
  }
  async restore(): Promise<void> {
    return this.activity.run(() => this.restoreImpl());
  }
  private async restoreImpl(): Promise<void> {
    const generation = ++this.activationGeneration;
    const saved = this.context.workspaceState.get<string>('professional.activeRoot'), entry = this.entries.find(e => sameReviewPath(e.root, saved));
    if (!entry || this.active) return;
    const session = new ReviewSession(new NativeStorage(entry.root, this.journalRoot)); await session.open();
    if (this.active || generation !== this.activationGeneration) return;
    this.revisions.set(entry.root, !!session.revision); await this.select(entry, generation);
  }
  dispose() { this.changed.dispose(); this.status.dispose(); for (const panel of this.panelRoots.keys()) panel.dispose(); }
  private get journalRoot() { return path.join(this.context.globalStorageUri.fsPath, 'professional'); }
  private get artifact() { return path.join(this.context.extensionPath, 'dist', 'OpenMarkdownReview.html'); }
  /** Refresh only lightweight manifest metadata; unavailable shared folders stay visible and retryable. */
  async refreshList(discoveredRoots?: readonly string[]): Promise<void> {
    await this.activity.run(async () => {
      const discovered = discoveredRoots ?? (await vscode.workspace.findFiles('**/manifest.json', '**/{.git,node_modules,out,dist}/**', 200)).map(uri => path.dirname(uri.fsPath));
      const candidates = new Map<string, { entry: Entry; registered: boolean }>();
      for (const entry of this.entries) candidates.set(reviewPathKey(entry.root), { entry, registered: true });
      for (const root of discovered) {
        const key = reviewPathKey(root);
        if (!candidates.has(key)) candidates.set(key, { entry: { root, title: path.basename(root) }, registered: false });
      }
      const inspectedKeys = new Set(candidates.keys());
      const inspected = await mapWithConcurrency([...candidates.entries()], 4, async ([candidateKey, { entry, registered }]): Promise<{ candidateKey: string; entry: Entry } | undefined> => {
        try {
          const storage = new NativeStorage(entry.root, this.journalRoot);
          const manifest = validate('manifest', parseJson(await storage.read('manifest.json', LIMITS.manifest), LIMITS.manifest));
          return { candidateKey, entry: { ...entry, root: storage.identity, title: manifest.title, reviewId: manifest.reviewId, availability: 'available', unavailableReason: undefined } };
        } catch (error) {
          if (!registered) return undefined;
          return { candidateKey, entry: { ...entry, availability: 'unavailable', unavailableReason: error instanceof Error ? error.message : String(error) } };
        }
      });
      const currentByKey = new Map(this.entries.map(entry => [reviewPathKey(entry.root), entry]));
      const refreshed = new Map<string, Entry>();
      for (const result of inspected) {
        if (!result) continue;
        const initial = candidates.get(result.candidateKey)?.entry;
        const current = currentByKey.get(result.candidateKey);
        // Connecting the same review or changing its reviewer while a slow share is
        // being inspected produces a new entry object. Keep that newer state.
        const entry = current && current !== initial ? current : result.entry;
        refreshed.set(reviewPathKey(entry.root), entry);
      }
      // Do not lose a review connected while manifest reads were in flight.
      for (const entry of this.entries) if (!inspectedKeys.has(reviewPathKey(entry.root))) refreshed.set(reviewPathKey(entry.root), entry);
      const next = [...refreshed.values()].sort(this.compareEntries);
      const before = JSON.stringify(this.entries);
      this.entries = next;
      await this.persistEntries();
      if (JSON.stringify(this.entries) !== before) this.changed.fire();
    });
  }
  private async actor(): Promise<ActorRef | undefined> {
    const configuration = vscode.workspace.getConfiguration('openMarkdownReview');
    const id = configuration.get<string>('actorId') || await vscode.window.showInputBox({ title: 'Reviewer ID (self-asserted)', prompt: 'Stable identity included in every event', ignoreFocusOut: true, validateInput: v => !v.trim() ? 'Reviewer ID is required.' : undefined });
    if (!id) return; const displayName = configuration.get<string>('actorName') || await vscode.window.showInputBox({ title: 'Display name', ignoreFocusOut: true });
    return { id: id.trim(), ...(displayName?.trim() ? { displayName: displayName.trim() } : {}) };
  }
  private async newSourceRoot(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 1) return folders[0].uri.fsPath;
    if (folders.length > 1) {
      const activeFolder = vscode.window.activeTextEditor ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri) : undefined;
      const choices = [
        ...folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, source: folder.uri.fsPath, picked: folder === activeFolder })),
        { label: 'Choose another folder…', description: 'Use a source folder outside this VS Code workspace', source: undefined as string | undefined, picked: false },
      ];
      const chosen = await vscode.window.showQuickPick(choices, { title: 'Choose the Markdown source root', ignoreFocusOut: true });
      if (!chosen) return undefined;
      if (chosen.source) return chosen.source;
    }
    return (await vscode.window.showOpenDialog({ title: 'Choose Markdown source folder', canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use as source workspace' }))?.[0]?.fsPath;
  }
  async linkSourceWorkspace(argument?: unknown): Promise<boolean> {
    const entry = this.entryFor(argument);
    if (!entry) throw new Error('Open or choose a protocol 0.5 review first.');
    const selected = await vscode.window.showOpenDialog({ title: `Link local source workspace for “${entry.title}”`, defaultUri: entry.source ? vscode.Uri.file(entry.source) : vscode.workspace.workspaceFolders?.[0]?.uri, canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Inspect source workspace' });
    const candidate = selected?.[0]?.fsPath; if (!candidate) return false;
    const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking local source against the frozen review', cancellable: false }, () => inspectSourceBinding(entry.root, candidate, this.journalRoot));
    if (report.missing.length) {
      await vscode.window.showErrorMessage(`The selected source workspace is missing ${report.missing.length} of ${report.documents} reviewed Markdown files.`, { modal: true, detail: report.missing.slice(0, 12).join('\n') + (report.missing.length > 12 ? `\n… and ${report.missing.length - 12} more` : '') });
      return false;
    }
    const action = 'Link source workspace';
    const accepted = await vscode.window.showInformationMessage(`Link this private source workspace to “${entry.title}”?`, { modal: true, detail: `${report.sourceRoot}\n\n${report.exact.length} document${report.exact.length === 1 ? '' : 's'} still match frozen evidence; ${report.changed.length} changed document${report.changed.length === 1 ? '' : 's'} can form a later revision. This native path stays in local VS Code state and is never written into the shared package.` }, action);
    if (accepted !== action) return false;
    const replacement = { ...entry, source: report.sourceRoot };
    this.replaceEntry(entry, replacement); await this.persistEntries(); await this.persistSelection();
    const panel = [...this.panelRoots].find(([, root]) => sameReviewPath(root, entry.root))?.[0];
    if (panel) await panel.webview.postMessage({ command: 'source-binding', canApply: true });
    void vscode.window.showInformationMessage(`Local source linked: ${report.sourceRoot}`);
    return true;
  }
  async publishReviewPackage(argument?: unknown): Promise<void> {
    const entry = this.entryFor(argument);
    if (!entry) throw new Error('Open or choose a protocol 0.5 review first.');
    const selected = await vscode.window.showOpenDialog({ title: `Choose an empty shared destination for “${entry.title}”`, defaultUri: vscode.Uri.file(path.dirname(entry.root)), canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use empty destination' });
    const destination = selected?.[0]?.fsPath; if (!destination) return;
    if (sameReviewPath(destination, entry.root)) throw new Error('The selected destination is already the active review package.');
    if (this.entries.some(other => !sameReviewPath(other.root, entry.root) && sameReviewPath(other.root, destination))) throw new Error('The selected destination is already connected as another review.');
    const pending = this.context.globalState.get<AuthorRequest[]>('professional.pendingAuthoring', []);
    if (pending.some(request => sameReviewPath(request.store, entry.root))) throw new Error('This review has an unfinished authoring operation. Resume or discard that operation before publishing a copy.');
    const action = 'Publish verified copy';
    const accepted = await vscode.window.showWarningMessage(`Publish “${entry.title}” to the selected folder?`, { modal: true, detail: `Source package:\n${entry.root}\n\nDestination:\n${destination}\n\nStop browser, VS Code and CLI writers on the source while copying. The complete destination will be byte-verified and fully validated before VS Code switches to it. The old package remains on disk but will be disconnected locally.` }, action);
    if (accepted !== action) return;
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Publishing and verifying the complete review package', cancellable: false }, () => this.activity.exclusive(() => relocateReviewPackage(entry.root, destination)));
    this.closeReview(entry.root);
    this.entries = this.entries.filter(current => !sameReviewPath(current.root, entry.root));
    for (const key of this.revisions.keys()) if (sameReviewPath(key, entry.root)) this.revisions.delete(key);
    await this.persistEntries();
    await this.open(result.destinationRoot, entry.source, undefined, entry.reviewer);
    void vscode.window.showInformationMessage(`Verified review published to ${result.destinationRoot}. ${result.files} files (${(result.byteLength / 1024 / 1024).toFixed(1)} MB) were copied. The previous package remains at ${entry.root} and is no longer connected.`);
  }
  async create(revise = false): Promise<void> {
    const pending = this.context.globalState.get<AuthorRequest[]>('professional.pendingAuthoring', []);
    if (pending.length) {
      const choice = await vscode.window.showQuickPick([{ label: 'Start a new capture', description: 'Keep existing recovery plans', request: undefined as AuthorRequest | undefined }, ...pending.map(request => ({ label: `Resume: ${request.title ?? path.basename(request.source)}`, description: request.store, detail: `Saved operation ${request.operationId}`, request }))], { title: 'Saved authoring operations are available', ignoreFocusOut: true });
      if (!choice) return;
      if (choice.request) { await this.runCreation(choice.request, true); return; }
    }
    let entry = revise ? this.active : undefined;
    if (entry && !entry.source) {
      if (!await this.linkSourceWorkspace(entry.root)) return;
      entry = this.entryFor(entry.root);
    }
    const source = entry?.source ?? await this.newSourceRoot();
    if (!source) return;
    const dirty = vscode.workspace.textDocuments.filter(d => d.isDirty && d.uri.scheme === 'file' && d.uri.fsPath.startsWith(source + path.sep));
    if (dirty.length) { const answer = await vscode.window.showWarningMessage('Review creation freezes saved disk bytes. Save modified source files first?', { modal: true }, 'Save and continue', 'Use disk bytes'); if (!answer) return; if (answer === 'Save and continue' && (await Promise.all(dirty.map(d => d.save()))).some(ok => !ok)) throw new Error('Some source files could not be saved.'); }
    const files = await findMarkdownFiles(source); if (!files.length) throw new Error('No Markdown files were found in the selected source folder.');
    const storageRoot = entry?.root ?? path.join(source, '.review');
    let session: ReviewSession | undefined;
    if (entry) { session = new ReviewSession(new NativeStorage(storageRoot, this.journalRoot)); await session.open(); }
    const selected = await ReviewSetupPanel.show(this.context, { initialized: !!entry, workspaceName: path.basename(source), title: entry?.title ?? path.basename(source), availableDocuments: files, selectedDocuments: session?.revision?.documents.map(d => d.path) ?? files, rootDocument: session?.revision?.rootDocument ?? files[0], sourceRoot: source, storageRoot, storageEditable: !entry, portableBrowserDefault: true });
    if (!selected) return;
    const format = session ? session.manifest.extensions?.some(e => e.id === SLIDEV_ID) ? 'slidev' : 'markdown' : (await vscode.window.showQuickPick([
      { label: 'Markdown documents', description: 'Standard Markdown, Mermaid, tables and images', key: 'markdown' },
      { label: 'Slidev presentation', description: `Freeze the selected root deck with Slidev ${SLIDEV_VERSION}; imported slides are included automatically`, key: 'slidev' }
    ], { title: 'Review format', ignoreFocusOut: true }))?.key;
    if (!format) return;
    let slidev: SlidevOptions | undefined;
    if (format === 'slidev') {
      const notes = await vscode.window.showQuickPick([
        { label: 'Exclude speaker notes', description: 'Remove trailing note comments from shared Markdown; inspect slide images before sharing', value: 'excluded' as const },
        { label: 'Include speaker notes', description: 'Notes are shared with reviewers and included in the audit PDF', value: 'included' as const }
      ], { title: 'Speaker-note sharing policy', ignoreFocusOut: true });
      if (!notes) return;
      slidev = { notes: notes.value, trustProject: true };
    }
    const options = await vscode.window.showQuickPick([{ label: 'Set an approval quorum', key: 'policy', description: 'Choose eligible reviewer IDs and required approvals' }, { label: 'Allow resources from additional folders', key: 'resources', description: 'Explicitly grant local images/attachments outside the source folder' }], { title: 'Optional review settings — leave empty to keep the current/default policy and source folder only', canPickMany: true, ignoreFocusOut: true });
    if (!options) return;
    let resourceRoots: string[] | undefined, policy: Policy | undefined;
    if (session?.revision) policy = validate('policy', parseJson(await session.content(session.revision.policy), LIMITS.policy));
    if (options.some(o => o.key === 'resources')) {
      const folders = await vscode.window.showOpenDialog({ title: 'Grant additional image/attachment folders', canSelectFiles: false, canSelectFolders: true, canSelectMany: true });
      if (!folders?.length) return; resourceRoots = folders.map(f => f.fsPath);
    }
    if (options.some(o => o.key === 'policy')) {
      const ids = await vscode.window.showInputBox({ title: 'Eligible reviewer IDs', prompt: 'Comma-separated stable, self-asserted IDs. This does not authenticate users.', ignoreFocusOut: true, validateInput: v => !v.trim() ? 'Enter at least one ID.' : undefined });
      if (!ids) return; const eligibleActorIds = [...new Set(ids.split(',').map(id => id.trim()).filter(Boolean))];
      const minimum = await vscode.window.showInputBox({ title: 'Minimum approvals', value: String(eligibleActorIds.length), ignoreFocusOut: true, validateInput: v => !/^\d+$/.test(v) || Number(v) < 1 || Number(v) > eligibleActorIds.length ? `Enter 1–${eligibleActorIds.length}.` : undefined });
      if (!minimum) return;
      policy = validate('policy', { schemaVersion: '0.5.0', kind: 'review-policy', mode: 'quorum-v1', eligibleActorIds, minimumApprovals: Number(minimum), blockOnRejection: true, requireResolvedThreads: true, requireClosedSuggestions: true });
    }
    const actor = await this.actor(); if (!actor) return;
    let parents: string[] | undefined;
    if (session) {
      const selectedParents = await vscode.window.showQuickPick([...session.revisions.values()].map(r => ({ label: r.id, description: session!.heads.some(h => h.id === r.id) ? 'Current head' : 'Historical revision', picked: session!.heads.some(h => h.id === r.id) })), { title: 'Select explicit revision parents (multiple means merge)', canPickMany: true, ignoreFocusOut: true });
      if (!selectedParents?.length) return; parents = selectedParents.map(p => p.label);
    }
    const operationId = newId('author');
    const request = { source, store: selected.storageRoot, title: selected.title, include: slidev ? [selected.rootDocument] : selected.documentPaths, rootDocument: selected.rootDocument, actor, operationId, parents, policy, resourceRoots, slidev, clientArtifact: this.artifact, journalRoot: this.journalRoot };
    await this.runCreation(request);
  }
  private async runCreation(request: AuthorRequest, resume = false): Promise<void> {
    if (request.slidev) {
      if (!vscode.workspace.isTrusted) throw new Error('Slidev authoring runs project code and requires a trusted workspace. Receiving/reviewing a frozen package does not.');
      const accepted = await vscode.window.showWarningMessage(`Create a static Slidev review from ${request.rootDocument} and its imports? This runs the installed Slidev ${SLIDEV_VERSION}, themes and components with your permissions. Only run a project you trust. No dependencies are installed automatically.`, { modal: true }, 'Run trusted Slidev capture');
      if (!accepted) return;
    }
    const pending = this.context.globalState.get<AuthorRequest[]>('professional.pendingAuthoring', []);
    if (!pending.some(p => p.operationId === request.operationId && p.store === request.store)) await this.context.globalState.update('professional.pendingAuthoring', [...pending, request]);
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Capturing Markdown, Mermaid, images and attachments', cancellable: true }, async (progress, token) => {
      const controller = new AbortController(), subscription = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) controller.abort();
      try { return await authorReview({ ...request, resume, signal: controller.signal, progress: message => progress.report({ message }) }); }
      finally { subscription.dispose(); }
    });
    if (result.outcome === 'review-created-client-failed') throw new Error(`Revision was published, but HTML installation failed: ${result.error}. Use Add Portable Browser Client to finish.`);
    await this.context.globalState.update('professional.pendingAuthoring', this.context.globalState.get<AuthorRequest[]>('professional.pendingAuthoring', []).filter(p => p.operationId !== request.operationId || p.store !== request.store));
    await this.open(result.store, request.source, undefined, request.actor);
  }
  async open(root: string, source?: string, editorPanel?: vscode.WebviewPanel, initialReviewer?: ActorRef): Promise<void> {
    const generation = ++this.activationGeneration;
    return this.activity.run(() => this.openImpl(root, source, editorPanel, initialReviewer, generation));
  }
  private async openImpl(root: string, source: string | undefined, editorPanel: vscode.WebviewPanel | undefined, initialReviewer: ActorRef | undefined, generation: number): Promise<void> {
    const previous = this.entries.find(e => sameReviewPath(e.root, root));
    // Preserve the original connection/journal identity across Windows casing aliases.
    const storage = new NativeStorage(previous?.root ?? root, this.journalRoot), session = new ReviewSession(storage); await session.open();
    const configuration = vscode.workspace.getConfiguration('openMarkdownReview');
    // Only locally chosen identities may prefill the toolbox, never manifest.createdBy.
    const reviewer = reviewerIdentity(initialReviewer) ?? reviewerIdentity(previous?.reviewer) ?? reviewerIdentity({ id: configuration.inspect<string>('actorId')?.globalValue, displayName: configuration.inspect<string>('actorName')?.globalValue });
    const entry: Entry = { root: storage.identity, title: session.manifest.title, reviewId: session.manifest.reviewId, source: source ?? previous?.source, ...(reviewer ? { reviewer } : {}), availability: 'available' };
    this.entries = [entry, ...this.entries.filter(e => !sameReviewPath(e.root, entry.root))].sort(this.compareEntries);
    this.revisions.set(entry.root, session.revisions.size > 0);
    const shouldActivate = generation === this.activationGeneration;
    if (shouldActivate) await this.select(entry, generation);
    else this.changed.fire();
    await this.persistEntries();
    const existing = this.panels.get(entry.root);
    if (existing && !editorPanel) {
      if (shouldActivate) existing.reveal();
      if (initialReviewer && reviewer) await existing.webview.postMessage({ command: 'reviewer-identity', reviewer });
      return;
    }
    if (!shouldActivate && !editorPanel) return;
    const panel = editorPanel ?? vscode.window.createWebviewPanel('openMarkdownReview.professional', `${entry.title} — Review`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    panel.title = `${entry.title} — Review`;
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.panels.set(entry.root, panel);
    this.panelRoots.set(panel, entry.root);
    panel.onDidDispose(() => { this.panelRoots.delete(panel); if (this.panels.get(entry.root) === panel) this.panels.delete(entry.root); this.readyPanels.delete(panel); this.pendingActions.delete(panel); });
    panel.onDidChangeViewState(e => { const current = this.entries.find(item => sameReviewPath(item.root, entry.root)); if (e.webviewPanel.active && current && this.panelRoots.has(panel)) void this.select(current); });
    panel.webview.onDidReceiveMessage(async message => {
      if (!message || typeof message.id !== 'string' || typeof message.method !== 'string' || !Array.isArray(message.args)) return;
      let finish = () => {};
      try {
        if (!this.panelRoots.has(panel)) throw new Error('This review toolbox has been closed. Reconnect the review to continue.');
        if (['write', 'journalPut', 'applySuggestion', 'rememberReviewer'].includes(message.method)) finish = this.activity.begin();
        if (message.method === 'toolboxReady') {
          this.readyPanels.add(panel);
          for (const action of this.pendingActions.get(panel) ?? []) await panel.webview.postMessage(action);
          this.pendingActions.delete(panel); await panel.webview.postMessage({ id: message.id, value: true });
        } else if (message.method === 'rememberReviewer') {
          const reviewer = message.args.length === 1 ? reviewerIdentity(message.args[0]) : undefined;
          if (!reviewer) throw new Error('Enter a reviewer ID of 1–128 characters without control characters, and an optional display name.');
          this.entries = this.entries.map(e => sameReviewPath(e.root, entry.root) ? { ...e, reviewer } : e).sort(this.compareEntries);
          await this.persistEntries();
          await panel.webview.postMessage({ id: message.id, value: true });
        } else if (message.method === 'applySuggestion') {
          const source = this.entries.find(current => sameReviewPath(current.root, entry.root))?.source;
          if (!source) throw new Error('This connection has no linked source workspace. Use “Link Local Source Workspace” before applying an edit.');
          const [revisionId, suggestionId, operationId] = message.args;
          if (![revisionId, suggestionId, operationId].every(v => typeof v === 'string')) throw new Error('Invalid source-apply request.');
          const fresh = new ReviewSession(storage); await fresh.open(); await fresh.pin(revisionId);
          const root = fresh.events.find(e => e.type === 'suggestion.created' && e.suggestionId === suggestionId);
          if (root?.type !== 'suggestion.created') throw new Error('Suggestion not found.');
          const uri = vscode.Uri.file(path.join(source, ...root.anchor.document.split('/')));
          const editor = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
          if (editor?.isDirty) throw new Error('The source editor has unsaved changes. Save or discard them explicitly before applying this edit.');
          const choice = await vscode.window.showWarningMessage(`Apply accepted edit to ${root.anchor.document}? This changes the saved source file, not the frozen review.`, { modal: true }, 'Apply accepted edit');
          if (choice !== 'Apply accepted edit') throw new Error('Source application cancelled.');
          const actor = await this.actor(); if (!actor) throw new Error('Source application cancelled.');
          if (editor?.isDirty) throw new Error('The source editor changed during confirmation.');
          const value = await applyAcceptedSuggestion({ store: storage, source, revisionId, suggestionId, operationId, expectedSourceDigest: root.anchor.documentDigest, actor, resume: true });
          await panel.webview.postMessage({ id: message.id, value });
        } else {
          const connected = this.entries.find(e => sameReviewPath(e.root, entry.root));
          await panel.webview.postMessage({ id: message.id, value: message.method === 'info' ? { identity: storage.identity, writable: true, canApply: !!connected?.source, canRememberReviewer: true, canNotifyReady: true, reviewer: connected?.reviewer } : await storageRequest(storage, message.method, message.args) });
        }
      }
      catch (error) { await panel.webview.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code }); }
      finally { finish(); }
    });
    panel.webview.html = await readFile(this.artifact, 'utf8');
  }
  async resolveEntryFile(uri: vscode.Uri, panel: vscode.WebviewPanel): Promise<void> {
    if (uri.scheme !== 'file') throw new Error('Review entry files must be on a local or mounted filesystem.');
    if (path.basename(uri.fsPath).startsWith('Review-')) {
      const binding = parseClientBinding(await readFile(uri.fsPath));
      if (!binding) throw new Error('This review-named launcher has no valid package binding. Recreate it from a trusted client.');
      const manifest = await readFile(path.join(path.dirname(uri.fsPath), 'manifest.json'));
      const parsed = validate('manifest', parseJson(manifest, LIMITS.manifest));
      if (binding.reviewId !== parsed.reviewId || binding.manifestDigest !== digest(manifest)) throw new Error('This launcher belongs to a different or changed review package. Open the matching launcher or connect the folder explicitly.');
    }
    await this.open(path.dirname(uri.fsPath), undefined, panel);
  }
  async installClient(): Promise<void> { if (!this.active) throw new Error('Open a review first.'); await installClient(new NativeStorage(this.active.root, this.journalRoot), this.artifact); }
  async updateClient(): Promise<void> {
    if (!this.active) throw new Error('Open a review first.');
    const store = new NativeStorage(this.active.root, this.journalRoot), currentFile = await installedClientFile(store), expected = digest(await store.read(currentFile, 64 * 1024 * 1024));
    const choice = await vscode.window.showWarningMessage(`Update the executable HTML toolbox in ${this.active.root}? The current file, including any custom changes, will be backed up. Review evidence is unchanged.`, { modal: true }, 'Back up and update client');
    if (choice !== 'Back up and update client') return;
    const result = await updateClient(store, this.artifact, expected);
    await vscode.window.showInformationMessage(result.backupPath ? `Client updated. Previous HTML: ${result.backupPath}` : 'The HTML toolbox already matches this extension.');
  }
  async forward(buttonId: string): Promise<void> {
    if (!this.active) return;
    let selection: unknown;
    const editor = vscode.window.activeTextEditor;
    if (['comment', 'suggest'].includes(buttonId) && editor && !editor.selection.isEmpty && this.active.source) {
      const document = path.relative(this.active.source, editor.document.uri.fsPath).split(path.sep).join('/');
      if (!document.startsWith('../') && /\.md$/i.test(document)) selection = { document, source: editor.document.getText(), start: editor.document.offsetAt(editor.selection.start), end: editor.document.offsetAt(editor.selection.end) };
    }
    const root = this.active.root;
    if (!this.panels.has(root)) await this.open(root);
    const panel = this.panels.get(root); if (!panel) return;
    panel.reveal();
    const action = { command: 'toolbox-action', buttonId, selection };
    if (this.readyPanels.has(panel)) await panel.webview.postMessage(action);
    else this.pendingActions.set(panel, [...this.pendingActions.get(panel) ?? [], action]);
  }
}
