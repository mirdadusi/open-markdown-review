import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { resolveInsideReview } from "./protocol/store";
import { ReviewManifest } from "./protocol/types";

export type LiveSyncPhase = "checking" | "ready" | "delayed" | "disabled";

export interface LiveSyncStatus {
  phase: LiveSyncPhase;
  label: string;
  detail: string;
  lastUpdated?: string;
  newEventCount?: number;
  newCommentCount?: number;
  notificationToken?: string;
}

export const SYNC_RETRY_DELAYS_MS = [500, 1_500, 3_000, 6_000, 12_000, 30_000] as const;

export function retryDelay(attempt: number): number | undefined {
  return SYNC_RETRY_DELAYS_MS[attempt];
}

/** Runs at most one task at a time and folds a burst into the newest pending task. */
export class SerializedCoalescingRunner<T> {
  private requested = 0;
  private completed = 0;
  private pending?: T;
  private running?: Promise<void>;

  constructor(
    private readonly worker: (value: T) => Promise<void>,
    private readonly merge: (current: T | undefined, next: T) => T = (_current, next) => next,
  ) {}

  async request(value: T): Promise<void> {
    const request = ++this.requested;
    this.pending = this.merge(this.pending, value);
    while (this.completed < request) {
      if (!this.running) {
        const running = this.drain();
        this.running = running;
        void running.then(
          () => { if (this.running === running) this.running = undefined; },
          () => { if (this.running === running) this.running = undefined; },
        );
      }
      await this.running;
    }
  }

  private async drain(): Promise<void> {
    let firstError: unknown;
    while (this.completed < this.requested) {
      const target = this.requested;
      const value = this.pending;
      this.pending = undefined;
      if (value !== undefined) {
        try {
          await this.worker(value);
        } catch (error) {
          firstError ??= error;
        }
      }
      this.completed = target;
    }
    if (firstError) throw firstError;
  }
}

async function fileStamp(target: string): Promise<string> {
  try {
    const info = await stat(target);
    return `${info.size}:${Math.trunc(info.mtimeMs)}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function directoryStamp(root: string, relativeDirectory: string): Promise<string[]> {
  const absolute = resolveInsideReview(root, relativeDirectory);
  try {
    const names = (await readdir(absolute)).filter((name) => name.endsWith(".json")).sort();
    return Promise.all(names.map(async (name) => `${relativeDirectory}/${name}:${await fileStamp(path.join(absolute, name))}`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [`${relativeDirectory}:missing`];
    throw error;
  }
}

/**
 * Produces a cheap change detector for the mutable package frontier. It hashes
 * only the manifest and immutable JSON inventories, not large content blobs.
 * Blob arrivals are covered by exact file watching and bounded sync retries.
 */
export async function reviewPackageFingerprint(reviewRoot: string, manifest: ReviewManifest): Promise<string> {
  const parts = [
    `manifest.json:${await fileStamp(path.join(reviewRoot, "manifest.json"))}`,
    ...await directoryStamp(reviewRoot, manifest.eventDirectory),
    ...await directoryStamp(reviewRoot, manifest.revisionDirectory),
  ];
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

export function semanticEventFingerprint(events: readonly { id: string }[], revisionId?: string): string {
  const stable = [...events]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((event) => JSON.stringify(event));
  return createHash("sha256").update(`${revisionId ?? "no-revision"}\n${stable.join("\n")}`).digest("hex");
}

export function detectEventRegression<T extends { id: string }>(
  previous: readonly T[],
  current: readonly T[],
): { missing: T[]; rewritten: T[] } {
  const currentById = new Map(current.map((event) => [event.id, event]));
  return {
    missing: previous.filter((event) => !currentById.has(event.id)),
    rewritten: previous.filter((event) => {
      const candidate = currentById.get(event.id);
      return candidate !== undefined && JSON.stringify(candidate) !== JSON.stringify(event);
    }),
  };
}
