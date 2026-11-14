import type { Event, Revision } from './types';
import { ReviewFindingsIndex } from './reviewFindings';

export interface PdfRevisionChoice { id: string; label: string; documents: number; comments: number; replies: number; head: boolean }
/** Time controls display order only. A latest default exists only for one head. */
export function pdfRevisionChoices(revisions: Iterable<Revision>, events: readonly Event[]): PdfRevisionChoice[] {
  const items = [...revisions], parents = new Set(items.flatMap(r => r.parents));
  const index = new ReviewFindingsIndex().update(events), labels = index.labels(items);
  return items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id)).map(r => ({
    id: r.id, label: labels.get(r.id)!, documents: r.documents.length,
    comments: index.state(r.id).threads.length, replies: index.state(r.id).threads.reduce((sum, t) => sum + t.replies.length, 0), head: !parents.has(r.id)
  }));
}
export function defaultPdfRevision(choices: readonly PdfRevisionChoice[]): string | undefined {
  const heads = choices.filter(choice => choice.head); return heads.length === 1 ? heads[0].id : undefined;
}
