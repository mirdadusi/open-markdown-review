import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
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

async function directoryInventory(root: string, relativeDirectory: string): Promise<string[]> {
  const absolute = resolveInsideReview(root, relativeDirectory);
  try {
    return (await readdir(absolute)).filter((name) => name.endsWith(".json")).sort().map((name) => `${relativeDirectory}/${name}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [`${relativeDirectory}:missing`];
    throw error;
  }
}

/**
 * Produces a cheap change detector for the immutable package frontier. One
 * event-directory inventory replaces repeated manifest/blob reads and one stat
 * per historical event. The manifest is created once and a revision is visible
 * only after its revision.created event is published last.
 * Known-file rewrites remain an audit violation and are detected by watcher-
 * directed reloads and explicit full validation.
 */
export async function reviewPackageFingerprint(reviewRoot: string, manifest: ReviewManifest): Promise<string> {
  const parts = await directoryInventory(reviewRoot, manifest.eventDirectory);
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
