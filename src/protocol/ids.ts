import { randomUUID } from "node:crypto";

export type IdPrefix = "review" | "revision" | "resource" | "export" | "evt" | "thread" | "comment" | "suggestion";

/**
 * Makes filename-safe IDs. The timestamp prefix helps humans inspect event
 * folders; ordering still uses occurredAt + id rather than filenames alone.
 */
export function createId(prefix: IdPrefix, now = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:.]/g, "");
  return `${prefix}_${timestamp}_${randomUUID().replace(/-/g, "")}`;
}

export function isSafeEventId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}
