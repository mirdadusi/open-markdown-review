import os from "node:os";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { CommentDecorations } from "./commentDecorations";
import {
  detectEventRegression,
  LiveSyncStatus,
  retryDelay,
  reviewPackageFingerprint,
  SerializedCoalescingRunner,
  semanticEventFingerprint,
} from "./liveSync";
import { createId } from "./protocol/ids";
import { mapWithConcurrency } from "./protocol/concurrency";
import { discoverReviewPackages } from "./protocol/discovery";
import { locateQuote, offsetAtLine, pointAtOffset } from "./protocol/anchor";
import { createSnapshot, findMarkdownFiles } from "./protocol/snapshot";
import { documentsForPatterns } from "./protocol/scope";
import { buildReviewState } from "./protocol/state";
import { validateEventAgainstRevision, validateEventCapabilities, validateEventGraph, validatePublishedRevision } from "./protocol/validation";
import {
  appendEvent,
  initializeReview,
  loadManifest,
  loadRevision,
  resolveInsideReview,
  resolveInsideWorkspace,
  ReviewStoreError,
  sha256,
} from "./protocol/store";
import {
  ActorRef,
  CommentCreatedEvent,
  CommentRepliedEvent,
  EVENT_SCHEMA_VERSION,
  MarkdownAnchor,
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  ReviewApprovedEvent,
  ReviewRejectedEvent,
  ReviewManifest,
  ReviewEvent,
  ReviewRevision,
  ReviewSuggestion,
  ReviewState,
  ReviewThread,
  SemanticTarget,
  Sha256Digest,
  SuggestedEditOperation,
  SuggestionAcceptedEvent,
  SuggestionAppliedEvent,
  SuggestionCreatedEvent,
  SuggestionRejectedEvent,
  ThreadDecidedEvent,
  ThreadDecision,
  ThreadResolvedEvent,
} from "./protocol/types";
import { RenderedCommentRequest, RenderedReviewPanel } from "./renderedView";
import { ReviewCache } from "./reviewCache";
import { RegisteredReview, ReviewArgument, ReviewsProvider } from "./reviewsView";
import { ReviewSetupPanel, ReviewSetupResult } from "./setupView";
import { SuggestionArgument, ThreadArgument, ThreadsProvider } from "./threadsView";
import { createAnchor, revealThread } from "./vscodeAnchor";

interface ActiveReview {
  folder: vscode.WorkspaceFolder;
  sourceRoot: string;
  storageRoot: string;
  manifest: ReviewManifest;
  revision: ReviewRevision;
  state: ReviewState;
  contentPaths: ReadonlyMap<Sha256Digest, string>;
}

type RefreshTrigger = "manual" | "startup" | "write" | "filesystem" | "poll" | "retry";

interface RefreshRequest {
  document?: vscode.TextDocument;
  trigger: RefreshTrigger;
  changedPaths?: string[];
}

const REFRESH_PRIORITY: Record<RefreshTrigger, number> = { retry: 0, startup: 0, poll: 1, filesystem: 2, write: 3, manual: 3 };

function isBackgroundRefresh(trigger: RefreshTrigger): boolean {
  return trigger === "startup" || trigger === "filesystem" || trigger === "poll" || trigger === "retry";
}

class ReviewController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly packageWatchers: vscode.FileSystemWatcher[] = [];
  private readonly output = vscode.window.createOutputChannel("Open Markdown Review");
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private disposed = false;
  private currentSourceRoot?: string;
  private currentStorageRoot?: string;
  private currentManifest?: ReviewManifest;
  private currentRevision?: ReviewRevision;
  private currentContentPaths = new Map<Sha256Digest, string>();
  private loadedEvents: ReviewEvent[] = [];
  private currentSemanticFingerprint?: string;
  private observedPackageFingerprint?: string;
  private watchedPackageKey?: string;
  private refreshTimer?: NodeJS.Timeout;
  private readonly pendingChangedPaths = new Set<string>();
  private pollTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private retryFingerprint?: string;
  private retryAttempt = 0;
  private backgroundRefreshSuspended = 0;
  private readonly registeredReviewCache = new Map<string, RegisteredReview[]>();
  private readonly reviewCache: ReviewCache;
  private stateOperationTail: Promise<void> = Promise.resolve();
  private syncStatus: LiveSyncStatus = {
    phase: "checking",
    label: "Starting live sync",
    detail: "Connecting to the active review package.",
  };
  private readonly refreshQueue = new SerializedCoalescingRunner<RefreshRequest>(
    (request) => this.withStateLock(() => this.performRefresh(request.document, request.trigger, request.changedPaths)),
    (current, next) => ({
      document: next.document ?? current?.document,
      trigger: !current || REFRESH_PRIORITY[next.trigger] >= REFRESH_PRIORITY[current.trigger] ? next.trigger : current.trigger,
      changedPaths: [...new Set([...(current?.changedPaths ?? []), ...(next.changedPaths ?? [])])],
    }),
  );
  private reviewPanel?: RenderedReviewPanel;
  private readonly commentDecorations: CommentDecorations;

  private async withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.stateOperationTail;
    let release!: () => void;
    this.stateOperationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly threads: ThreadsProvider,
    private readonly reviews: ReviewsProvider,
  ) {
    const configuration = vscode.workspace.getConfiguration("openMarkdownReview");
    const cacheSizeMb = configuration.get<number>("cache.maxSizeMb", 512);
    const ioConcurrency = configuration.get<number>("io.maxConcurrency", 4);
    this.reviewCache = new ReviewCache(context.globalStorageUri.fsPath, {
      maxContentBytes: cacheSizeMb * 1024 * 1024,
      ioConcurrency,
    });
    this.commentDecorations = new CommentDecorations(context);
    this.status.command = "openMarkdownReview.openReview";
    this.disposables.push(this.output, this.status, this.commentDecorations);
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.registeredReviewCache.clear();
        void this.refresh(undefined, "startup");
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("openMarkdownReview.liveSync")) return;
        this.watchedPackageKey = undefined;
        if (this.currentStorageRoot && this.currentManifest) this.configurePackageWatchers(this.currentStorageRoot, this.currentManifest);
        this.scheduleNextPoll(0);
      }),
    );
    this.scheduleNextPoll();
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.disposeWatchers(this.packageWatchers);
    for (const disposable of this.disposables) disposable.dispose();
  }

  private liveSyncConfiguration(folder?: vscode.WorkspaceFolder): {
    enabled: boolean;
    activeIntervalMs: number;
    backgroundIntervalMs: number;
    debounceMs: number;
  } {
    const configuration = vscode.workspace.getConfiguration("openMarkdownReview", folder?.uri);
    return {
      enabled: configuration.get<boolean>("liveSync.enabled", true),
      activeIntervalMs: configuration.get<number>("liveSync.activeIntervalSeconds", 3) * 1_000,
      backgroundIntervalMs: configuration.get<number>("liveSync.backgroundIntervalSeconds", 15) * 1_000,
      debounceMs: configuration.get<number>("liveSync.debounceMilliseconds", 350),
    };
  }

  private disposeWatchers(watchers: vscode.FileSystemWatcher[]): void {
    while (watchers.length) watchers.pop()?.dispose();
  }

  private attachWatcher(
    watcher: vscode.FileSystemWatcher,
    target: vscode.FileSystemWatcher[],
  ): void {
    const changed = (uri: vscode.Uri) => {
      this.scheduleRefresh("filesystem", undefined, uri.fsPath);
    };
    watcher.onDidCreate(changed);
    watcher.onDidChange(changed);
    watcher.onDidDelete(changed);
    target.push(watcher);
  }

  private configurePackageWatchers(storageRoot: string, manifest: ReviewManifest): void {
    const folder = this.workspaceFolderForDocument(vscode.window.activeTextEditor?.document);
    const configuration = this.liveSyncConfiguration(folder);
    const key = configuration.enabled
      ? [storageRoot, manifest.eventDirectory].join("\u0000")
      : "disabled";
    if (key === this.watchedPackageKey) return;
    this.disposeWatchers(this.packageWatchers);
    this.watchedPackageKey = key;
    if (!configuration.enabled) {
      this.setSyncStatus({ phase: "disabled", label: "Live sync disabled", detail: "Use Refresh to read shared changes." });
      return;
    }
    const base = vscode.Uri.file(storageRoot);
    const packageRelative = (directory: string) => directory.startsWith(".review/") ? directory.slice(".review/".length) : directory;
    this.attachWatcher(
      vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, `${packageRelative(manifest.eventDirectory)}/*.json`)),
      this.packageWatchers,
    );
  }

  private scheduleRefresh(trigger: RefreshTrigger, delay?: number, changedPath?: string): void {
    const folder = this.workspaceFolderForDocument(vscode.window.activeTextEditor?.document);
    if (isBackgroundRefresh(trigger) && !this.liveSyncConfiguration(folder).enabled) return;
    if (isBackgroundRefresh(trigger) && this.backgroundRefreshSuspended > 0) return;
    if (changedPath) this.pendingChangedPaths.add(path.resolve(changedPath));
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const wait = delay ?? this.liveSyncConfiguration(folder).debounceMs;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      const changedPaths = [...this.pendingChangedPaths];
      this.pendingChangedPaths.clear();
      void this.refresh(undefined, trigger, changedPaths);
    }, wait);
  }

  private scheduleNextPoll(delay?: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.disposed) return;
    const folder = this.workspaceFolderForDocument(vscode.window.activeTextEditor?.document);
    const configuration = this.liveSyncConfiguration(folder);
    const interval = delay ?? (this.reviewPanel?.isVisible ? configuration.activeIntervalMs : configuration.backgroundIntervalMs);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.pollForSharedChanges().finally(() => this.scheduleNextPoll());
    }, Math.max(0, interval));
  }

  private async pollForSharedChanges(): Promise<void> {
    const folder = this.workspaceFolderForDocument(vscode.window.activeTextEditor?.document);
    if (!this.liveSyncConfiguration(folder).enabled || !this.currentStorageRoot || !this.currentManifest) return;
    try {
      const fingerprint = await reviewPackageFingerprint(this.currentStorageRoot, this.currentManifest);
      if (this.observedPackageFingerprint === undefined) {
        this.observedPackageFingerprint = fingerprint;
      } else if (fingerprint !== this.observedPackageFingerprint) {
        this.observedPackageFingerprint = fingerprint;
        this.retryFingerprint = undefined;
        this.retryAttempt = 0;
        await this.refresh(undefined, "poll");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setSyncStatus({
        phase: "delayed",
        label: "Shared storage unavailable",
        detail: message,
        lastUpdated: this.syncStatus.lastUpdated,
      });
      this.output.appendLine(`[live sync] Poll delayed: ${message}`);
    }
  }

  private workspaceFolderForDocument(document?: vscode.TextDocument): vscode.WorkspaceFolder | undefined {
    return (document && vscode.workspace.getWorkspaceFolder(document.uri)) ?? vscode.workspace.workspaceFolders?.[0];
  }

  private rootsStateKey(folder: vscode.WorkspaceFolder): string {
    return `reviewRoots:${folder.uri.toString()}`;
  }

  private activeStateKey(folder: vscode.WorkspaceFolder): string {
    return `activeReview:${folder.uri.toString()}`;
  }

  private async registeredReviews(folder: vscode.WorkspaceFolder, force = false): Promise<RegisteredReview[]> {
    const cacheKey = folder.uri.toString();
    const cached = this.registeredReviewCache.get(cacheKey);
    if (!force && cached) return cached;
    const savedRoots = new Set((this.context.workspaceState.get<string[]>(this.rootsStateKey(folder)) ?? []).map((item) => path.resolve(item)));
    const legacyParent = this.context.workspaceState.get<string>(`reviewStorage:${folder.uri.toString()}`);
    if (legacyParent) {
      const legacyPackage = await loadManifest(path.join(legacyParent, ".review")).catch(() => undefined);
      savedRoots.add(path.resolve(legacyPackage ? path.join(legacyParent, ".review") : legacyParent));
    }
    const roots = new Set(savedRoots);
    // Opening a received review package as the VS Code folder should work directly.
    roots.add(folder.uri.fsPath);
    roots.add(path.join(folder.uri.fsPath, ".review"));
    const manifests = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, "**/manifest.json"),
      "**/{.git,node_modules,out,dist}/**",
      50,
    );
    for (const manifest of manifests) roots.add(path.dirname(manifest.fsPath));
    const result = (await mapWithConcurrency([...roots], this.ioConcurrency(folder), async (reviewRoot): Promise<RegisteredReview | undefined> => {
      try {
        const manifest = await loadManifest(reviewRoot);
        return manifest ? { reviewRoot, manifest } : undefined;
      } catch (error) {
        this.output.appendLine(`[ignored review candidate] ${reviewRoot}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    })).filter((item): item is RegisteredReview => item !== undefined);
    result.sort((left, right) => left.manifest.title.localeCompare(right.manifest.title) || left.reviewRoot.localeCompare(right.reviewRoot));
    for (const item of result) savedRoots.add(item.reviewRoot);
    await this.context.workspaceState.update(this.rootsStateKey(folder), [...savedRoots]);
    this.registeredReviewCache.set(cacheKey, result);
    return result;
  }

  private async activeStorageRootFor(folder: vscode.WorkspaceFolder): Promise<string> {
    const saved = this.context.workspaceState.get<string>(this.activeStateKey(folder));
    if (saved) {
      const normalized = path.resolve(saved);
      const cachedReviews = this.registeredReviewCache.get(folder.uri.toString());
      if (cachedReviews?.some((item) => path.resolve(item.reviewRoot) === normalized)) {
        this.reviews.setReviews(cachedReviews, normalized, folder.uri.fsPath);
        return normalized;
      }
      const manifest = this.currentStorageRoot && path.resolve(this.currentStorageRoot) === normalized
        ? this.currentManifest ?? await loadManifest(normalized)
        : await loadManifest(normalized).catch(() => undefined);
      if (manifest) {
        const rememberedRoots = new Set([
          ...(this.context.workspaceState.get<string[]>(this.rootsStateKey(folder)) ?? []).map((item) => path.resolve(item)),
          normalized,
        ]);
        const remembered = (await mapWithConcurrency([...rememberedRoots], this.ioConcurrency(folder), async (reviewRoot): Promise<RegisteredReview | undefined> => {
          const knownManifest = reviewRoot === normalized ? manifest : await loadManifest(reviewRoot).catch(() => undefined);
          return knownManifest ? { reviewRoot, manifest: knownManifest } : undefined;
        })).filter((item): item is RegisteredReview => item !== undefined);
        const registered = remembered
          .sort((left, right) => left.manifest.title.localeCompare(right.manifest.title) || left.reviewRoot.localeCompare(right.reviewRoot));
        this.registeredReviewCache.set(folder.uri.toString(), registered);
        this.reviews.setReviews(registered, normalized, folder.uri.fsPath);
        return normalized;
      }
    }
    const registered = await this.registeredReviews(folder);
    const active = registered.find((item) => item.reviewRoot === saved)?.reviewRoot ?? registered[0]?.reviewRoot;
    this.reviews.setReviews(registered, active, folder.uri.fsPath);
    return active ?? path.join(folder.uri.fsPath, ".review");
  }

  private async registerReview(folder: vscode.WorkspaceFolder, storageRoot: string, makeActive = true): Promise<void> {
    const normalized = path.resolve(storageRoot);
    const roots = new Set(this.context.workspaceState.get<string[]>(this.rootsStateKey(folder)) ?? []);
    roots.add(normalized);
    await this.context.workspaceState.update(this.rootsStateKey(folder), [...roots]);
    if (makeActive) await this.context.workspaceState.update(this.activeStateKey(folder), normalized);
    const manifest = await loadManifest(normalized).catch(() => undefined);
    const cached = this.registeredReviewCache.get(folder.uri.toString());
    if (manifest && cached) {
      const reviews = [...cached.filter((item) => path.resolve(item.reviewRoot) !== normalized), { reviewRoot: normalized, manifest }]
        .sort((left, right) => left.manifest.title.localeCompare(right.manifest.title) || left.reviewRoot.localeCompare(right.reviewRoot));
      this.registeredReviewCache.set(folder.uri.toString(), reviews);
      this.reviews.setReviews(reviews, makeActive ? normalized : undefined, folder.uri.fsPath);
    }
  }

  private async actorFor(folder: vscode.WorkspaceFolder): Promise<ActorRef | undefined> {
    const configuration = vscode.workspace.getConfiguration("openMarkdownReview", folder.uri);
    const configuredId = configuration.get<string>("actorId", "").trim();
    const configuredName = configuration.get<string>("actorName", "").trim();
    if (configuredId) return { id: configuredId, ...(configuredName ? { displayName: configuredName } : {}) };
    const stateKey = `actor:${folder.uri.toString()}`;
    const saved = this.context.globalState.get<ActorRef>(stateKey);
    if (saved?.id) return saved;
    const id = await vscode.window.showInputBox({
      title: "Review identity",
      prompt: "Choose the stable author ID written into review events",
      value: os.userInfo().username,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : "Author ID is required"),
    });
    if (!id) return undefined;
    const displayName = await vscode.window.showInputBox({
      title: "Review identity",
      prompt: "Display name (optional)",
      value: id,
      ignoreFocusOut: true,
    });
    const actor = { id: id.trim(), ...(displayName?.trim() ? { displayName: displayName.trim() } : {}) };
    await this.context.globalState.update(stateKey, actor);
    return actor;
  }

  private setSyncStatus(status: LiveSyncStatus): void {
    this.syncStatus = status;
    const state = this.threads.getState();
    if (state) this.updateStatus(state, this.currentRevision);
    void this.reviewPanel?.setSyncStatus(status);
  }

  private clearSyncRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryFingerprint = undefined;
    this.retryAttempt = 0;
  }

  private scheduleSyncRetry(reason: string): void {
    const folder = this.workspaceFolderForDocument(vscode.window.activeTextEditor?.document);
    if (!this.liveSyncConfiguration(folder).enabled) return;
    const fingerprint = this.observedPackageFingerprint ?? this.currentSemanticFingerprint ?? "unavailable";
    if (this.retryFingerprint !== fingerprint) {
      this.retryFingerprint = fingerprint;
      this.retryAttempt = 0;
    }
    const delay = retryDelay(this.retryAttempt);
    if (delay === undefined) {
      this.output.appendLine(`[live sync] Automatic retries exhausted: ${reason}`);
      return;
    }
    this.retryAttempt += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.refresh(undefined, "retry");
    }, delay);
    this.output.appendLine(`[live sync] Retrying in ${delay} ms: ${reason}`);
  }

  private async updateObservedFingerprint(storageRoot: string, manifest: ReviewManifest): Promise<void> {
    try {
      const fingerprint = await reviewPackageFingerprint(storageRoot, manifest);
      if (this.observedPackageFingerprint !== undefined && fingerprint !== this.observedPackageFingerprint) {
        this.retryFingerprint = undefined;
        this.retryAttempt = 0;
      }
      this.observedPackageFingerprint = fingerprint;
    } catch (error) {
      this.output.appendLine(`[live sync] Could not fingerprint package: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private changedEventNames(storageRoot: string, manifest: ReviewManifest, changedPaths: readonly string[] = []): string[] {
    const eventRoot = path.resolve(resolveInsideReview(storageRoot, manifest.eventDirectory));
    const comparable = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    return [...new Set(changedPaths.map((item) => path.resolve(item)).filter((item) =>
      comparable(path.dirname(item)) === comparable(eventRoot) && item.toLowerCase().endsWith(".json"),
    ).map((item) => path.basename(item)))];
  }

  private ioConcurrency(folder?: vscode.WorkspaceFolder): number {
    return vscode.workspace.getConfiguration("openMarkdownReview", folder?.uri).get<number>("io.maxConcurrency", 4);
  }

  private revisionContentComplete(revision: ReviewRevision, paths: ReadonlyMap<Sha256Digest, string>): boolean {
    return [...revision.documents, ...revision.resources].every((content) => paths.has(content.digest));
  }

  async refresh(document?: vscode.TextDocument, trigger: RefreshTrigger = "manual", changedPaths?: string[]): Promise<void> {
    await this.refreshQueue.request({ document, trigger, changedPaths });
  }

  async refreshWithProgress(): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Validating the complete shared review", cancellable: false },
      () => this.refresh(undefined, "manual"),
    );
  }

  private async performRefresh(
    document: vscode.TextDocument | undefined,
    trigger: RefreshTrigger,
    changedPaths: readonly string[] = [],
  ): Promise<void> {
    const refreshStarted = Date.now();
    const folder = this.workspaceFolderForDocument(document ?? vscode.window.activeTextEditor?.document);
    if (!folder) return this.clearState();
    this.setSyncStatus({
      phase: "checking",
      label: trigger === "manual" ? "Refreshing review" : "Synchronizing changes",
      detail: "Reading and validating the active review package.",
      lastUpdated: this.syncStatus.lastUpdated,
    });
    let storageRoot: string | undefined;
    try {
      storageRoot = await this.activeStorageRootFor(folder);
      const manifest = await loadManifest(storageRoot);
      const packageReadyAt = Date.now();
      this.currentSourceRoot = folder.uri.fsPath;
      this.currentStorageRoot = storageRoot;
      if (!manifest) return this.clearState(false);
      const sameReview = this.currentManifest?.reviewId === manifest.reviewId;
      const previousEventIds = sameReview ? new Set(this.loadedEvents.map((event) => event.id)) : new Set<string>();
      this.currentManifest = manifest;
      this.configurePackageWatchers(storageRoot, manifest);
      const fullAudit = trigger === "manual";
      const eventsStarted = Date.now();
      const loaded = await this.reviewCache.reconcileEvents(storageRoot, manifest, {
        full: fullAudit,
        reloadEventNames: this.changedEventNames(storageRoot, manifest, changedPaths),
      });
      const eventsReadyAt = Date.now();
      if (loaded.missingCachedEvents.length) {
        throw new ReviewStoreError(`${loaded.missingCachedEvents.length} previously validated event file${loaded.missingCachedEvents.length === 1 ? " is" : "s are"} missing after synchronization.`);
      }
      const contextualWarnings: string[] = [];
      let acceptedEvents = loaded.events.filter((event) => {
        const errors = validateEventCapabilities(manifest, event);
        if (!errors.length) return true;
        contextualWarnings.push(`${event.id}: ${errors.join("; ")}`);
        return false;
      });
      const graphErrors = validateEventGraph(acceptedEvents);
      if (graphErrors.size) {
        acceptedEvents = acceptedEvents.filter((event) => {
          const errors = graphErrors.get(event.id);
          if (!errors?.length) return true;
          contextualWarnings.push(`${event.id}: ${errors.join("; ")}`);
          return false;
        });
      }
      let state = buildReviewState(acceptedEvents);
      const revisionEvent = state.revisionEvents.at(-1);
      let revision: ReviewRevision | undefined;
      let contentPaths = new Map<Sha256Digest, string>();
      let contentDurationMs = 0;
      if (revisionEvent) {
        revision = fullAudit ? undefined : await this.reviewCache.cachedRevision(storageRoot, manifest, revisionEvent);
        revision ??= await loadRevision(storageRoot, revisionEvent.revisionPath, revisionEvent.revisionDigest);
        const publicationErrors = validatePublishedRevision(manifest, revisionEvent, revision);
        if (publicationErrors.length) throw new ReviewStoreError(`Published revision is inconsistent:\n${publicationErrors.join("\n")}`);
        if (this.currentRevision?.id === revision.id) contentPaths = new Map(this.currentContentPaths);
        const needsContent = fullAudit || Boolean(this.reviewPanel && !this.revisionContentComplete(revision, contentPaths));
        if (needsContent) {
          const contentStarted = Date.now();
          const materialized = await this.reviewCache.materializeRevision(storageRoot, revision, { auditShared: fullAudit });
          contentDurationMs = Date.now() - contentStarted;
          if (materialized.errors.length) {
            const action = fullAudit ? "failed shared-storage verification" : "could not be cached";
            throw new ReviewStoreError(`Frozen revision content ${action}:\n${materialized.errors.join("\n")}`);
          }
          contentPaths = materialized.paths;
          this.output.appendLine(`[cache] ${loaded.cachedEventCount} cached events, ${loaded.loadedFileCount} shared event reads, ${materialized.localHits} local blobs, ${materialized.sharedReads} shared blob reads${fullAudit ? " · full audit" : ""}.`);
        } else {
          this.output.appendLine(`[cache] ${loaded.cachedEventCount} cached events, ${loaded.loadedFileCount} shared event reads · frozen content deferred until it is displayed.`);
        }
        acceptedEvents = acceptedEvents.filter((event) => {
          if (event.revisionId !== revision!.id) return true;
          const errors = validateEventAgainstRevision(event, revision!);
          if (!errors.length) return true;
          contextualWarnings.push(`${event.id}: ${errors.join("; ")}`);
          return false;
        });
        state = buildReviewState(acceptedEvents);
      }
      if (sameReview) {
        const regression = detectEventRegression(this.loadedEvents, acceptedEvents);
        if (regression.missing.length) {
          throw new ReviewStoreError(`${regression.missing.length} previously validated event file${regression.missing.length === 1 ? " is" : "s are"} missing or invalid after synchronization.`);
        }
        if (regression.rewritten.length) {
          throw new ReviewStoreError(`${regression.rewritten.length} immutable event file${regression.rewritten.length === 1 ? " appears" : "s appear"} to have been rewritten after validation.`);
        }
      }
      const semanticFingerprint = semanticEventFingerprint(acceptedEvents, revision?.id);
      const semanticChanged = semanticFingerprint !== this.currentSemanticFingerprint || !sameReview;
      const newEvents = sameReview ? acceptedEvents.filter((event) => !previousEventIds.has(event.id)) : [];
      const announcedEvents = isBackgroundRefresh(trigger) ? newEvents : [];
      const announcedEventIds = announcedEvents.map((event) => event.id);
      const newCommentCount = announcedEvents.filter((event) => event.type === "comment.created" || event.type === "comment.replied").length;
      this.loadedEvents = acceptedEvents;
      this.currentRevision = revision;
      this.currentContentPaths = contentPaths;
      this.currentSemanticFingerprint = semanticFingerprint;
      this.threads.setState(state);
      this.commentDecorations.setReview(folder.uri.fsPath, revision, state);
      await this.setContext(true, Boolean(revision), state.unresolvedThreads.length > 0 || state.openSuggestions.length > 0);
      for (const warning of loaded.warnings) this.output.appendLine(`[ignored] ${warning}`);
      for (const warning of contextualWarnings) this.output.appendLine(`[ignored] ${warning}`);
      if (state.danglingEvents.length) this.output.appendLine(`${state.danglingEvents.length} event(s) await related files from synchronization.`);
      await this.reviewCache.save(storageRoot, manifest, acceptedEvents, revision, revisionEvent);
      await this.updateObservedFingerprint(storageRoot, manifest);
      this.output.appendLine(`[performance] refresh=${trigger} total=${Date.now() - refreshStarted}ms package=${packageReadyAt - refreshStarted}ms events=${eventsReadyAt - eventsStarted}ms content=${contentDurationMs}ms eventFiles=${loaded.loadedFileCount}.`);
      const pendingFiles = loaded.warnings.length + contextualWarnings.length + state.danglingEvents.length;
      const now = new Date();
      const lastUpdated = now.toISOString();
      const liveSyncEnabled = this.liveSyncConfiguration(folder).enabled;
      const syncStatus: LiveSyncStatus = !liveSyncEnabled
        ? {
            phase: "disabled",
            label: "Live sync disabled",
            detail: "Use Refresh to read shared changes.",
            lastUpdated,
          }
        : pendingFiles
        ? {
            phase: "delayed",
            label: `Waiting for ${pendingFiles} synchronized file${pendingFiles === 1 ? "" : "s"}`,
            detail: "The last valid review remains visible while incomplete or out-of-order files are retried.",
            lastUpdated,
            newEventCount: announcedEvents.length,
            newCommentCount,
            ...(announcedEventIds.length ? { notificationToken: sha256(announcedEventIds.sort().join("\n")) } : {}),
          }
        : {
            phase: "ready",
            label: `Live · updated ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`,
            detail: "Watching the active package with polling fallback for shared and synchronized drives.",
            lastUpdated,
            newEventCount: announcedEvents.length,
            newCommentCount,
            ...(announcedEventIds.length ? { notificationToken: sha256(announcedEventIds.sort().join("\n")) } : {}),
          };
      this.setSyncStatus(syncStatus);
      if (this.reviewPanel?.isDisposed) this.reviewPanel = undefined;
      if (this.reviewPanel && revision) {
        if (semanticChanged) await this.reviewPanel.update(manifest, revision, state, syncStatus, announcedEventIds, contentPaths);
        else await this.reviewPanel.setSyncStatus(syncStatus);
      }
      if (liveSyncEnabled && pendingFiles) this.scheduleSyncRetry(`${pendingFiles} file(s) are incomplete, invalid, or awaiting related events.`);
      else this.clearSyncRetry();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (storageRoot && this.currentManifest) await this.updateObservedFingerprint(storageRoot, this.currentManifest);
      this.setSyncStatus({
        phase: "delayed",
        label: "Synchronization delayed",
        detail: `${message} The last valid review remains visible and will be retried.`,
        lastUpdated: this.syncStatus.lastUpdated,
      });
      this.output.appendLine(`[live sync] ${message}`);
      this.scheduleSyncRetry(message);
      if (!isBackgroundRefresh(trigger)) this.reportError(error);
    }
  }

  private clearState(clearRoot = true): void {
    if (clearRoot) {
      this.currentSourceRoot = undefined;
      this.currentStorageRoot = undefined;
      this.reviews.setReviews([], undefined, "");
      this.disposeWatchers(this.packageWatchers);
      this.watchedPackageKey = undefined;
      this.observedPackageFingerprint = undefined;
    }
    this.currentManifest = undefined;
    this.currentRevision = undefined;
    this.currentContentPaths = new Map();
    this.currentSemanticFingerprint = undefined;
    this.loadedEvents = [];
    this.threads.setState(undefined);
    this.commentDecorations.clear();
    this.status.hide();
    void this.setContext(false, false, false);
  }

  private async setContext(initialized: boolean, hasRevision: boolean, hasUnresolved: boolean): Promise<void> {
    await Promise.all([
      vscode.commands.executeCommand("setContext", "openMarkdownReview.initialized", initialized),
      vscode.commands.executeCommand("setContext", "openMarkdownReview.hasRevision", hasRevision),
      vscode.commands.executeCommand("setContext", "openMarkdownReview.hasUnresolved", hasUnresolved),
    ]);
  }

  private updateStatus(state: ReviewState, revision?: ReviewRevision): void {
    if (!this.currentManifest) return this.status.hide();
    const syncIcon = this.syncStatus.phase === "checking"
      ? "$(sync~spin)"
      : this.syncStatus.phase === "ready"
        ? "$(sync)"
        : this.syncStatus.phase === "delayed"
          ? "$(warning)"
          : "$(circle-slash)";
    this.status.text = revision
      ? `${syncIcon} ${this.currentManifest.title}: ${state.unresolvedThreads.length} comments · ${state.openSuggestions.length} suggestions`
      : `${syncIcon} ${this.currentManifest.title}: create revision`;
    this.status.tooltip = `${this.syncStatus.label}\n${this.syncStatus.detail}\n\n${revision ? "Open the immutable rendered review" : "Create the first auditable revision"}`;
    this.status.command = revision ? "openMarkdownReview.openReview" : "openMarkdownReview.setup";
    this.status.show();
  }

  async initialize(): Promise<void> {
    await this.setupReview(true);
  }

  async setupReview(createNew = false): Promise<void> {
    const folder = this.workspaceFolderForDocument(vscode.window.activeTextEditor?.document);
    if (!folder) return void vscode.window.showErrorMessage("Open a folder or workspace first.");
    const existing = createNew
      ? this.registeredReviewCache.get(folder.uri.toString()) ?? []
      : await this.registeredReviews(folder);
    const knownReviewCount = Math.max(
      existing.length,
      this.context.workspaceState.get<string[]>(this.rootsStateKey(folder))?.length ?? 0,
    );
    let storageRoot = createNew
      ? path.join(folder.uri.fsPath, knownReviewCount ? `.review-${knownReviewCount + 1}` : ".review")
      : await this.activeStorageRootFor(folder);
    let manifest = createNew ? undefined : await loadManifest(storageRoot);
    if (manifest) await this.refresh(undefined, "startup");
    const availableDocuments = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "Finding Markdown documents" },
      () => findMarkdownFiles(folder.uri.fsPath, this.ioConcurrency(folder)),
    );
    if (!availableDocuments.length) return void vscode.window.showErrorMessage("No Markdown documents were found in this workspace.");
    const active = vscode.window.activeTextEditor?.document;
    const activeRelative = active && vscode.workspace.getWorkspaceFolder(active.uri)?.uri.toString() === folder.uri.toString() && /\.md$/i.test(active.fileName)
      ? path.relative(folder.uri.fsPath, active.uri.fsPath).split(path.sep).join("/")
      : undefined;
    const previousDocuments = manifest
      ? this.currentRevision?.documents.map((item) => item.path) ?? documentsForPatterns(availableDocuments, manifest.documents)
      : availableDocuments;
    const selectedDocuments = previousDocuments.length ? previousDocuments : availableDocuments;
    const rootDocument = this.currentRevision?.rootDocument && selectedDocuments.includes(this.currentRevision.rootDocument)
      ? this.currentRevision.rootDocument
      : activeRelative && selectedDocuments.includes(activeRelative)
        ? activeRelative
        : selectedDocuments[0];
    const selection = await ReviewSetupPanel.show(this.context, {
      initialized: Boolean(manifest),
      workspaceName: folder.name,
      title: manifest?.title ?? folder.name,
      availableDocuments,
      selectedDocuments,
      rootDocument,
      sourceRoot: folder.uri.fsPath,
      storageRoot,
      storageEditable: !manifest,
    });
    if (!selection) return;
    storageRoot = path.resolve(selection.storageRoot);
    const selectedManifest = await loadManifest(storageRoot);
    if (createNew && selectedManifest) throw new ReviewStoreError("The selected folder already contains a review. Use Connect Existing Review instead.");
    if (!manifest && selectedManifest) manifest = selectedManifest;
    const actor = await this.actorFor(folder);
    if (!actor) return;
    this.backgroundRefreshSuspended += 1;
    try {
      if (!manifest) {
        let names: string[] = [];
        try {
          names = await readdir(storageRoot);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (names.length) {
          const choice = await vscode.window.showWarningMessage(
            "The selected review package folder is not empty. Protocol files will be added without removing existing files.",
            { modal: true },
            "Use folder",
          );
          if (choice !== "Use folder") return;
        }
        manifest = {
          protocol: PROTOCOL_ID,
          protocolVersion: PROTOCOL_VERSION,
          reviewId: createId("review"),
          title: selection.title,
          createdAt: new Date().toISOString(),
          createdBy: actor,
          documents: selection.documentPaths,
          eventDirectory: "events",
          revisionDirectory: "revisions",
          blobDirectory: "blobs/sha256",
          exportDirectory: "exports",
          capabilities: [
            "quote-anchor-v1", "range-anchor-v1", "semantic-anchor-v1",
            "content-addressed-resources-v1", "audit-export-v1", "thread-decision-v1",
            "suggested-edit-v1", "review-rejection-v1",
          ],
        };
        await initializeReview(storageRoot, manifest);
      }
      await this.registerReview(folder, storageRoot);
      await this.createRevisionFromSelection(folder, storageRoot, manifest, actor, selection);
    } finally {
      this.backgroundRefreshSuspended -= 1;
    }
  }

  async connectReview(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      title: "Open a shared Markdown review package",
      defaultUri: this.workspaceFolderForDocument(vscode.window.activeTextEditor?.document)?.uri,
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Open review",
    });
    const selectedRoot = selected?.[0]?.fsPath;
    if (!selectedRoot) return;
    const packages = await discoverReviewPackages(selectedRoot);
    if (!packages.length) return void vscode.window.showErrorMessage("No Open Markdown Review package was found in that folder.");
    const selectedPackage = packages.length === 1
      ? packages[0]
      : (await vscode.window.showQuickPick(packages.map((item) => ({ label: item.manifest.title, description: item.reviewRoot, item })), {
        title: "Choose a review package",
        ignoreFocusOut: true,
      }))?.item;
    if (!selectedPackage) return;
    const { reviewRoot: storageRoot, manifest } = selectedPackage;
    const folder = this.workspaceFolderForDocument(vscode.window.activeTextEditor?.document);
    if (!folder) {
      const choice = await vscode.window.showInformationMessage(
        `Open “${manifest.title}” as a frozen review? Source files are not required for reading, replying, decisions, approval, or PDF export.`,
        { modal: true },
        "Open review folder",
      );
      if (choice === "Open review folder") {
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(storageRoot), { forceNewWindow: false });
      }
      return;
    }
    await this.registerReview(folder, storageRoot);
    await this.refreshWithProgress();
    const choice = await vscode.window.showInformationMessage(`Active review: ${manifest.title}`, "Open frozen review");
    if (choice === "Open frozen review") await this.openReview();
  }

  async switchReview(argument?: ReviewArgument): Promise<void> {
    const folder = this.workspaceFolderForDocument(vscode.window.activeTextEditor?.document);
    if (!folder) return void vscode.window.showErrorMessage("Open a Markdown workspace first.");
    const registered = await this.registeredReviews(folder);
    let review = this.reviews.reviewFromArgument(argument);
    if (!review) {
      review = (await vscode.window.showQuickPick(registered.map((item) => ({
        label: item.manifest.title,
        description: item.reviewRoot,
        review: item,
      })), { title: "Choose active Markdown review", ignoreFocusOut: true }))?.review;
    }
    if (!review) return;
    await this.registerReview(folder, review.reviewRoot);
    this.reviewPanel?.dispose();
    this.reviewPanel = undefined;
    await this.refresh(undefined, "startup");
  }

  private async initializedReview(): Promise<{ folder: vscode.WorkspaceFolder; sourceRoot: string; storageRoot: string; manifest: ReviewManifest } | undefined> {
    const folder = this.workspaceFolderForDocument(vscode.window.activeTextEditor?.document);
    if (!folder) {
      void vscode.window.showErrorMessage("Open a Markdown workspace first.");
      return undefined;
    }
    const storageRoot = await this.activeStorageRootFor(folder);
    const manifest = this.currentStorageRoot && path.resolve(this.currentStorageRoot) === path.resolve(storageRoot)
      ? this.currentManifest ?? await loadManifest(storageRoot)
      : await loadManifest(storageRoot);
    if (!manifest) {
      const choice = await vscode.window.showInformationMessage("This workspace has no Markdown review.", "Open review setup");
      if (choice !== "Open review setup") return undefined;
      await this.setupReview(true);
      const createdRoot = await this.activeStorageRootFor(folder);
      const created = await loadManifest(createdRoot);
      return created ? { folder, sourceRoot: folder.uri.fsPath, storageRoot: createdRoot, manifest: created } : undefined;
    }
    return { folder, sourceRoot: folder.uri.fsPath, storageRoot, manifest };
  }

  private async activeReview(requireFullAudit = false): Promise<ActiveReview | undefined> {
    const initialized = await this.initializedReview();
    if (!initialized) return undefined;
    const currentMatches = this.currentManifest?.reviewId === initialized.manifest.reviewId
      && this.currentStorageRoot !== undefined
      && path.resolve(this.currentStorageRoot) === path.resolve(initialized.storageRoot)
      && this.currentRevision !== undefined
      && this.threads.getState() !== undefined;
    if (requireFullAudit) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Validating shared review before the audit decision", cancellable: false },
        () => this.refresh(undefined, "manual"),
      );
    } else if (!currentMatches) {
      await this.refresh(undefined, "startup");
    }
    const state = this.threads.getState();
    if (!this.currentRevision || !state) {
      const choice = await vscode.window.showInformationMessage("Create an immutable revision before reviewing.", "Create revision");
      if (choice === "Create revision") await this.createRevision();
      return undefined;
    }
    return { ...initialized, revision: this.currentRevision, state, contentPaths: this.currentContentPaths };
  }

  private async ensureReviewContent(review: ActiveReview): Promise<ActiveReview> {
    if (this.revisionContentComplete(review.revision, review.contentPaths)) return review;
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Preparing frozen Markdown, diagrams, and images locally", cancellable: false },
      () => this.withStateLock(async () => {
        if (this.currentRevision?.id === review.revision.id && this.revisionContentComplete(review.revision, this.currentContentPaths)) {
          return { ...review, contentPaths: this.currentContentPaths };
        }
        const started = Date.now();
        const materialized = await this.reviewCache.materializeRevision(review.storageRoot, review.revision);
        if (materialized.errors.length) throw new ReviewStoreError(`Frozen revision content could not be prepared:\n${materialized.errors.join("\n")}`);
        if (this.currentRevision?.id === review.revision.id) this.currentContentPaths = materialized.paths;
        this.output.appendLine(`[performance] prepare-content total=${Date.now() - started}ms localBlobs=${materialized.localHits} sharedBlobs=${materialized.sharedReads}.`);
        return { ...review, contentPaths: materialized.paths };
      }),
    );
  }

  async rebuildLocalCache(): Promise<void> {
    const review = await this.initializedReview();
    if (!review) return;
    const choice = await vscode.window.showWarningMessage(
      "Rebuild the disposable local cache from the authoritative shared review? Review files will not be changed.",
      { modal: true },
      "Rebuild cache",
    );
    if (choice !== "Rebuild cache") return;
    await this.reviewCache.invalidateReview(review.storageRoot);
    this.currentContentPaths = new Map();
    await this.refreshWithProgress();
    void vscode.window.showInformationMessage("Local review cache rebuilt and fully validated.");
  }

  async showDiagnostics(): Promise<void> {
    const folder = this.workspaceFolderForDocument(vscode.window.activeTextEditor?.document);
    const cache = await this.reviewCache.stats();
    const live = this.liveSyncConfiguration(folder);
    const megabytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
    this.output.appendLine("");
    this.output.appendLine(`[diagnostics] Open Markdown Review ${String(this.context.extension.packageJSON.version ?? "unknown")}`);
    this.output.appendLine(`[diagnostics] Platform ${process.platform}-${process.arch} · Node ${process.versions.node} · VS Code ${vscode.version}`);
    this.output.appendLine(`[diagnostics] Review ${this.currentStorageRoot ?? "none"}`);
    this.output.appendLine(`[diagnostics] Revision ${this.currentRevision?.id ?? "none"} · ${this.loadedEvents.length} validated events · ${this.currentContentPaths.size} prepared blobs`);
    this.output.appendLine(`[diagnostics] Cache ${cache.root} · ${cache.contentEntries} blobs · ${megabytes(cache.contentBytes)} MB / ${megabytes(cache.maxContentBytes)} MB`);
    this.output.appendLine(`[diagnostics] I/O concurrency ${this.ioConcurrency(folder)} · polling ${live.activeIntervalMs / 1_000}s visible / ${live.backgroundIntervalMs / 1_000}s background · live sync ${live.enabled ? "enabled" : "disabled"}`);
    this.output.appendLine(`[diagnostics] Sync ${this.syncStatus.phase} · ${this.syncStatus.detail}`);
    this.output.show(true);
  }

  async createRevision(): Promise<void> {
    await this.setupReview(false);
  }

  private async createRevisionFromSelection(
    folder: vscode.WorkspaceFolder,
    storageRoot: string,
    manifest: ReviewManifest,
    actor: ActorRef,
    selection: ReviewSetupResult,
  ): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("openMarkdownReview", folder.uri);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Freezing ${selection.documentPaths.length} selected Markdown document${selection.documentPaths.length === 1 ? "" : "s"}`, cancellable: false },
      async (progress) => {
        const result = await createSnapshot(folder.uri.fsPath, manifest, actor, {
          rootDocument: selection.rootDocument,
          documentPaths: selection.documentPaths,
          storageRoot,
          remoteResourceLimitBytes: configuration.get<number>("remoteResourceLimitMb", 15) * 1024 * 1024,
          allowInsecureHttp: configuration.get<boolean>("allowInsecureHttp", false),
          ioConcurrency: this.ioConcurrency(folder),
          onProgress: (message) => progress.report({ message }),
        });
        this.output.appendLine(`Created revision ${result.revision.id} with ${result.revision.documents.length} documents, ${result.revision.resources.length} frozen resources, and ${result.revision.mermaidDiagrams.length} Mermaid diagrams.`);
      },
    );
    await this.refresh(undefined, "startup");
    const choice = await vscode.window.showInformationMessage("Auditable revision created.", "Open rendered review");
    if (choice === "Open rendered review") await this.openReview();
  }

  async openReview(): Promise<RenderedReviewPanel | undefined> {
    const active = await this.activeReview();
    if (!active) return undefined;
    const review = await this.ensureReviewContent(active);
    if (this.reviewPanel?.isDisposed) this.reviewPanel = undefined;
    this.reviewPanel = await RenderedReviewPanel.show(
      this.context,
      review.storageRoot,
      review.manifest,
      review.revision,
      review.state,
      {
        addComment: (request) => this.addRenderedComment(request),
        addSuggestion: (request) => this.addRenderedSuggestion(request),
        replyThread: (threadId) => this.reply(threadId),
        decideThread: (threadId) => this.decideThread(threadId),
        decideSuggestion: (suggestionId, decision) => this.decideSuggestion(suggestionId, decision),
        applySuggestion: (suggestionId) => this.applySuggestion(suggestionId),
        approve: () => this.approve(),
        reject: () => this.rejectReview(),
        exportPdf: () => this.exportPdf(),
        openThread: (threadId) => this.openThread(threadId),
        openAttachment: (resourceId) => this.openAttachment(resourceId),
        refresh: () => this.refreshWithProgress(),
      },
      this.syncStatus,
      review.contentPaths,
    );
    this.scheduleNextPoll(0);
    return this.reviewPanel;
  }

  async addComment(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !/\.md$/i.test(editor.document.fileName) || editor.selection.isEmpty) {
      return void vscode.window.showErrorMessage("Open a Markdown document and select text to comment on.");
    }
    const review = await this.activeReview();
    if (!review) return;
    const relative = path.relative(review.sourceRoot, editor.document.uri.fsPath).split(path.sep).join("/");
    const frozen = review.revision.documents.find((item) => item.path === relative);
    if (!frozen) return void vscode.window.showErrorMessage("This document is not part of the current revision.");
    const anchor = createAnchor(editor.document, editor.selection, review.sourceRoot);
    if (anchor.documentDigest !== frozen.digest) {
      const choice = await vscode.window.showWarningMessage("This file changed after the current revision. Review the frozen view or create a new revision.", "Open frozen view", "Create revision");
      if (choice === "Open frozen view") await this.openReview();
      if (choice === "Create revision") await this.createRevision();
      return;
    }
    anchor.target = { kind: "text" };
    await this.createCommentEvent(review, anchor);
  }

  async addSuggestion(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !/\.md$/i.test(editor.document.fileName) || editor.selection.isEmpty) {
      return void vscode.window.showErrorMessage("Open a Markdown document and select the exact text to change.");
    }
    const review = await this.activeReview();
    if (!review) return;
    const relative = path.relative(review.sourceRoot, editor.document.uri.fsPath).split(path.sep).join("/");
    const frozen = review.revision.documents.find((item) => item.path === relative);
    if (!frozen) return void vscode.window.showErrorMessage("This document is not part of the current revision.");
    const anchor = createAnchor(editor.document, editor.selection, review.sourceRoot);
    if (anchor.documentDigest !== frozen.digest) {
      return void vscode.window.showWarningMessage("Suggested edits must be anchored to the frozen revision. Open the frozen review or create a new revision.");
    }
    anchor.target = { kind: "text" };
    await this.createSuggestionEvent(review, anchor);
  }

  private async anchorForRendered(review: ActiveReview, request: RenderedCommentRequest): Promise<MarkdownAnchor> {
    const frozen = review.revision.documents.find((item) => item.path === request.document);
    if (!frozen) throw new Error(`Frozen document not found: ${request.document}`);
    const source = await readFile(review.contentPaths.get(frozen.digest) ?? resolveInsideReview(review.storageRoot, frozen.blobPath), "utf8");
    const quote = request.quote?.trim() || request.label?.trim() || request.kind;
    const preferred = offsetAtLine(source, request.lineStart ?? 0);
    const located = locateQuote(source, quote, "", "", preferred);
    const startOffset = located?.start ?? preferred;
    const endOffset = located?.end ?? Math.min(source.length, preferred + quote.length);
    let target: SemanticTarget;
    switch (request.kind) {
      case "image": target = { kind: "image", resourceId: request.resourceId ?? "unknown", ...(request.label ? { label: request.label } : {}) }; break;
      case "mermaid": target = { kind: "mermaid", diagramId: request.diagramId ?? "unknown", ...(request.label ? { label: request.label } : {}) }; break;
      case "table": target = { kind: "table", tableId: request.tableId ?? "unknown", ...(request.label ? { label: request.label } : {}) }; break;
      case "table-cell": target = { kind: "table-cell", tableId: request.tableId ?? "unknown", row: request.row ?? 0, column: request.column ?? 0, ...(request.label ? { label: request.label } : {}) }; break;
      default: target = { kind: "text" };
    }
    return {
      document: request.document,
      range: { start: pointAtOffset(source, startOffset), end: pointAtOffset(source, endOffset) },
      quote: {
        exact: quote,
        prefix: source.slice(Math.max(0, startOffset - 80), startOffset),
        suffix: source.slice(endOffset, endOffset + 80),
      },
      documentDigest: frozen.digest,
      target,
    };
  }

  private async addRenderedComment(request: RenderedCommentRequest): Promise<void> {
    const review = await this.activeReview();
    if (!review) return;
    await this.createCommentEvent(review, await this.anchorForRendered(review, request));
  }

  private async addRenderedSuggestion(request: RenderedCommentRequest): Promise<void> {
    const review = await this.activeReview();
    if (!review) return;
    if (request.kind !== "text") return void vscode.window.showErrorMessage("Suggested edits require an exact text selection.");
    const anchor = await this.anchorForRendered(review, request);
    const frozen = review.revision.documents.find((item) => item.path === anchor.document);
    if (!frozen) throw new Error(`Frozen document not found: ${anchor.document}`);
    const source = await readFile(review.contentPaths.get(frozen.digest) ?? resolveInsideReview(review.storageRoot, frozen.blobPath), "utf8");
    if (!source.includes(anchor.quote.exact)) {
      return void vscode.window.showWarningMessage("This rendered selection crosses Markdown formatting and cannot be mapped to one exact source string. Select it in the Markdown source editor and run Suggest Edit on Selection.");
    }
    await this.createSuggestionEvent(review, anchor);
  }

  private async applyPublishedEvent(review: ActiveReview, event: ReviewEvent): Promise<void> {
    await this.withStateLock(() => this.applyPublishedEventLocked(review, event));
  }

  private async applyPublishedEventLocked(review: ActiveReview, event: ReviewEvent): Promise<void> {
    const existing = this.loadedEvents.find((candidate) => candidate.id === event.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) throw new ReviewStoreError(`Immutable event ${event.id} changed after publication.`);
      return;
    }
    const capabilityErrors = validateEventCapabilities(review.manifest, event);
    if (capabilityErrors.length) throw new ReviewStoreError(capabilityErrors.join("; "));
    const revisionErrors = validateEventAgainstRevision(event, review.revision);
    if (revisionErrors.length) throw new ReviewStoreError(revisionErrors.join("; "));
    const events = [...this.loadedEvents, event];
    const graphErrors = validateEventGraph(events);
    if (graphErrors.size) {
      const errors = graphErrors.get(event.id) ?? [...graphErrors.values()].flat();
      throw new ReviewStoreError(errors.join("; "));
    }
    const state = buildReviewState(events);
    this.loadedEvents = events;
    this.currentSemanticFingerprint = semanticEventFingerprint(events, review.revision.id);
    this.threads.setState(state);
    this.commentDecorations.setReview(review.sourceRoot, review.revision, state);
    await this.setContext(true, true, state.unresolvedThreads.length > 0 || state.openSuggestions.length > 0);
    void this.reviewCache.save(review.storageRoot, review.manifest, events, review.revision, state.revisionEvents.at(-1)).catch((error) => {
      this.output.appendLine(`[cache] Could not persist derived review state: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.observedPackageFingerprint = undefined;
    const now = new Date();
    const syncStatus: LiveSyncStatus = this.liveSyncConfiguration(review.folder).enabled
      ? {
          phase: "ready",
          label: `Published · ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`,
          detail: "The immutable event was written to shared storage and applied from memory.",
          lastUpdated: now.toISOString(),
        }
      : {
          phase: "disabled",
          label: "Published · live sync disabled",
          detail: "The immutable event was written to storage. Use Refresh to read changes from other reviewers.",
          lastUpdated: now.toISOString(),
        };
    this.setSyncStatus(syncStatus);
    if (this.reviewPanel?.isDisposed) this.reviewPanel = undefined;
    await this.reviewPanel?.update(review.manifest, review.revision, state, syncStatus, [event.id], review.contentPaths);
  }

  private async publishEvent(review: ActiveReview, event: ReviewEvent): Promise<void> {
    // Validate cross-file semantics before the immutable file becomes visible.
    const capabilityErrors = validateEventCapabilities(review.manifest, event);
    const revisionErrors = validateEventAgainstRevision(event, review.revision);
    const graphErrors = validateEventGraph([...this.loadedEvents, event]).get(event.id) ?? [];
    const errors = [...capabilityErrors, ...revisionErrors, ...graphErrors];
    if (errors.length) throw new ReviewStoreError(errors.join("; "));
    const started = Date.now();
    const target = await appendEvent(review.storageRoot, event, review.manifest);
    const publishedAt = Date.now();
    this.output.appendLine(`[published] ${path.basename(target)}`);
    await this.applyPublishedEvent(review, event);
    this.output.appendLine(`[performance] publish=${event.type} total=${Date.now() - started}ms sharedWrite=${publishedAt - started}ms memoryUi=${Date.now() - publishedAt}ms.`);
  }

  private async createCommentEvent(review: ActiveReview, anchor: MarkdownAnchor): Promise<void> {
    const body = await vscode.window.showInputBox({
      title: `Comment on ${anchor.target?.kind ?? "text"}`,
      prompt: "Markdown is supported",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : "A comment is required"),
    });
    if (!body) return;
    const actor = await this.actorFor(review.folder);
    if (!actor) return;
    const now = new Date();
    const event: CommentCreatedEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      id: createId("evt", now),
      type: "comment.created",
      reviewId: review.manifest.reviewId,
      revisionId: review.revision.id,
      occurredAt: now.toISOString(),
      actor,
      threadId: createId("thread", now),
      commentId: createId("comment", now),
      anchor,
      body: { format: "markdown", text: body.trim() },
    };
    await this.publishEvent(review, event);
  }

  private async createSuggestionEvent(review: ActiveReview, anchor: MarkdownAnchor): Promise<void> {
    const selected = await vscode.window.showQuickPick([
      { label: "Replace text", operationKind: "replace" as const, description: "Strike out the selected string and propose new text" },
      { label: "Delete text", operationKind: "delete" as const, description: "Propose removing the selected string" },
      { label: "Insert before", operationKind: "insert-before" as const, description: "Keep the selection and insert text before it" },
      { label: "Insert after", operationKind: "insert-after" as const, description: "Keep the selection and insert text after it" },
    ], { title: "Suggested edit", placeHolder: `Change “${anchor.quote.exact.slice(0, 70)}”`, ignoreFocusOut: true });
    if (!selected) return;
    let operation: SuggestedEditOperation;
    if (selected.operationKind === "delete") {
      operation = { kind: "delete" };
    } else {
      const replacement = await vscode.window.showInputBox({
        title: selected.label,
        prompt: "Proposed Markdown text",
        ignoreFocusOut: true,
        validateInput: (value) => (value.length ? undefined : "Proposed text is required"),
      });
      if (replacement === undefined) return;
      operation = selected.operationKind === "replace"
        ? { kind: "replace", replacement }
        : { kind: "insert", replacement, position: selected.operationKind === "insert-before" ? "before" : "after" };
    }
    const rationale = await vscode.window.showInputBox({
      title: "Reason for suggested edit",
      prompt: "Required for the audit trail; Markdown is supported",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : "A reason is required"),
    });
    if (!rationale) return;
    const actor = await this.actorFor(review.folder);
    if (!actor) return;
    const now = new Date();
    const event: SuggestionCreatedEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      id: createId("evt", now),
      type: "suggestion.created",
      reviewId: review.manifest.reviewId,
      revisionId: review.revision.id,
      occurredAt: now.toISOString(),
      actor,
      suggestionId: createId("suggestion", now),
      anchor,
      operation,
      rationale: { format: "markdown", text: rationale.trim() },
    };
    await this.publishEvent(review, event);
  }

  private async chooseThread(argument?: ThreadArgument): Promise<ReviewThread | undefined> {
    const direct = this.threads.threadFromArgument(argument);
    if (direct) return direct;
    const unresolved = this.threads.getState()?.unresolvedThreads ?? [];
    if (!unresolved.length) return void vscode.window.showInformationMessage("There are no unresolved review threads.") as undefined;
    return (await vscode.window.showQuickPick(
      unresolved.map((thread) => ({ label: thread.root.body.text.replace(/\s+/g, " ").slice(0, 80), description: `${thread.root.anchor.document}:${thread.root.anchor.range.start.line + 1}`, thread })),
      { title: "Choose a review thread", ignoreFocusOut: true },
    ))?.thread;
  }

  async reply(argument?: ThreadArgument): Promise<void> {
    const review = await this.activeReview();
    if (!review) return;
    const thread = await this.chooseThread(argument);
    if (!thread) return;
    const text = await vscode.window.showInputBox({ title: "Reply to review thread", prompt: "Markdown is supported", ignoreFocusOut: true, validateInput: (value) => (value.trim() ? undefined : "A reply is required") });
    if (!text) return;
    const actor = await this.actorFor(review.folder);
    if (!actor) return;
    const now = new Date();
    const event: CommentRepliedEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      id: createId("evt", now),
      type: "comment.replied",
      reviewId: review.manifest.reviewId,
      revisionId: thread.revisionId,
      occurredAt: now.toISOString(),
      actor,
      threadId: thread.id,
      commentId: createId("comment", now),
      inReplyTo: thread.replies.at(-1)?.commentId ?? thread.root.commentId,
      body: { format: "markdown", text: text.trim() },
    };
    await this.publishEvent(review, event);
  }

  async resolve(argument?: ThreadArgument): Promise<void> {
    const review = await this.activeReview();
    if (!review) return;
    const thread = await this.chooseThread(argument);
    if (!thread) return;
    const actor = await this.actorFor(review.folder);
    if (!actor) return;
    const now = new Date();
    const event: ThreadResolvedEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      id: createId("evt", now),
      type: "thread.resolved",
      reviewId: review.manifest.reviewId,
      revisionId: thread.revisionId,
      occurredAt: now.toISOString(),
      actor,
      threadId: thread.id,
    };
    await this.publishEvent(review, event);
  }

  async decideThread(argument?: ThreadArgument): Promise<void> {
    const review = await this.activeReview();
    if (!review) return;
    const thread = await this.chooseThread(argument);
    if (!thread) return;
    const selected = await vscode.window.showQuickPick([
      { label: "Accept comment", decision: "accepted" as ThreadDecision, description: "The comment is valid and will be addressed" },
      { label: "Reject comment", decision: "rejected" as ThreadDecision, description: "The comment is not accepted" },
      { label: "Won't fix", decision: "wont-fix" as ThreadDecision, description: "Valid concern, intentionally not changed" },
      { label: "Duplicate", decision: "duplicate" as ThreadDecision, description: "Covered by another review thread" },
    ], { title: "Decide review comment", ignoreFocusOut: true });
    if (!selected) return;
    const reason = await vscode.window.showInputBox({
      title: selected.label,
      prompt: selected.decision === "accepted" ? "Decision note (optional)" : "Reason required for the audit trail",
      ignoreFocusOut: true,
      validateInput: (value) => selected.decision !== "accepted" && !value.trim() ? "A reason is required" : undefined,
    });
    if (reason === undefined) return;
    const actor = await this.actorFor(review.folder);
    if (!actor) return;
    const now = new Date();
    const event: ThreadDecidedEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      id: createId("evt", now),
      type: "thread.decided",
      reviewId: review.manifest.reviewId,
      revisionId: thread.revisionId,
      occurredAt: now.toISOString(),
      actor,
      threadId: thread.id,
      decision: selected.decision,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };
    await this.publishEvent(review, event);
  }

  async approve(): Promise<void> {
    const review = await this.activeReview(true);
    if (!review) return;
    const unresolved = review.state.unresolvedThreads.filter((thread) => thread.revisionId === review.revision.id).length;
    const openSuggestions = review.state.openSuggestions.filter((suggestion) => suggestion.revisionId === review.revision.id).length;
    if (unresolved || openSuggestions) {
      const choice = await vscode.window.showWarningMessage(`Approve revision with ${unresolved} unresolved thread${unresolved === 1 ? "" : "s"} and ${openSuggestions} open/conflicted suggestion${openSuggestions === 1 ? "" : "s"}?`, { modal: true }, "Approve anyway");
      if (choice !== "Approve anyway") return;
    }
    const note = await vscode.window.showInputBox({ title: "Approve immutable revision", prompt: "Approval note (optional)", ignoreFocusOut: true });
    if (note === undefined) return;
    const actor = await this.actorFor(review.folder);
    if (!actor) return;
    const now = new Date();
    const event: ReviewApprovedEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      id: createId("evt", now),
      type: "review.approved",
      reviewId: review.manifest.reviewId,
      revisionId: review.revision.id,
      occurredAt: now.toISOString(),
      actor,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    await this.publishEvent(review, event);
  }

  async rejectReview(): Promise<void> {
    const review = await this.activeReview(true);
    if (!review) return;
    const reason = await vscode.window.showInputBox({
      title: "Reject immutable revision",
      prompt: "Reason required for the audit trail",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : "A rejection reason is required"),
    });
    if (!reason) return;
    const actor = await this.actorFor(review.folder);
    if (!actor) return;
    const now = new Date();
    const event: ReviewRejectedEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      id: createId("evt", now),
      type: "review.rejected",
      reviewId: review.manifest.reviewId,
      revisionId: review.revision.id,
      occurredAt: now.toISOString(),
      actor,
      reason: reason.trim(),
    };
    await this.publishEvent(review, event);
  }

  private async chooseSuggestion(argument?: SuggestionArgument, statuses?: ReviewSuggestion["status"][]): Promise<ReviewSuggestion | undefined> {
    const state = this.threads.getState();
    const direct = this.threads.suggestionFromArgument(argument);
    if (direct) return direct;
    const candidates = [...(state?.suggestions.values() ?? [])].filter((item) =>
      (!this.currentRevision || item.revisionId === this.currentRevision.id) && (!statuses || statuses.includes(item.status)),
    );
    if (!candidates.length) {
      void vscode.window.showInformationMessage("There are no matching suggested edits.");
      return undefined;
    }
    return (await vscode.window.showQuickPick(candidates.map((suggestion) => ({
      label: suggestion.created.anchor.quote.exact.replace(/\s+/g, " ").slice(0, 70),
      description: `${suggestion.status} · ${suggestion.created.anchor.document}:${suggestion.created.anchor.range.start.line + 1}`,
      suggestion,
    })), { title: "Choose a suggested edit", ignoreFocusOut: true }))?.suggestion;
  }

  async decideSuggestion(argument: SuggestionArgument, decision: "accepted" | "rejected"): Promise<void> {
    const review = await this.activeReview();
    if (!review) return;
    const suggestion = await this.chooseSuggestion(argument, ["open", "conflicted"]);
    if (!suggestion) return;
    if (suggestion.revisionId !== review.revision.id) return void vscode.window.showErrorMessage("Open the suggestion's exact revision before deciding it.");
    if (suggestion.status !== "open" && suggestion.status !== "conflicted") {
      return void vscode.window.showInformationMessage(`This suggestion is already ${suggestion.status}.`);
    }
    const note = await vscode.window.showInputBox({
      title: `${decision === "accepted" ? "Accept" : "Reject"} suggested edit`,
      prompt: decision === "rejected" ? "Reason (recommended)" : "Decision note (optional)",
      ignoreFocusOut: true,
    });
    if (note === undefined) return;
    const actor = await this.actorFor(review.folder);
    if (!actor) return;
    const now = new Date();
    const common = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      id: createId("evt", now),
      reviewId: review.manifest.reviewId,
      revisionId: suggestion.revisionId,
      occurredAt: now.toISOString(),
      actor,
      suggestionId: suggestion.id,
    } as const;
    const event: SuggestionAcceptedEvent | SuggestionRejectedEvent = decision === "accepted"
      ? { ...common, type: "suggestion.accepted", ...(note.trim() ? { note: note.trim() } : {}) }
      : { ...common, type: "suggestion.rejected", ...(note.trim() ? { reason: note.trim() } : {}) };
    await this.publishEvent(review, event);
  }

  async applySuggestion(argument?: SuggestionArgument): Promise<void> {
    const review = await this.activeReview();
    if (!review) return;
    const suggestion = await this.chooseSuggestion(argument, ["accepted"]);
    if (!suggestion) return;
    if (suggestion.revisionId !== review.revision.id) return void vscode.window.showErrorMessage("Open the suggestion's exact revision before applying it.");
    if (suggestion.status !== "accepted") return void vscode.window.showErrorMessage("Only an accepted, conflict-free suggestion can be applied.");
    const actor = await this.actorFor(review.folder);
    if (!actor) return;
    const uri = vscode.Uri.file(resolveInsideWorkspace(review.sourceRoot, suggestion.created.anchor.document));
    const document = await vscode.workspace.openTextDocument(uri);
    const source = document.getText();
    const sourceVersion = document.version;
    const anchor = suggestion.created.anchor;
    const currentDigest = sha256(source);
    if (currentDigest !== anchor.documentDigest) {
      const choice = await vscode.window.showWarningMessage(
        "The source changed after the reviewed revision. The client will apply only if the exact quoted text and context can still be located.",
        { modal: true },
        "Locate and apply",
      );
      if (choice !== "Locate and apply") return;
    }
    const preferred = offsetAtLine(source, anchor.range.start.line) + anchor.range.start.character;
    const located = locateQuote(source, anchor.quote.exact, anchor.quote.prefix ?? "", anchor.quote.suffix ?? "", preferred);
    if (!located) return void vscode.window.showErrorMessage("The anchored text can no longer be located safely. Create a new revision and suggestion.");
    if (currentDigest !== anchor.documentDigest && located.confidence !== "context") {
      return void vscode.window.showErrorMessage("The exact string still exists, but its surrounding context changed. Applying automatically would be ambiguous; create a new revision and suggestion.");
    }
    const operation = suggestion.created.operation;
    const replacement = operation.kind === "delete"
      ? ""
      : operation.kind === "replace"
        ? operation.replacement
        : operation.position === "before"
          ? `${operation.replacement}${anchor.quote.exact}`
          : `${anchor.quote.exact}${operation.replacement}`;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(located.start), document.positionAt(located.end)), replacement);
    if (document.version !== sourceVersion || document.getText() !== source) {
      return void vscode.window.showWarningMessage("The source changed while the suggestion was being prepared. Nothing was applied; try again after reviewing the latest text.");
    }
    if (!await vscode.workspace.applyEdit(edit)) throw new Error("VS Code could not apply the suggested edit.");
    if (!await document.save()) throw new Error("The edited Markdown document could not be saved; no applied event was recorded.");
    const changed = document.getText();
    const now = new Date();
    const event: SuggestionAppliedEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      id: createId("evt", now),
      type: "suggestion.applied",
      reviewId: review.manifest.reviewId,
      revisionId: suggestion.revisionId,
      occurredAt: now.toISOString(),
      actor,
      suggestionId: suggestion.id,
      document: anchor.document,
      sourceDigestBefore: sha256(source),
      sourceDigestAfter: sha256(changed),
    };
    await this.publishEvent(review, event);
    void vscode.window.showInformationMessage("Accepted edit applied and recorded. Create a new revision to review the updated document.");
  }

  async exportPdf(): Promise<void> {
    const review = await this.activeReview(true);
    if (!review) return;
    const actor = await this.actorFor(review.folder);
    if (!actor) return;
    const panel = this.reviewPanel ?? (await this.openReview());
    if (!panel) return;
    const renderData = await panel.collectRenderData();
    const { exportAuditPdf } = await import("./pdfExport");
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Creating auditable PDF locally", cancellable: false },
      () => exportAuditPdf({
        reviewRoot: review.storageRoot,
        manifest: review.manifest,
        revision: review.revision,
        state: review.state,
        events: this.loadedEvents,
        renderData,
        actor,
        clientVersion: String(this.context.extension.packageJSON.version ?? "0.4.5"),
        contentPaths: review.contentPaths,
      }),
    );
    await this.applyPublishedEvent(review, result.event);
    const choice = await vscode.window.showInformationMessage(`Audit PDF created and hashed: ${result.relativePath}`, "Open PDF", "Reveal in folder");
    if (choice === "Open PDF") await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(result.absolutePath));
    if (choice === "Reveal in folder") await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(result.absolutePath));
  }

  async openThread(argument?: ThreadArgument): Promise<void> {
    const thread = this.threads.threadFromArgument(argument);
    if (!thread || !this.currentSourceRoot) return;
    const source = resolveInsideWorkspace(this.currentSourceRoot, thread.root.anchor.document);
    try {
      await access(source);
      await revealThread(this.currentSourceRoot, thread);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.openReview();
      void vscode.window.showInformationMessage("The original Markdown source is not available on this machine. The immutable frozen review remains fully readable.");
    }
  }

  async showThread(argument?: ThreadArgument): Promise<void> {
    const thread = this.threads.threadFromArgument(argument);
    if (!thread) return;
    const panel = await this.openReview();
    await panel?.revealThread(thread.id);
  }

  private async openAttachment(resourceId: string): Promise<void> {
    if (!this.currentStorageRoot || !this.currentRevision) return;
    const resource = this.currentRevision.resources.find((item) => item.id === resourceId && item.role === "attachment");
    if (!resource) throw new Error(`Frozen attachment not found: ${resourceId}`);
    const uri = vscode.Uri.file(this.currentContentPaths.get(resource.digest) ?? resolveInsideReview(this.currentStorageRoot, resource.blobPath));
    if (resource.mediaType === "application/pdf" || resource.mediaType.startsWith("text/") || resource.mediaType.startsWith("image/")) {
      await vscode.commands.executeCommand("vscode.open", uri);
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Open frozen ${resource.mediaType} attachment in its associated application? Treat attachments as untrusted.`,
      { modal: true },
      "Open attachment",
    );
    if (choice === "Open attachment") await vscode.env.openExternal(uri);
  }

  reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
    this.output.show(true);
    if (!(error instanceof ReviewStoreError && message.includes("already initialized"))) void vscode.window.showErrorMessage(`Markdown Review: ${message}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const threads = new ThreadsProvider();
  const reviews = new ReviewsProvider();
  const controller = new ReviewController(context, threads, reviews);
  context.subscriptions.push(
    controller,
    vscode.window.registerTreeDataProvider("openMarkdownReview.reviews", reviews),
    vscode.window.registerTreeDataProvider("openMarkdownReview.threads", threads),
  );
  const register = (command: string, callback: (...args: unknown[]) => Promise<void>) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, (...args) => void callback(...args).catch((error) => controller.reportError(error))));
  };
  register("openMarkdownReview.initialize", () => controller.initialize());
  register("openMarkdownReview.connectReview", () => controller.connectReview());
  register("openMarkdownReview.switchReview", (argument) => controller.switchReview(argument as ReviewArgument));
  register("openMarkdownReview.setup", () => controller.setupReview());
  register("openMarkdownReview.createRevision", () => controller.createRevision());
  register("openMarkdownReview.openReview", () => controller.openReview().then(() => undefined));
  register("openMarkdownReview.addComment", () => controller.addComment());
  register("openMarkdownReview.addSuggestion", () => controller.addSuggestion());
  register("openMarkdownReview.reply", (argument) => controller.reply(argument as ThreadArgument));
  register("openMarkdownReview.resolveThread", (argument) => controller.resolve(argument as ThreadArgument));
  register("openMarkdownReview.decideThread", (argument) => controller.decideThread(argument as ThreadArgument));
  register("openMarkdownReview.approveReview", () => controller.approve());
  register("openMarkdownReview.rejectReview", () => controller.rejectReview());
  register("openMarkdownReview.acceptSuggestion", (argument) => controller.decideSuggestion(argument as SuggestionArgument, "accepted"));
  register("openMarkdownReview.rejectSuggestion", (argument) => controller.decideSuggestion(argument as SuggestionArgument, "rejected"));
  register("openMarkdownReview.applySuggestion", (argument) => controller.applySuggestion(argument as SuggestionArgument));
  register("openMarkdownReview.exportPdf", () => controller.exportPdf());
  register("openMarkdownReview.refresh", () => controller.refreshWithProgress());
  register("openMarkdownReview.rebuildCache", () => controller.rebuildLocalCache());
  register("openMarkdownReview.showDiagnostics", () => controller.showDiagnostics());
  register("openMarkdownReview.openThread", (argument) => controller.openThread(argument as ThreadArgument));
  register("openMarkdownReview.showThread", (argument) => controller.showThread(argument as ThreadArgument));
  void controller.refresh(undefined, "startup");
}

export function deactivate(): void {}
