import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferedPdf, installPdfComments, PdfComment, PDF_COMMENT_PREFIX } from '../src/professional/pdfComments';
import { documentExportPlan } from '../src/professional/documentExportPlan';
import { digest, encode, jsonBytes, toBase64 } from '../src/professional/bytes';
import { pdfExportMode, reviewerStatusStyle } from '../src/professional/pdfProfiles';

const at = '2026-10-19T08:00:00Z';
function fixture() {
  const ref = (data: Record<string, unknown>) => ({ data, end() {} });
  const pages = [0, 1].map(() => ({ width: 595, height: 842, dictionary: ref({}), annotations: [] as ReturnType<typeof ref>[] }));
  const destinations = new Map([['document', [pages[0].dictionary, 'XYZ', 45, 760, null]]]);
  const pdf: BufferedPdf = { page: pages[0], bufferedPageRange: () => ({ start: 0, count: pages.length }), switchToPage: i => { pdf.page = pages[i]; }, ref,
    _root: { data: { Names: { data: { Dests: { get: name => destinations.get(name) } } } } } };
  const mark = (page: number, ids: string, rect = [45, 700, 150, 713], original = '') => pages[page].annotations.push(ref({ Subtype: 'Link', Rect: rect, A: ref({ S: 'GoTo', D: PDF_COMMENT_PREFIX + ids + original }) }));
  const comment: PdfComment = { id: 'root', author: 'Příliš → reviewer', occurredAt: at, text: 'Root review', documentDestination: 'document', subject: 'Finding', quote: 'Selected text', kind: 'comment', replies: [] };
  return { pdf, pages, mark, comment, ref };
}
test('PDF native annotations use final geometry, preserve links, track cross-page spans and nest same-page replies', () => {
  const { pdf, pages, mark, comment, ref } = fixture();
  mark(0, 'root', [45, 700, 150, 713], '|document'); mark(0, 'root'); mark(1, 'root', [45, 680, 250, 693]);
  pages[0].annotations.push(ref({ Subtype: 'Link', A: ref({ S: 'URI', URI: 'https://example.com/evidence' }) }));
  comment.replies = [{ id: 'reply', author: 'A', occurredAt: at, text: 'Reply' }, { id: 'nested', replyTo: 'reply', author: 'B', occurredAt: at, text: 'Nested' }, { id: 'resolved', author: 'Initiator', occurredAt: at, text: 'Resolved', reviewState: 'Completed' }];
  installPdfComments(pdf, [comment]);
  const roots = pages.flatMap(p => p.annotations).filter(a => a.data.Subtype === 'Highlight');
  assert.equal(roots.length, 2); assert.deepEqual(roots[0].data.Rect, [45, 700, 150, 713]);
  assert.deepEqual(roots[0].data.QuadPoints, [45, 713, 150, 713, 45, 700, 150, 700]);
  assert.equal(roots[1].data.IRT, undefined, 'PDF reply references must never cross page boundaries.');
  assert.match(String(roots[1].data.Subj), /continued on page 2/);
  assert.equal(String(roots[0].data.T), comment.author);
  const replies = pages[0].annotations.filter(a => a.data.Subtype === 'Text');
  assert.equal(replies[0].data.IRT, roots[0]); assert.equal(replies[1].data.IRT, replies[0]);
  for (const reply of replies) assert.ok((reply.data.Rect as number[])[2] < 40, 'Reply icons remain outside the document text area.');
  assert.equal(String(replies[2].data.State), 'Completed'); assert.equal(String(replies[2].data.StateModel), 'Review');
  assert.ok(replies[2].data.State instanceof String, 'PDF state entries are text strings, not names.');
  for (const parent of [...roots, ...replies]) {
    const popup = parent.data.Popup as ReturnType<typeof ref>; assert.equal(popup.data.Parent, parent); assert.equal(popup.data.Open, false);
  }
  const links = pages[0].annotations.filter(a => a.data.Subtype === 'Link'); assert.equal(links.length, 2);
  assert.equal(String((links[0].data.A as ReturnType<typeof ref>).data.D), 'document');
});
test('PDF semantic object comments use bounded square markup; suggested deletions use native strikeout', () => {
  for (const [targetKind, strikeOut, subtype] of [['image', false, 'Square'], ['mermaid', false, 'Square'], ['table', false, 'Square'], ['text', true, 'StrikeOut']] as const) {
    const { pdf, pages, mark, comment } = fixture(); mark(0, 'root');
    installPdfComments(pdf, [{ ...comment, targetKind, strikeOut }]);
    const markup = pages[0].annotations[0]; assert.equal(markup.data.Subtype, subtype);
    assert.equal(!!markup.data.QuadPoints, subtype === 'StrikeOut');
  }
});
test('invisible anchors are honest source-only notes; malformed markers and ancestry fail closed', () => {
  const { pdf, pages, comment } = fixture(); installPdfComments(pdf, [comment]);
  assert.equal(pages[0].annotations[0].data.Subtype, 'Text'); assert.match(String(pages[0].annotations[0].data.Contents), /Source-only anchor/);
  for (const change of ['unknown', 'geometry', 'parent', 'cycle', 'duplicate'] as const) {
    const f = fixture(); f.mark(0, change === 'unknown' ? 'unknown' : 'root', change === 'geometry' ? [-5, 700, 150, 713] : undefined);
    if (change === 'parent') f.comment.replies = [{ id: 'reply', replyTo: 'missing', author: 'A', occurredAt: at, text: '' }];
    if (change === 'cycle') f.comment.replies = [{ id: 'reply', replyTo: 'reply', author: 'A', occurredAt: at, text: '' }];
    if (change === 'duplicate') f.comment.replies = [{ id: 'root', author: 'A', occurredAt: at, text: '' }];
    assert.throws(() => installPdfComments(f.pdf, [f.comment]));
  }
});
test('export profiles and reviewer colors are explicit; clean private records bind source, actor, operation and content path', () => {
  assert.equal(pdfExportMode(undefined), 'review'); assert.equal(pdfExportMode('clean'), 'clean'); assert.throws(() => pdfExportMode('both'));
  assert.deepEqual(reviewerStatusStyle('not-started'), {}); assert.equal(reviewerStatusStyle('in-progress').color, '#9a3412'); assert.equal(reviewerStatusStyle('reopened').color, '#9a3412'); assert.equal(reviewerStatusStyle('finished').color, '#166534');
  const bytes = encode('%PDF-fixture'), hash = digest(bytes), plan = { kind: 'omr-document-export/1', reviewId: 'review', revisionId: 'revision', actorId: 'actor', operationId: 'op', pdf: { path: `exports/${hash.slice(7)}.pdf`, mediaType: 'application/pdf', digest: hash, byteLength: bytes.length }, pdfBase64: toBase64(bytes) };
  const context = { reviewId: 'review', revisionId: 'revision', actorId: 'actor' };
  assert.deepEqual(documentExportPlan(jsonBytes(plan), context, 'op'), plan);
  for (const patch of [{ reviewId: 'foreign' }, { revisionId: 'foreign' }, { actorId: 'foreign' }, { operationId: 'foreign' }, { pdf: { ...plan.pdf, path: '../private.pdf' } }, { pdf: { ...plan.pdf, byteLength: -1 } }]) assert.throws(() => documentExportPlan(jsonBytes({ ...plan, ...patch }), context, 'op'));
});
