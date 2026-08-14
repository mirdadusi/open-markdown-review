import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  listEventNames,
  loadEventFiles,
  resolveInsideReview,
  sha256,
} from "./protocol/store";
import {
  ReviewEvent,
  ReviewManifest,
  ReviewRevision,
  RevisionCreatedEvent,
  Sha256Digest,
  StoredContent,
} from "./protocol/types";
import { validateEvent, validateRevision } from "./protocol/validation";
import { DEFAULT_IO_CONCURRENCY, mapWithConcurrency } from "./protocol/concurrency";

const CACHE_SCHEMA_VERSION = 1 as const;

interface PersistentReviewCache {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  reviewRoot: string;
  reviewId: string;
  manifestDigest: Sha256Digest;
  events: ReviewEvent[];
  revision?: ReviewRevision;
  revisionEventId?: string;
  revisionDigest?: Sha256Digest;
}

export interface CachedReviewSnapshot {
  events: ReviewEvent[];
  revision?: ReviewRevision;
  revisionEventId?: string;
  revisionDigest?: Sha256Digest;
}

export interface ReconciledEvents {
  events: ReviewEvent[];
  warnings: string[];
  eventNames: string[];
  missingCachedEvents: ReviewEvent[];
  loadedFileCount: number;
  cachedEventCount: number;
  cachedRevision?: ReviewRevision;
}

export interface ReconcileOptions {
  /** Full audit reads every shared event file instead of trusting the derived cache. */
  full?: boolean;
  /** Known changed files are re-read even when their IDs already exist in cache. */
  reloadEventNames?: readonly string[];
}

export interface MaterializedRevision {
  paths: Map<Sha256Digest, string>;
  errors: string[];
  sharedReads: number;
  localHits: number;
}

export interface ReviewCacheOptions {
  maxContentBytes?: number;
  ioConcurrency?: number;
}

export interface MaterializeOptions {
  /** Ignore local bytes and verify every active blob against shared storage. */
  auditShared?: boolean;
}

export interface ReviewCacheStats {
  root: string;
  contentEntries: number;
  contentBytes: number;
  verifiedThisSession: number;
  loadedReviewSessions: number;
  maxContentBytes: number;
}

interface ContentIndexEntry {
  byteLength: number;
  lastUsed: number;
}

function manifestDigest(manifest: ReviewManifest): Sha256Digest {
  return sha256(JSON.stringify(manifest));
}

function cacheKey(reviewRoot: string): string {
  return sha256(path.resolve(reviewRoot)).slice("sha256:".length);
}

function eventFileName(event: ReviewEvent): string {
  return `${event.id}.json`;
}

function isPersistentReviewCache(value: unknown): value is PersistentReviewCache {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistentReviewCache>;
  return candidate.schemaVersion === CACHE_SCHEMA_VERSION
    && typeof candidate.reviewRoot === "string"
    && typeof candidate.reviewId === "string"
    && typeof candidate.manifestDigest === "string"
    && Array.isArray(candidate.events);
}

/**
 * Disposable, derived client cache. Shared review files remain authoritative;
 * corrupt or incompatible cache data is ignored and rebuilt.
 */
export class ReviewCache {
  private readonly sessions = new Map<string, PersistentReviewCache>();
  private readonly loaded = new Set<string>();
  private readonly verifiedLocalContent = new Set<Sha256Digest>();
  private readonly contentInflight = new Map<Sha256Digest, Promise<{ path: string; source: "local" | "shared" }>>();
  private readonly contentIndex = new Map<Sha256Digest, ContentIndexEntry>();
  private readonly sessionWriteTails = new Map<string, Promise<void>>();
  private contentIndexLoaded = false;
  private readonly maxContentBytes: number;
  private readonly ioConcurrency: number;

  constructor(private readonly root: string, options: ReviewCacheOptions = {}) {
    this.maxContentBytes = options.maxContentBytes ?? 512 * 1024 * 1024;
    this.ioConcurrency = options.ioConcurrency ?? DEFAULT_IO_CONCURRENCY;
  }

  private sessionPath(reviewRoot: string): string {
    return path.join(this.root, "reviews", `${cacheKey(reviewRoot)}.json`);
  }

  private contentPath(digest: Sha256Digest): string {
    const hash = digest.slice("sha256:".length);
    return path.join(this.root, "content", "sha256", hash.slice(0, 2), hash);
  }

  private async loadContentIndex(): Promise<void> {
    if (this.contentIndexLoaded) return;
    this.contentIndexLoaded = true;
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path.join(this.root, "content-index.json"), "utf8"));
    } catch {
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [digest, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!/^sha256:[a-f0-9]{64}$/.test(digest) || !entry || typeof entry !== "object") continue;
      const candidate = entry as Partial<ContentIndexEntry>;
      if (!Number.isSafeInteger(candidate.byteLength) || candidate.byteLength! < 0 || typeof candidate.lastUsed !== "number") continue;
      this.contentIndex.set(digest as Sha256Digest, { byteLength: candidate.byteLength!, lastUsed: candidate.lastUsed });
    }
  }

  private async saveContentIndex(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(path.join(this.root, "content-index.json"), `${JSON.stringify(Object.fromEntries(this.contentIndex))}\n`, "utf8");
  }

  private touchContent(digest: Sha256Digest, byteLength: number): void {
    this.contentIndex.set(digest, { byteLength, lastUsed: Date.now() });
  }

  private async pruneContent(protectedDigests: ReadonlySet<Sha256Digest>): Promise<void> {
    let total = [...this.contentIndex.values()].reduce((sum, entry) => sum + entry.byteLength, 0);
    if (total <= this.maxContentBytes) {
      await this.saveContentIndex();
      return;
    }
    const candidates = [...this.contentIndex.entries()]
      .filter(([digest]) => !protectedDigests.has(digest) && !this.contentInflight.has(digest))
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    for (const [digest, entry] of candidates) {
      if (total <= this.maxContentBytes) break;
      try {
        await unlink(this.contentPath(digest));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
      this.contentIndex.delete(digest);
      this.verifiedLocalContent.delete(digest);
      total -= entry.byteLength;
    }
    await this.saveContentIndex();
  }

  private async load(reviewRoot: string, manifest: ReviewManifest): Promise<PersistentReviewCache | undefined> {
    const key = path.resolve(reviewRoot);
    if (this.loaded.has(key)) return this.sessions.get(key);
    this.loaded.add(key);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.sessionPath(key), "utf8"));
    } catch {
      return undefined;
    }
    if (!isPersistentReviewCache(value)
      || path.resolve(value.reviewRoot) !== key
      || value.reviewId !== manifest.reviewId
      || value.manifestDigest !== manifestDigest(manifest)) return undefined;
    const events: ReviewEvent[] = [];
    const seen = new Set<string>();
    for (const candidate of value.events) {
      const validation = validateEvent(candidate);
      if (!validation.ok || validation.value.reviewId !== manifest.reviewId || seen.has(validation.value.id)) continue;
      seen.add(validation.value.id);
      events.push(validation.value);
    }
    let revision: ReviewRevision | undefined;
    if (value.revision) {
      const validation = validateRevision(value.revision);
      if (validation.ok && validation.value.reviewId === manifest.reviewId) revision = validation.value;
    }
    const session: PersistentReviewCache = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      reviewRoot: key,
      reviewId: manifest.reviewId,
      manifestDigest: manifestDigest(manifest),
      events,
      ...(revision ? { revision } : {}),
      ...(revision && typeof value.revisionEventId === "string" ? { revisionEventId: value.revisionEventId } : {}),
      ...(revision && typeof value.revisionDigest === "string" ? { revisionDigest: value.revisionDigest } : {}),
    };
    this.sessions.set(key, session);
    return session;
  }

  async reconcileEvents(
    reviewRoot: string,
    manifest: ReviewManifest,
    options: ReconcileOptions = {},
  ): Promise<ReconciledEvents> {
    const root = path.resolve(reviewRoot);
    const session = await this.load(root, manifest);
    const cachedEvents = session?.events ?? [];
    const names = await listEventNames(root, manifest.eventDirectory);
    const available = new Set(names);
    const missingCachedEvents = cachedEvents.filter((event) => !available.has(eventFileName(event)));
    const cachedNames = new Set(cachedEvents.map(eventFileName));
    const requested = options.full
      ? names
      : [...new Set([
          ...names.filter((name) => !cachedNames.has(name)),
          ...(options.reloadEventNames ?? []).filter((name) => available.has(name)),
        ])].sort();
    const loaded = await loadEventFiles(root, requested, manifest.reviewId, manifest.eventDirectory, this.ioConcurrency);
    let events: ReviewEvent[];
    if (options.full) {
      events = loaded.events;
    } else {
      const requestedSet = new Set(requested);
      const retained = cachedEvents.filter((event) => !requestedSet.has(eventFileName(event)));
      const validLoadedNames = new Set(loaded.events.map(eventFileName));
      const retainedAfterInvalidReload = cachedEvents.filter(
        (event) => requestedSet.has(eventFileName(event)) && !validLoadedNames.has(eventFileName(event)),
      );
      events = [...retained, ...retainedAfterInvalidReload, ...loaded.events];
    }
    const deduplicated = new Map(events.map((event) => [event.id, event]));
    return {
      events: [...deduplicated.values()],
      warnings: loaded.warnings,
      eventNames: names,
      missingCachedEvents,
      loadedFileCount: requested.length,
      cachedEventCount: cachedEvents.length,
      cachedRevision: session?.revision,
    };
  }

  async save(
    reviewRoot: string,
    manifest: ReviewManifest,
    events: readonly ReviewEvent[],
    revision?: ReviewRevision,
    publication?: RevisionCreatedEvent,
  ): Promise<void> {
    const root = path.resolve(reviewRoot);
    const session: PersistentReviewCache = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      reviewRoot: root,
      reviewId: manifest.reviewId,
      manifestDigest: manifestDigest(manifest),
      events: [...events],
      ...(revision ? { revision } : {}),
      ...(revision && publication ? { revisionEventId: publication.id, revisionDigest: publication.revisionDigest } : {}),
    };
    this.loaded.add(root);
    this.sessions.set(root, session);
    const target = this.sessionPath(root);
    const previous = this.sessionWriteTails.get(root) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(session)}\n`, "utf8");
    });
    this.sessionWriteTails.set(root, operation);
    try {
      await operation;
    } finally {
      if (this.sessionWriteTails.get(root) === operation) this.sessionWriteTails.delete(root);
    }
  }

  async cachedRevision(
    reviewRoot: string,
    manifest: ReviewManifest,
    publication: RevisionCreatedEvent,
  ): Promise<ReviewRevision | undefined> {
    const session = await this.load(path.resolve(reviewRoot), manifest);
    if (session?.revisionEventId !== publication.id || session.revisionDigest !== publication.revisionDigest) return undefined;
    return session.revision;
  }

  private async materializeContent(
    reviewRoot: string,
    content: StoredContent,
    auditShared = false,
  ): Promise<{ path: string; source: "local" | "shared" }> {
    await this.loadContentIndex();
    const existing = this.contentInflight.get(content.digest);
    if (existing) return existing;
    const operation = (async () => {
      const target = this.contentPath(content.digest);
      if (!auditShared && this.verifiedLocalContent.has(content.digest)) {
        this.touchContent(content.digest, content.byteLength);
        return { path: target, source: "local" as const };
      }
      if (!auditShared) {
        try {
          const local = await readFile(target);
          if (local.byteLength === content.byteLength && sha256(local) === content.digest) {
            this.verifiedLocalContent.add(content.digest);
            this.touchContent(content.digest, content.byteLength);
            return { path: target, source: "local" as const };
          }
        } catch {
          // Missing or corrupt derived data is rebuilt from the authoritative package.
        }
      }
      let shared: Buffer;
      try {
        shared = await readFile(resolveInsideReview(reviewRoot, content.blobPath));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${content.blobPath}: unable to read authoritative blob (${reason})`);
      }
      if (shared.byteLength !== content.byteLength) throw new Error(`${content.blobPath}: byte length mismatch`);
      if (sha256(shared) !== content.digest) throw new Error(`${content.blobPath}: digest mismatch`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, shared);
      this.verifiedLocalContent.add(content.digest);
      this.touchContent(content.digest, content.byteLength);
      return { path: target, source: "shared" as const };
    })();
    this.contentInflight.set(content.digest, operation);
    try {
      return await operation;
    } finally {
      this.contentInflight.delete(content.digest);
    }
  }

  async materializeRevision(
    reviewRoot: string,
    revision: ReviewRevision,
    options: MaterializeOptions = {},
  ): Promise<MaterializedRevision> {
    const paths = new Map<Sha256Digest, string>();
    const errors: string[] = [];
    let sharedReads = 0;
    let localHits = 0;
    const contents = [...revision.documents, ...revision.resources];
    await mapWithConcurrency(contents, this.ioConcurrency, async (content) => {
      try {
        const materialized = await this.materializeContent(reviewRoot, content, options.auditShared);
        paths.set(content.digest, materialized.path);
        if (materialized.source === "shared") sharedReads += 1;
        else localHits += 1;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    });
    await this.pruneContent(new Set(contents.map((content) => content.digest)));
    return { paths, errors: errors.sort(), sharedReads, localHits };
  }

  async invalidateReview(reviewRoot: string): Promise<void> {
    const normalized = path.resolve(reviewRoot);
    this.sessions.delete(normalized);
    this.loaded.delete(normalized);
    const pending = this.sessionWriteTails.get(normalized);
    if (pending) await pending.catch(() => undefined);
    await unlink(this.sessionPath(normalized)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  async stats(): Promise<ReviewCacheStats> {
    await this.loadContentIndex();
    return {
      root: this.root,
      contentEntries: this.contentIndex.size,
      contentBytes: [...this.contentIndex.values()].reduce((sum, entry) => sum + entry.byteLength, 0),
      verifiedThisSession: this.verifiedLocalContent.size,
      loadedReviewSessions: this.sessions.size,
      maxContentBytes: this.maxContentBytes,
    };
  }
}
