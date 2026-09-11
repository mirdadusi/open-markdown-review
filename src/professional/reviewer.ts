import type { ActorRef } from './types';

/** A local UI preference, never inferred from the author of a received package. */
export function reviewerIdentity(value: unknown): ActorRef | undefined {
  if (!value || typeof value !== 'object') return;
  const candidate = value as { id?: unknown; displayName?: unknown };
  if (typeof candidate.id !== 'string' || candidate.displayName !== undefined && typeof candidate.displayName !== 'string') return;
  const id = candidate.id.trim(), displayName = candidate.displayName?.trim();
  if (!id || [...id].length > 128 || /[\x00-\x1f\x7f-\x9f]/.test(id)) return;
  return { id, ...(displayName ? { displayName } : {}) };
}
