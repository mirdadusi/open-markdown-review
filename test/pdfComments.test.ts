import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferedPdf, installPdfComments, PdfComment, PDF_COMMENT_PREFIX } from '../src/professional/pdfComments';
import { documentExportPlan } from '../src/professional/documentExportPlan';
import { digest, encode, jsonBytes, toBase64 } from '../src/professional/bytes';
import { pdfExportMode, reviewerStatusStyle, pdfDocumentList, assertPdfDocumentListRecovery, pdfDocumentListFromRenderer, PDF_DOCUMENT_LIST_PROFILE } from '../src/professional/pdfProfiles';
import { pdfOrientation, pdfOrientationFromRenderer, pdfOrientationToken, assertPdfOrientationRecovery } from '../src/professional/pdfProfiles';
import { pdfExportFingerprint, selectPdfTemplate } from '../src/professional/pdfTemplate';
import { pdfThreadStatus, pdfSuggestionStatus } from '../src/professional/pdfFindingStatus';
import { fold } from '../src/professional/state';
import type { Envelope, Event } from '../src/professional/types';

const at = '2026-10-19T08:00:00Z';
function fixture() {
  const ref = (data: Record<string, unknown>) => ({ data, end() {} });
  const pages = [0, 1].map(() => ({ width: 595, height: 842, dictionary: ref({}), annotations: [] as ReturnType<typeof ref>[] }));
  const destinations = new Map([['document', [pages[0].dictionary, 'XYZ', 45, 760, null]]]);
  const pdf: BufferedPdf = { page: pages[0], bufferedPageRange: () => ({ start: 0, count: pages.length }), switchToPage: i => { pdf.page = pages[i]; }, ref,
    _root: { data: { Names: { data: { Dests: { get: name => destinations.get(name) } } } } } };
  const mark = (page: number, ids: string, rect = [45, 700, 150, 713], original = '') => pages[page].annotations.push(ref({ Subtype: 'Link', Rect: rect, A: ref({ S: 'GoTo', D: PDF_COMMENT_PREFIX + ids + original }) }));
  const comment: PdfComment = { id: 'root', author: 'Příliš → reviewer', occurredAt: at, text: 'Root review', documentDestination: 'document', subject: 'Finding', replies: [] };
  return { pdf, pages, mark, comment, ref };
}
test('PDF native annotations use final geometry, preserve links, track cross-page spans and nest same-page replies', () => {
  const { pdf, pages, mark, comment, ref } = fixture();
  mark(0, 'root', [45, 700, 150, 713], '|document'); mark(0, 'root'); mark(1, 'root', [45, 680, 250, 693]);
  pages[0].annotations.push(ref({ Subtype: 'Link', A: ref({ S: 'URI', URI: 'https://example.com/evidence' }) }));
  comment.replies = [{ id: 'reply', author: 'A', occurredAt: at, text: 'Reply' }, { id: 'nested', replyTo: 'reply', author: 'B', occurredAt: at, text: 'Nested' }];
  comment.reviewStatus = { value: 'Completed', author: 'Initiator', occurredAt: at };
  installPdfComments(pdf, [comment]);
  const roots = pages.flatMap(p => p.annotations).filter(a => a.data.Subtype === 'Highlight');
  assert.equal(roots.length, 2); assert.deepEqual(roots[0].data.Rect, [45, 700, 150, 713]);
  assert.deepEqual(roots[0].data.QuadPoints, [45, 713, 150, 713, 45, 700, 150, 700]);
  assert.equal(roots[1].data.IRT, undefined, 'PDF reply references must never cross page boundaries.');
  assert.match(String(roots[1].data.Subj), /continued on page 2/);
  assert.equal(String(roots[0].data.T), comment.author);
  const replies = pages[0].annotations.filter(a => a.data.Subtype === 'Text' && !a.data.StateModel);
  assert.equal(replies[0].data.IRT, roots[0]); assert.equal(replies[1].data.IRT, replies[0]);
  for (const reply of replies) assert.ok((reply.data.Rect as number[])[2] < 40, 'Reply icons remain outside the document text area.');
  assert.deepEqual(replies.map(reply => String(reply.data.Contents)), ['Reply', 'Nested']);
  for (const [index, page] of pages.entries()) {
    const states = page.annotations.filter(a => a.data.StateModel);
    assert.equal(states.length, 1);
    const state = states[0].data;
    assert.equal(state.Subtype, 'Text'); assert.equal(state.IRT, roots[index]);
    assert.equal(state.P, page.dictionary); assert.equal(state.RT, 'R');
    assert.ok(state.State instanceof String && state.StateModel instanceof String);
    assert.equal(String(state.StateModel), 'Review'); assert.equal(String(state.State), 'Completed');
    assert.equal(String(state.T), 'Initiator'); assert.equal(String(state.Contents), '');
    assert.equal(state.F, 30, 'Match an Acrobat-authored review state: NoView alone is ignored by Acrobat.');
    assert.equal(state.Popup, undefined);
  }
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
  assert.equal(pages[0].annotations[0].data.Subtype, 'Text');
  assert.match(String(pages[0].annotations[0].data.Subj), /source-only anchor/);
  assert.equal(String(pages[0].annotations[0].data.Contents), comment.text);
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
  for (const patch of [{ reviewId: 'foreign' }, { revisionId: 'foreign' }, { actorId: 'foreign' }, { operationId: 'foreign' }, { pdf: { ...plan.pdf, path: '../private.pdf' } }, { pdf: { ...plan.pdf, byteLength: -1 } }, { includeDocumentList: 'yes' }]) assert.throws(() => documentExportPlan(jsonBytes({ ...plan, ...patch }), context, 'op'));
});

test('document-list choice is typed, mode-aware, independent of template styling and bound to recovery', () => {
  assert.equal(pdfDocumentList(), true); assert.equal(pdfDocumentList({}, 'clean'), false);
  assert.equal(pdfDocumentList({ includeDocumentList: false }), false); assert.equal(pdfDocumentList({ includeDocumentList: true }, 'clean'), true);
  assert.throws(() => pdfDocumentList({ includeDocumentList: 'false' } as never), /true or false/);
  assert.throws(() => selectPdfTemplate({ includeDocumentList: 'false' } as never), /true or false/);
  assert.equal(selectPdfTemplate({ includeDocumentList: false }), undefined, 'Hiding the list must not introduce a template or change Default styling.');
  assert.equal(pdfExportFingerprint(), 'Default'); assert.equal(pdfExportFingerprint({}, 'clean'), 'Default');
  assert.notEqual(pdfExportFingerprint({ includeDocumentList: false }), 'Default');
  assert.notEqual(pdfExportFingerprint({ includeDocumentList: true }, 'clean'), 'Default');
  assertPdfDocumentListRecovery(undefined, true, 'review'); assertPdfDocumentListRecovery(undefined, false, 'clean');
  assertPdfDocumentListRecovery(false, false, 'review');
  assert.throws(() => assertPdfDocumentListRecovery(false, true, 'review'), /different document-list/);
  assert.throws(() => assertPdfDocumentListRecovery(undefined, true, 'clean'), /different document-list/);
  assert.throws(() => assertPdfDocumentListRecovery('false', false, 'clean'), /different document-list/);
});

test('document-list renderer profile preserves legacy archives and rejects ambiguous or unsupported settings', () => {
  assert.equal(pdfDocumentListFromRenderer('pdfmake; legacy'), true);
  assert.equal(pdfDocumentListFromRenderer('pdfmake; ' + PDF_DOCUMENT_LIST_PROFILE + 'included'), true);
  assert.equal(pdfDocumentListFromRenderer('pdfmake; ' + PDF_DOCUMENT_LIST_PROFILE + 'omitted'), false);
  assert.throws(() => pdfDocumentListFromRenderer(PDF_DOCUMENT_LIST_PROFILE + 'yes'), /Invalid PDF document-list/);
  assert.throws(() => pdfDocumentListFromRenderer(PDF_DOCUMENT_LIST_PROFILE + 'included; ' + PDF_DOCUMENT_LIST_PROFILE + 'omitted'), /Invalid PDF document-list/);
});

test('portrait orientation is validated and binds recovery without changing legacy export keys', () => {
  assert.equal(pdfOrientation(), 'auto');
  assert.equal(pdfOrientationFromRenderer('pdfmake; legacy'), 'auto');
  const token = pdfOrientationToken('portrait');
  assert.equal(pdfOrientationFromRenderer('pdfmake' + token), 'portrait');
  assert.throws(() => pdfOrientationFromRenderer('pdfmake' + token + token), /Invalid PDF orientation/);
  assert.throws(() => selectPdfTemplate({ orientation: 'landscape' } as never), /auto or portrait/);
  assert.equal(selectPdfTemplate({ orientation: 'portrait' }), undefined);
  assert.equal(pdfExportFingerprint({ orientation: 'auto' }), pdfExportFingerprint());
  assert.notEqual(pdfExportFingerprint({ orientation: 'portrait' }), pdfExportFingerprint());
  assertPdfOrientationRecovery(undefined, 'auto');
  assert.throws(() => assertPdfOrientationRecovery(undefined, 'portrait'), /different page orientation/);
});

test('native PDF status maps the folded discussion and decision without overstating completion', () => {
  const base: Envelope = { schemaVersion: '0.6.0', id: 'comment', reviewId: 'review', revisionId: 'revision', revisionDigest: digest(encode('revision')), occurredAt: at, actor: { id: 'creator' }, operationId: 'fixture' };
  const anchor = { document: 'index.md', documentDigest: digest(encode('x')), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, quote: { exact: 'x' } };
  const body = { format: 'markdown' as const, text: 'Check this.' };
  const root: Event = { ...base, type: 'comment.created', threadId: 'thread', commentId: 'comment', anchor, body };
  const decided = (decision: 'accepted' | 'rejected' | 'wont-fix' | 'duplicate'): Event =>
    ({ ...base, id: decision, type: 'thread.decided', threadId: 'thread', decision, decisionPredecessors: [] });
  const closed: Event = { ...base, id: 'closed', type: 'thread.resolved', threadId: 'thread', statusPredecessors: [] };
  const reopened: Event = { ...base, id: 'reopened', type: 'thread.reopened', threadId: 'thread', reason: 'Recheck.', statusPredecessors: [closed.id] };
  const addressed: Event = { ...base, id: 'addressed', type: 'thread.addressed', threadId: 'thread', toRevisionId: 'new', document: anchor.document,
    sourceDigestBefore: anchor.documentDigest, sourceDigestAfter: digest(encode('y')), summary: 'Fixed.', decisionIds: ['accepted'], addressingPredecessors: [] };
  const challenged: Event = { ...base, id: 'challenged', type: 'thread.verification.recorded', threadId: 'thread', addressedEventId: addressed.id, verdict: 'challenged', verificationPredecessors: [] };
  const status = (...events: Event[]) => pdfThreadStatus(fold([root, ...events], base.revisionId).threads[0]);
  assert.equal(status().native, undefined);
  assert.match(status().subject, /Open.*No decision/);
  assert.deepEqual(status(closed).native, { value: 'Completed', event: closed });
  assert.deepEqual(status(closed, reopened).native, { value: 'None', event: reopened });
  assert.equal(status(closed, decided('accepted')).native?.value, 'Accepted');
  assert.match(status(closed, decided('accepted')).subject, /Closed.*Accepted.*Implementation pending/);
  assert.equal(status(closed, decided('accepted'), addressed).native?.value, 'Completed');
  assert.equal(status(closed, decided('accepted'), addressed, challenged).native?.value, 'None');
  for (const [decision, native] of [['rejected', 'Rejected'], ['wont-fix', 'Cancelled'], ['duplicate', 'Cancelled']] as const)
    assert.deepEqual(status(closed, decided(decision)).native, { value: native, event: decided(decision) });
  assert.equal(status(decided('accepted'), decided('rejected')).native, undefined);
  assert.match(status(decided('accepted'), decided('rejected')).subject, /Decision conflict/);

  const suggestion: Event = { ...base, id: 'suggestion', type: 'suggestion.created', suggestionId: 'suggestion', anchor, rationale: body, operation: { kind: 'delete' } };
  const accepted: Event = { ...base, id: 'suggestion-accept', type: 'suggestion.accepted', suggestionId: 'suggestion', decisionPredecessors: [] };
  const rejected: Event = { ...base, id: 'suggestion-reject', type: 'suggestion.rejected', suggestionId: 'suggestion', reason: 'Keep.', decisionPredecessors: [] };
  const applied: Event = { ...base, id: 'suggestion-apply', type: 'suggestion.applied', suggestionId: 'suggestion', document: anchor.document,
    sourceDigestBefore: anchor.documentDigest, sourceDigestAfter: addressed.sourceDigestAfter, acceptanceIds: [accepted.id] };
  const suggested = (...events: Event[]) => pdfSuggestionStatus(fold([suggestion, ...events], base.revisionId).suggestions[0]);
  assert.equal(suggested().native, undefined);
  assert.deepEqual(suggested(accepted).native, { value: 'Accepted', event: accepted });
  assert.deepEqual(suggested(rejected).native, { value: 'Rejected', event: rejected });
  assert.deepEqual(suggested(accepted, applied).native, { value: 'Completed', event: applied });
  assert.equal(suggested(accepted, rejected).native, undefined);
});
