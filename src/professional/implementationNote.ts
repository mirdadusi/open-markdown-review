/** Optional user note; mandatory wire evidence remains factual, not invented rationale. */
export function implementationSummary(note: string | undefined, revisionId: string, document: string): string {
  return note?.trim() || `Implementation recorded in published snapshot ${revisionId} for ${document}.`;
}
