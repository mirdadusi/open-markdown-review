import { ProtocolError } from './types';

export const PDF_COMMENT_PREFIX = 'omr-pdf-comment/';
export interface PdfCommentReply { id: string; author: string; occurredAt: string; text: string; replyTo?: string; reviewState?: 'Completed' | 'None' | 'Accepted' | 'Rejected' }
export interface PdfComment extends PdfCommentReply {
  documentDestination: string; subject: string; quote: string;
  kind: 'comment' | 'suggested-edit'; strikeOut?: boolean; replies: PdfCommentReply[];
  targetKind?: string;
}
interface Ref { data: Record<string, unknown>; end(): void }
interface Page { width: number; height: number; dictionary: Ref; annotations: Ref[] }
/** Adapter for the pinned pdfmake/PDFKit engine. All pages must remain buffered. */
export interface BufferedPdf {
  page: Page;
  bufferedPageRange(): { start: number; count: number };
  switchToPage(index: number): void;
  ref(data: Record<string, unknown>): Ref;
  _root: { data: { Names: { data: { Dests: { get(name: string): unknown[] | undefined } } } } };
}
const literal = (value: string) => new String(value); // PDFKit emits UTF-16BE for non-ASCII literals.
function finishComment(pdf: BufferedPdf, page: Page, reference: Ref): void {
  const bounds = reference.data.Rect as number[], left = Math.min(page.width - 230, Math.max(40, bounds[2] + 12)), bottom = Math.min(page.height - 170, Math.max(40, bounds[1]));
  const popup = pdf.ref({ Type: 'Annot', Subtype: 'Popup', Rect: [left, bottom, left + 210, bottom + 130], P: page.dictionary, Parent: reference, Open: false });
  reference.data.Popup = popup;
  page.annotations.push(reference, popup); popup.end(); reference.end();
}
type Rect = [number, number, number, number];
function rect(value: unknown, page: Page): Rect {
  if (!Array.isArray(value) || value.length !== 4 || value.some(v => typeof v !== 'number' || !Number.isFinite(v))
    || value[0] < -0.1 || value[1] < -0.1 || value[2] > page.width + 0.1 || value[3] > page.height + 0.1 || value[2] <= value[0] || value[3] <= value[1]) {
    throw new ProtocolError('integrity', 'PDF comment geometry is invalid. No PDF was published.');
  }
  return value as Rect;
}
/** Replace temporary layout links with real PDF markup and /IRT reply threads before serialization.
 * No source-text search or guessed character widths are used: geometry comes from final PDF layout.
 */
export function installPdfComments(pdf: BufferedPdf, comments: readonly PdfComment[]): void {
  const range = pdf.bufferedPageRange();
  if (range.start !== 0 || !range.count) throw new ProtocolError('integrity', 'PDF annotation requires all layout pages to remain buffered.');
  const index = new Map(comments.map(c => [c.id, c]));
  if (index.size !== comments.length) throw new ProtocolError('integrity', 'Duplicate PDF comment identity.');
  const pages: Page[] = [], locations = new Map<string, Map<number, Rect[]>>();
  for (let pageIndex = 0; pageIndex < range.count; pageIndex++) {
    pdf.switchToPage(pageIndex); const page = pdf.page; pages.push(page);
    const retained: Ref[] = [];
    for (const annotation of page.annotations) {
      const action = annotation.data.A as Ref | undefined;
      const destination = annotation.data.Subtype === 'Link' && action?.data.S === 'GoTo' ? String(action.data.D ?? '') : '';
      if (!destination.startsWith(PDF_COMMENT_PREFIX)) { retained.push(annotation); continue; }
      const parts = destination.slice(PDF_COMMENT_PREFIX.length).split('|');
      if (parts.length > 2) throw new ProtocolError('integrity', 'Invalid PDF comment marker.');
      const [encodedIds, encodedOriginal = ''] = parts;
      const ids = encodedIds.split(',');
      if (!ids.length || ids.some(id => !index.has(id))) throw new ProtocolError('integrity', 'PDF annotation refers to an unknown finding.');
      const box = rect(annotation.data.Rect, page);
      if (encodedOriginal) {
        const original = decodeURIComponent(encodedOriginal);
        if (!pdf._root.data.Names.data.Dests.get(original)) throw new ProtocolError('integrity', 'PDF comment overlaps an invalid document link.');
        const action = pdf.ref({ S: 'GoTo', D: literal(original) }); action.end();
        const link = pdf.ref({ ...annotation.data, A: action }); retained.push(link); link.end();
      }
      for (const id of new Set(ids)) {
        const byPage = locations.get(id) ?? new Map<number, Rect[]>(), boxes = byPage.get(pageIndex) ?? [];
        if (!boxes.some(b => b.every((n, i) => n === box[i]))) boxes.push(box);
        byPage.set(pageIndex, boxes); locations.set(id, byPage);
      }
    }
    page.annotations.splice(0, page.annotations.length, ...retained);
  }
  for (const comment of comments) {
    let primary: Ref | undefined, primaryPage: Page | undefined, primaryRect: Rect | undefined;
    const found = locations.get(comment.id);
    if (found) for (const [pageIndex, boxes] of found) {
      const page = pages[pageIndex];
      const bounds: Rect = [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])), Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))];
      const objectTarget = comment.targetKind && comment.targetKind !== 'text';
      const data: Record<string, unknown> = {
        Type: 'Annot', Subtype: comment.strikeOut ? 'StrikeOut' : objectTarget ? 'Square' : 'Highlight', Rect: bounds,
        ...(!objectTarget || comment.strikeOut ? { QuadPoints: boxes.flatMap(([left, bottom, right, top]) => [left, top, right, top, left, bottom, right, bottom]) } : { BS: { W: 1.5 } }),
        P: page.dictionary, F: 4, C: comment.strikeOut ? [0.8, 0.15, 0.12] : [1, 0.84, 0.25], CA: objectTarget ? 1 : 0.35,
        NM: literal(`${comment.id}-${pageIndex}`), T: literal(comment.author), Subj: literal(comment.subject),
        Contents: literal(comment.text), CreationDate: new Date(comment.occurredAt), M: new Date(comment.occurredAt),
      };
      // PDF /IRT references must remain on the same page. Cross-page pieces
      // share the finding subject/root event, not an illegal cross-page reply.
      if (primary) data.Subj = literal(`${comment.subject} (continued on page ${pageIndex + 1})`);
      const reference = pdf.ref(data); finishComment(pdf, page, reference);
      if (!primary) { primary = reference; primaryPage = page; primaryRect = bounds; }
    }
    if (!primary) {
      // Code/front matter or an invisible Markdown span may have no rendered glyphs.
      // Attach an explicitly source-only note to its document, never invent a highlight.
      const destination = pdf._root.data.Names.data.Dests.get(comment.documentDestination);
      const page = pages.find(p => p.dictionary === destination?.[0]);
      if (!page) throw new ProtocolError('integrity', `No PDF document destination for finding ${comment.id}.`);
      const top = typeof destination?.[3] === 'number' ? Math.min(page.height - 40, destination[3]) : page.height - 45;
      primaryRect = [18, Math.max(40, top - 16), 34, Math.max(40, top - 16) + 16]; primaryPage = page;
      primary = pdf.ref({ Type: 'Annot', Subtype: 'Text', Rect: primaryRect, P: page.dictionary, F: 4,
        Name: 'Comment', Open: false, NM: literal(comment.id), T: literal(comment.author), Subj: literal(comment.subject),
        Contents: literal(`${comment.text}\n\nSource-only anchor (no exact visible PDF span):\n${comment.quote}`),
        CreationDate: new Date(comment.occurredAt), M: new Date(comment.occurredAt), C: [1, 0.84, 0.25] });
      finishComment(pdf, page, primary);
    }
    const refs = new Map<string, Ref>([[comment.id, primary]]);
    if (new Set([comment.id, ...comment.replies.map(r => r.id)]).size !== comment.replies.length + 1) throw new ProtocolError('integrity', 'Duplicate PDF reply identity.');
    const replies = new Map(comment.replies.map(r => [r.id, r]));
    for (const reply of comment.replies) {
      const seen = new Set<string>([reply.id]); let parent = reply.replyTo ?? comment.id;
      while (parent !== comment.id) { if (seen.has(parent) || !replies.has(parent)) throw new ProtocolError('integrity', 'Invalid PDF reply ancestry.'); seen.add(parent); parent = replies.get(parent)!.replyTo ?? comment.id; }
      // PDF readers may draw a 22-point note icon for Text replies regardless of
      // our requested size. Keep it wholly in the margin, never over source text.
      const bottom = Math.min(primaryPage!.height - 40, Math.max(40, primaryRect![1])), page = primaryPage!;
      const reference = pdf.ref({ Type: 'Annot', Subtype: 'Text', Rect: [18, bottom, 34, bottom + 16], P: page.dictionary,
        F: 4, Name: 'Comment', Open: false, RT: 'R', NM: literal(reply.id), T: literal(reply.author),
        Contents: literal(reply.text), CreationDate: new Date(reply.occurredAt), M: new Date(reply.occurredAt), C: [1, 0.84, 0.25],
        ...(reply.reviewState ? { StateModel: literal('Review'), State: literal(reply.reviewState) } : {}) });
      refs.set(reply.id, reference);
    }
    for (const reply of comment.replies) { const reference = refs.get(reply.id)!; reference.data.IRT = refs.get(reply.replyTo ?? comment.id)!; finishComment(pdf, primaryPage!, reference); }
  }
}
