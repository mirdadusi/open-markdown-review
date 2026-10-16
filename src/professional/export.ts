import pdfMake from 'pdfmake/build/pdfmake';
import fonts from 'pdfmake/build/vfs_fonts';
import pdfPackage from 'pdfmake/package.json';
import mermaidPackage from 'mermaid/package.json';
import markdownPackage from 'markdown-it/package.json';
import { digest, encode, jsonBytes, newId, decode, ascii, parseJson, toBase64, fromBase64 } from './bytes';
import { renderDocument } from './rendering';
import { populateAssets, sanitizeSvg } from './assets';
import { CapturedAudit, ActionContext } from './session';
import { AuditInventory, Event, LIMITS, Renderer, REVIEWER_COMPLETION } from './types';
import { blobEvidence, evidence, publish } from './storage';
import { fold, reviewerProgress, threadWorkflowQueue } from './state';
import { invitationAllowed } from './reviewer';
import { validate } from './validation';
import eventSchema05 from '../../protocol/schemas/v0.5/event.schema.json';
import manifestSchema05 from '../../protocol/schemas/v0.5/manifest.schema.json';
import revisionSchema05 from '../../protocol/schemas/v0.5/revision.schema.json';
import policySchema05 from '../../protocol/schemas/v0.5/policy.schema.json';
import verificationSchema05 from '../../protocol/schemas/v0.5/verification.schema.json';
import inventorySchema05 from '../../protocol/schemas/v0.5/inventory.schema.json';
import eventSchema06 from '../../protocol/schemas/v0.6/event.schema.json';
import manifestSchema06 from '../../protocol/schemas/v0.6/manifest.schema.json';
import revisionSchema06 from '../../protocol/schemas/v0.6/revision.schema.json';
import policySchema06 from '../../protocol/schemas/v0.6/policy.schema.json';
import verificationSchema06 from '../../protocol/schemas/v0.6/verification.schema.json';
import inventorySchema06 from '../../protocol/schemas/v0.6/inventory.schema.json';
import clientPackage from '../../package.json';
import { loadSlidev } from './profiles/slidev';
import { SANITIZED_HTML_PROFILE, SANITIZED_HTML_VERSION } from './html';
import { OperationControl, checkpoint, interruptible } from './operation';
import { SVG_SANITIZER_VERSION } from './svg';
import { PdfNode, pdfFonts, pdfFontVfs, pdfFontSources, preparePdfTypography, PDF_LAYOUT_VERSION } from './pdfTypography';
import { pdfNodes, pdfNavigation, documentDestination, PDF_PORTRAIT_WIDTH, PDF_LANDSCAPE_WIDTH, highlightPdfFindings } from './pdfLayout';

pdfMake.addVirtualFileSystem(fonts);
pdfMake.addFonts(pdfFonts);
let fontsReady: Promise<void> | undefined;
export interface ExportResult { pdfPath: string; inventoryPath: string; event: Event }
interface ExportPlan { reviewId: string; revisionId: string; actorId: string; pdf?: number[]; pdfBase64?: string; inventory: AuditInventory; event: Event; diagrams: Array<{ path: string; bytes?: number[]; base64?: string }> }
export interface ArchiveFindingIndexEntry {
  reference: string;
  kind: 'comment' | 'suggested-edit';
  eventId: string;
  subjectId: string;
  document: string;
  line: number;
  character: number;
  quote: string;
  status: string;
  detailDestination: string;
  markerDestination: string;
}
const eventOrder = (a: Event, b: Event) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || ascii(a.id, b.id);
const compactQuote = (value: string, limit = 180) => { const normalized = value.replace(/\s+/g, ' ').trim(); return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized; };
// PDF table minimum widths must not be determined by one unbroken address.
const wrapIdentity = (value: string) => value.replace(/([^\s\u200b]{24})(?=[^\s\u200b])/gu, '$1\u200b');
/** Deterministic, renderer-neutral index used by the PDF archive and tests. */
export function archiveFindingIndex(events: readonly Event[], revisionId: string, documents: readonly string[]): ArchiveFindingIndexEntry[] {
  const state = fold(events, revisionId), documentOrder = new Map(documents.map((path, index) => [path, index]));
  const findings: Array<Omit<ArchiveFindingIndexEntry, 'reference'>> = [
    ...state.threads.map(thread => ({
      kind: 'comment' as const, eventId: thread.root.id, subjectId: thread.root.threadId, document: thread.root.anchor.document,
      line: thread.root.anchor.range.start.line + 1, character: thread.root.anchor.range.start.character + 1, quote: thread.root.anchor.quote.exact,
      status: `${thread.open ? 'open' : 'resolved'}${thread.status.conflict || thread.decision.conflict || thread.addressing.conflict || thread.verification.conflict ? ' - conflict' : ''}${thread.addressed ? ` - ${threadWorkflowQueue(thread)}` : ''}`,
      detailDestination: `finding-${thread.root.id}`, markerDestination: `marker-${thread.root.id}`
    })),
    ...state.suggestions.map(suggestion => ({
      kind: 'suggested-edit' as const, eventId: suggestion.root.id, subjectId: suggestion.root.suggestionId, document: suggestion.root.anchor.document,
      line: suggestion.root.anchor.range.start.line + 1, character: suggestion.root.anchor.range.start.character + 1, quote: suggestion.root.anchor.quote.exact,
      status: suggestion.status, detailDestination: `finding-${suggestion.root.id}`, markerDestination: `marker-${suggestion.root.id}`
    }))
  ];
  findings.sort((a, b) => (documentOrder.get(a.document) ?? Number.MAX_SAFE_INTEGER) - (documentOrder.get(b.document) ?? Number.MAX_SAFE_INTEGER) || a.line - b.line || a.character - b.character || ascii(a.kind, b.kind) || ascii(a.eventId, b.eventId));
  return findings.map((finding, index) => ({ ...finding, reference: `F-${String(index + 1).padStart(3, '0')}` }));
}
async function publishExportPlan(context: ActionContext, plan: ExportPlan, operationId: string): Promise<ExportResult> {
  const session = context.session;
  if (plan.reviewId !== session.manifest.reviewId || plan.revisionId !== context.revision.id || plan.actorId !== context.actor.id) throw new Error('Export recovery belongs to a different review, revision or actor.');
  for (const diagram of plan.diagrams) { const bytes = diagram.base64 === undefined ? new Uint8Array(diagram.bytes ?? []) : fromBase64(diagram.base64); await publish(session.storage, `${operationId}_${digest(bytes).slice(7)}`, evidence(diagram.path, bytes, 'image/svg+xml'), bytes); }
  const pdfBytes = plan.pdfBase64 === undefined ? new Uint8Array(plan.pdf ?? []) : fromBase64(plan.pdfBase64); await publish(session.storage, `${operationId}_pdf`, plan.inventory.pdf, pdfBytes);
  if (plan.event.type !== 'export.created') throw new Error('Invalid export recovery event.');
  await publish(session.storage, `${operationId}_inventory`, plan.event.inventory, jsonBytes(plan.inventory));
  await session.save(context, plan.event);
  return { pdfPath: plan.inventory.pdf.path, inventoryPath: plan.event.inventory.path, event: plan.event };
}
/** One immutable input plan for both browser and VS Code, independent of visible UI filters. */
export async function exportAudit(context: ActionContext, captured?: CapturedAudit, operationId = newId('export'), control?: OperationControl): Promise<ExportResult> {
  const session = context.session;
  checkpoint(control, 'Checking for a resumable export…');
  const previous = await session.storage.journalGet(`export-plan:${operationId}`);
  if (previous) return publishExportPlan(context, parseJson<ExportPlan>(new Uint8Array(previous.bytes), LIMITS.pdf * 6), operationId);
  checkpoint(control, 'Verifying the complete review evidence…');
  const audit = captured ?? await session.audit(context, control), exportId = newId('export');
  checkpoint(control);
  const schemaSet = audit.manifest.protocolVersion === '0.6.0'
    ? { event: eventSchema06, manifest: manifestSchema06, revision: revisionSchema06, policy: policySchema06, verification: verificationSchema06, inventory: inventorySchema06 }
    : { event: eventSchema05, manifest: manifestSchema05, revision: revisionSchema05, policy: policySchema05, verification: verificationSchema05, inventory: inventorySchema05 };
  const renderer: Renderer = { client: 'open-markdown-review-shared', clientVersion: clientPackage.version, markdownVersion: markdownPackage.version, mermaidVersion: mermaidPackage.version, pdfEngine: `pdfmake ${pdfPackage.version}; ${PDF_LAYOUT_VERSION}`, fontSetDigest: digest(jsonBytes({ roboto: fonts, additional: pdfFontSources })), sanitizerVersion: `${audit.revision.renderer.markdownProfile === SANITIZED_HTML_PROFILE ? SANITIZED_HTML_VERSION : 'omr-html-disabled'}+${SVG_SANITIZER_VERSION}`, schemaSetDigest: digest(jsonBytes(schemaSet)) };
  const state = fold(audit.events, audit.revision.id);
  const reviewers = reviewerProgress(audit.manifest, audit.events, audit.revision.id);
  const actorLabel = (event: Event) => { const email = reviewers.find(reviewer => reviewer.id === event.actor.id)?.email; return event.actor.displayName ? `${event.actor.displayName}${email ? ` <${email}>` : ''}` : email ?? event.actor.id; };
  const countedReviewers = audit.manifest.reviewers ? reviewers.filter(r => r.email) : reviewers;
  const completionEnabled = audit.manifest.requiredCapabilities.includes(REVIEWER_COMPLETION);
  const completionLabels: Record<string, string> = { 'not-started': 'Not started', 'in-progress': 'In progress', finished: 'Finished', reopened: 'Reopened', conflicted: 'Conflicted' };
  const orderedDocuments = [...audit.revision.documents].sort((a, b) => a.path === audit.revision.rootDocument ? -1 : b.path === audit.revision.rootDocument ? 1 : ascii(a.path, b.path));
  const findingIndex = archiveFindingIndex(audit.events, audit.revision.id, orderedDocuments.map(item => item.path));
  const threads = new Map(state.threads.map(thread => [thread.root.threadId, thread]));
  const suggestions = new Map(state.suggestions.map(suggestion => [suggestion.root.suggestionId, suggestion]));
  const rootFor = (finding: ArchiveFindingIndexEntry) => finding.kind === 'comment' ? threads.get(finding.subjectId)!.root : suggestions.get(finding.subjectId)!.root;
  const renderedDocuments = orderedDocuments.map(doc => {
    const source = decode(audit.bytes.get(doc.blobPath)!), rendered = renderDocument(source, doc.path, audit.revision), host = document.createElement('article');
    host.innerHTML = rendered.html;
    highlightPdfFindings(host, rendered, source, findingIndex.filter(finding => finding.document === doc.path).map(finding => ({ anchor: rootFor(finding).anchor, destination: finding.detailDestination, reference: finding.reference })));
    return { path: doc.path, host };
  });
  const navigation = pdfNavigation(renderedDocuments);
  const documentContent: PdfNode[] = [], findingsContent: PdfNode[] = [], participationContent: PdfNode[] = [], stanceContent: PdfNode[] = [], appendixContent: PdfNode[] = [], resourceContent: PdfNode[] = [];
  const content: PdfNode[] = [
    { text: audit.manifest.title, fontSize: 26, bold: true, color: '#2458a6' },
    { text: 'Offline auditable review archive', fontSize: 16, margin: [0, 10, 0, 20] },
    { text: `Review: ${audit.manifest.reviewId}\nRevision: ${audit.revision.id}\nExport: ${exportId}\nVerified cutoff: ${audit.inventory.verifiedAt}\nExported by: ${context.actor.displayName ?? context.actor.id} (${context.actor.id})\nPolicy result: ${audit.inventory.policyResult}` },
    { text: 'This PDF preserves the frozen review documents and a complete human-readable record of challenged topics, comments, responses, decisions, suggested edits, and review stances. It can be read offline. The detached JSON inventory remains the machine-verifiable exact-byte record.', margin: [0, 15, 0, 8] },
    { text: 'Identities are self-asserted. This archive covers the exact locally observed event set at the verification cutoff, not events still disconnected or in transit.', italics: true, margin: [0, 0, 0, 15] },
    { text: 'Archive sections', fontSize: 16, bold: true, color: '#2458a6', margin: [0, 10, 0, 5] },
    ...(completionEnabled ? [{ text: `Reviewer completion: ${countedReviewers.filter(r => r.status === 'finished').length} of ${countedReviewers.length} ${audit.manifest.reviewers ? 'invited ' : ''}reviewers finished this revision. ${countedReviewers.filter(r => ['in-progress', 'reopened'].includes(r.status)).length} ongoing; ${countedReviewers.filter(r => r.status === 'not-started').length} not started. Completion is separate from approval or rejection.`, bold: true, margin: [0, 0, 0, 12] }] : []),
    ...[
      ...(completionEnabled ? [['Reviewer status and participation', 'review-participants']] : []),
      ['Comments, replies and suggested edits', 'review-findings'], ['Approvals, rejections and outcome', 'review-stances'], ['Reviewed documents - clickable contents', 'review-documents'], ['Audit appendix and file inventory', 'review-audit']
    ].map(([text, destination]) => ({ columns: [{ text, color: '#2458a6', decoration: 'underline', linkToDestination: destination }, { text: [{ text: 'page ' }, { pageReference: destination }], width: 55, alignment: 'right' }], margin: [0, 3, 0, 3] })),
    { text: 'Yellow source highlights link to full review discussions. Tables wider than five columns use landscape document pages. Images keep their proportions and do not expand small source graphics.', fontSize: 9, color: '#526477', margin: [0, 10, 0, 5] },
    { text: 'Review snapshot', fontSize: 18, bold: true, color: '#2458a6', margin: [0, 12, 0, 6] },
    { text: `${findingIndex.length} challenged topic(s): ${state.threads.filter(item => item.open).length} open comment finding(s), ${state.threads.filter(item => !item.open).length} resolved comment finding(s), and ${state.suggestions.filter(item => item.open).length} unfinished suggested edit(s).`, margin: [0, 0, 0, 8] }
  ];
  const challengeContent: PdfNode[] = [];
  if (findingIndex.length) challengeContent.push({
    table: { headerRows: 1, widths: [48, 72, 92, '*'], body: [
      [{ text: 'Item', bold: true }, { text: 'Status', bold: true }, { text: 'Location', bold: true }, { text: 'Challenged topic', bold: true }],
      ...findingIndex.map(finding => [
        { text: finding.reference, bold: true, color: '#2458a6', linkToDestination: finding.detailDestination },
        finding.status.toUpperCase(), { text: `${finding.document}:${finding.line}:${finding.character}`, linkToDestination: documentDestination(finding.document), color: '#2458a6' }, compactQuote(finding.quote)
      ])
    ] }, layout: 'lightHorizontalLines', margin: [0, 0, 0, 12]
  });
  else challengeContent.push({ text: 'No comments or suggested edits were recorded for this revision.', italics: true, margin: [0, 0, 0, 12] });
  const diagrams: AuditInventory['renderedDiagrams'] = [];
  for (const diagnostic of audit.diagnostics) content.push({ text: `Notice: ${diagnostic.path ?? ''} ${diagnostic.message}`, fontSize: 9, margin: [0, 8, 0, 0] });
  const diagramBytes: ExportPlan['diagrams'] = [];
  const frozenSources = new Map(audit.revision.documents.map(d => [d.path, decode(audit.bytes.get(d.blobPath)!)]));
  const presentation = await loadSlidev(audit.manifest, audit.revision, frozenSources, async c => audit.bytes.get(c.blobPath)!);
  documentContent.push({ text: 'Reviewed documents', id: 'review-documents', outline: true, outlineText: 'Reviewed documents', pageOrientation: 'portrait', pageBreak: 'before', fontSize: 20, bold: true, color: '#2458a6' },
    { text: 'Select a title or page number to navigate offline. Original scope paths are retained below each title. Review highlights link to the discussion section.', margin: [0, 8, 0, 12] });
  for (const doc of orderedDocuments) documentContent.push({ columns: [
    { stack: [{ text: navigation.documents.get(doc.path)!.title, color: '#2458a6', decoration: 'underline', linkToDestination: documentDestination(doc.path) }, { text: doc.path, fontSize: 8, color: '#526477' }] },
    { text: [{ pageReference: documentDestination(doc.path) }], alignment: 'right', width: 35 }
  ], margin: [0, 0, 0, 8] });
  if (presentation) {
    documentContent.push({ text: `Slidev presentation - ${presentation.slides.length} frozen slides - renderer ${presentation.rendererVersion} - notes ${presentation.notes}`, bold: true, margin: [0, 15, 0, 5] });
    for (const limitation of presentation.limitations) documentContent.push({ text: limitation, fontSize: 9, margin: [0, 4, 0, 0] });
    for (const slide of presentation.slides) {
      const resource = audit.revision.resources.find(r => r.id === slide.previewResourceId)!;
      const slideFindings = findingIndex.filter(finding => { const target = rootFor(finding).anchor.target; return target?.kind === 'image' && target.resourceId === slide.previewResourceId; });
      documentContent.push({ text: `Slide ${slide.number} - ${slide.title}`, pageBreak: 'before', fontSize: 20, bold: true },
        { image: `data:image/png;base64,${toBase64(audit.bytes.get(resource.blobPath)!)}`, fit: [475, 500], margin: [0, 14, 0, 10] },
        { text: `${slide.id}\nSource: ${slide.document} - UTF-16 offsets ${slide.range.start}-${slide.range.end}\nFrozen image: ${resource.digest}`, fontSize: 8 });
      if (slideFindings.length) documentContent.push({ text: [{ text: 'Review items on this slide: ', bold: true }, ...slideFindings.flatMap((finding, index) => [...(index ? [{ text: ', ' }] : []), { text: finding.reference, color: '#2458a6', linkToDestination: finding.detailDestination }])], margin: [0, 8, 0, 0] });
      if (presentation.notes === 'included' && slide.noteRange) documentContent.push({ text: 'Speaker notes', bold: true, margin: [0, 10, 0, 5] }, { text: frozenSources.get(slide.document)!.slice(slide.noteRange.start, slide.noteRange.end), fontSize: 10 });
    }
  }
  for (const doc of orderedDocuments) {
    checkpoint(control, `Rendering ${doc.path} for the offline archive…`);
    const layout = navigation.documents.get(doc.path)!, host = layout.host, width = layout.landscape ? PDF_LANDSCAPE_WIDTH : PDF_PORTRAIT_WIDTH;
    const svgs = await populateAssets(host, audit.revision, async c => { const bytes = audit.bytes.get(c.blobPath); if (!bytes) throw new Error('Frozen export input is missing.'); return bytes; }, control);
    const documentFindings = findingIndex.filter(finding => finding.document === doc.path);
    documentContent.push({ text: presentation ? `Frozen source: ${layout.title}` : layout.title, id: documentDestination(doc.path), outline: true, outlineText: layout.title, outlineParentId: 'review-documents', pageOrientation: layout.landscape ? 'landscape' : 'portrait', pageBreak: 'before', fontSize: 18, bold: true, color: '#2458a6' },
      { text: [{ text: 'Contents', linkToDestination: 'review-documents', color: '#2458a6', decoration: 'underline' }, { text: '  |  ' }, { text: 'Review comments', linkToDestination: 'review-findings', color: '#2458a6', decoration: 'underline' }, { text: `\n${doc.path}\n${doc.digest}` }], fontSize: 8, margin: [0, 5, 0, 10] });
    documentContent.push({ text: 'Challenge map for this document', fontSize: 13, bold: true, margin: [0, 7, 0, 5] });
    if (documentFindings.length) documentContent.push({
      table: { headerRows: 1, widths: [48, 68, 62, '*'], body: [
        [{ text: 'Item', bold: true }, { text: 'Status', bold: true }, { text: 'Line', bold: true }, { text: 'Challenged text or object', bold: true }],
        ...documentFindings.map(finding => [
          { text: finding.reference, id: finding.markerDestination, bold: true, color: '#2458a6', linkToDestination: finding.detailDestination },
          finding.status.toUpperCase(), `${finding.line}:${finding.character}`, compactQuote(finding.quote)
        ])
      ] }, layout: 'lightHorizontalLines', margin: [0, 0, 0, 12]
    });
    else documentContent.push({ text: 'No challenged topics were recorded in this document.', italics: true, fontSize: 8, color: '#526477', margin: [0, 0, 0, 8] });
    try { documentContent.push(...(presentation ? [{ text: frozenSources.get(doc.path), fontSize: 8, font: 'Mono' }] : await pdfNodes(host, { document: doc.path, navigation, width, control }))); }
    catch (error) { throw new Error(`PDF layout failed in ${doc.path}: ${error instanceof Error ? error.message : String(error)}`); }
    for (const resource of audit.revision.resources.filter(r => r.document === doc.path)) resourceContent.push({ text: `${resource.role}: ${resource.originalReference}\nDocument: ${doc.path}\n${resource.digest} (${resource.byteLength} bytes; ${resource.mediaType})`, id: `attachment-${resource.id}`, fontSize: 8, color: '#526477', margin: [0, 5, 0, 6] });
    for (const reference of audit.revision.externalReferences.filter(r => r.document === doc.path)) resourceContent.push({ text: `External live reference - not captured for offline use: ${reference.uri}\nDocument: ${doc.path}`, fontSize: 8, margin: [0, 5, 0, 6] });
    for (const [diagramId, svg] of svgs) {
      const bytes = encode(sanitizeSvg(svg)), file = blobEvidence(bytes, 'image/svg+xml');
      diagrams.push({ diagramId, sourceDigest: audit.revision.mermaidDiagrams.find(d => d.id === diagramId)!.sourceDigest, svg: file });
      diagramBytes.push({ path: file.path, base64: toBase64(bytes) });
    }
  }
  findingsContent.push({ text: 'Review comments, responses and challenged topics', id: 'review-findings', outline: true, outlineText: 'Comments, responses and challenged topics', pageBreak: 'before', fontSize: 20, bold: true, color: '#2458a6' });
  findingsContent.push({ text: 'Every comment finding and suggested edit is recorded here once with its frozen location, exact challenged text, complete response history, and current outcome. Use the item links to move between this section and each document challenge map.', margin: [0, 5, 0, 12] });
  findingsContent.push(...challengeContent);
  if (!findingIndex.length) findingsContent.push({ text: 'No challenged topics were recorded for this revision.', italics: true });
  for (const finding of findingIndex) {
    const backLink: PdfNode = { text: 'Back to document challenge map', color: '#2458a6', linkToDestination: finding.markerDestination, fontSize: 8, margin: [0, 2, 0, 8] };
    findingsContent.push({ text: `${finding.reference} - ${finding.kind === 'comment' ? 'Comment finding' : 'Suggested edit'} - ${finding.status.toUpperCase()}`, id: finding.detailDestination, fontSize: 15, bold: true, color: '#2458a6', margin: [0, 16, 0, 2] }, backLink,
      { text: `Location: ${finding.document}:${finding.line}:${finding.character}\nRoot event: ${finding.eventId}`, fontSize: 8, color: '#526477' },
      { text: 'Challenged text or object', bold: true, margin: [0, 8, 0, 3] }, { text: finding.quote, italics: true, background: '#f2f4f8', margin: [0, 0, 0, 7] });
    if (finding.kind === 'comment') {
      const thread = threads.get(finding.subjectId)!;
      findingsContent.push({ text: `Initial comment - ${actorLabel(thread.root)}`, bold: true, margin: [0, 5, 0, 2] }, { text: thread.root.occurredAt, fontSize: 8, color: '#526477', margin: [0, 0, 0, 4] }, { text: thread.root.body.text, margin: [0, 0, 0, 8] });
      const replies = [...thread.replies].filter((event): event is Extract<Event, { type: 'comment.replied' }> => event.type === 'comment.replied').sort(eventOrder);
      findingsContent.push({ text: `Responses (${replies.length})`, bold: true, margin: [0, 5, 0, 3] });
      if (!replies.length) findingsContent.push({ text: 'No responses.', italics: true, margin: [10, 0, 0, 5] });
      for (const reply of replies) findingsContent.push({ text: `${actorLabel(reply)} - ${reply.occurredAt}`, fontSize: 8, color: '#526477', margin: [10, 5, 0, 1] }, { text: reply.body.text, margin: [10, 0, 0, 4] });
      const transitions = [...thread.decision.history, ...thread.status.history, ...thread.addressing.history, ...thread.verification.history].sort(eventOrder);
      findingsContent.push({ text: `Decision, implementation, verification and lifecycle history (${transitions.length})`, bold: true, margin: [0, 7, 0, 3] });
      if (!transitions.length) findingsContent.push({ text: 'No decision, implementation, verification, or lifecycle transition.', italics: true, margin: [10, 0, 0, 5] });
      for (const transition of transitions) {
        const action = transition.type === 'thread.decided' ? `decision: ${transition.decision}` : transition.type === 'thread.resolved' ? 'thread closed' : transition.type === 'thread.reopened' ? 'thread reopened' : transition.type === 'thread.addressed' ? `implemented in ${transition.toRevisionId} (${transition.sourceDigestBefore} -> ${transition.sourceDigestAfter})` : transition.type === 'thread.verification.recorded' ? `implementation ${transition.verdict}` : transition.type;
        const explanation = transition.type === 'thread.addressed' ? transition.summary : 'reason' in transition && transition.reason ? transition.reason : 'note' in transition && transition.note ? transition.note : '';
        findingsContent.push({ text: `${actorLabel(transition)} - ${transition.occurredAt} - ${action}${explanation ? ` - ${explanation}` : ''}`, fontSize: 9, margin: [10, 3, 0, 1] });
      }
    } else {
      const suggestion = suggestions.get(finding.subjectId)!, operation = suggestion.root.operation;
      findingsContent.push({ text: `Proposal - ${actorLabel(suggestion.root)} - ${suggestion.root.occurredAt}`, bold: true, margin: [0, 5, 0, 3] }, { text: suggestion.root.rationale.text, margin: [0, 0, 0, 7] }, { text: 'Proposed change', bold: true, margin: [0, 4, 0, 3] });
      if (operation.kind !== 'insert') findingsContent.push({ text: operation.kind === 'delete' ? `Delete: ${finding.quote}` : `Replace: ${finding.quote}`, decoration: 'lineThrough', color: '#8b2f24' });
      if (operation.kind !== 'delete') findingsContent.push({ text: `${operation.kind === 'insert' ? `Insert ${operation.position}` : 'With'}: ${operation.replacement}`, color: '#146b35' });
      const transitions = [...suggestion.decision.history, ...suggestion.applications].sort(eventOrder);
      findingsContent.push({ text: `Suggestion history (${transitions.length})`, bold: true, margin: [0, 7, 0, 3] });
      if (!transitions.length) findingsContent.push({ text: 'No acceptance, rejection, or application event.', italics: true, margin: [10, 0, 0, 5] });
      for (const transition of transitions) {
        const action = transition.type === 'suggestion.accepted' ? 'accepted' : transition.type === 'suggestion.rejected' ? 'rejected' : transition.type === 'suggestion.applied' ? `applied (${transition.sourceDigestBefore} -> ${transition.sourceDigestAfter})` : transition.type;
        const explanation = 'reason' in transition && transition.reason ? transition.reason : 'note' in transition && transition.note ? transition.note : '';
        findingsContent.push({ text: `${actorLabel(transition)} - ${transition.occurredAt} - ${action}${explanation ? ` - ${explanation}` : ''}`, fontSize: 9, margin: [10, 3, 0, 1] });
      }
    }
  }
  if (completionEnabled) {
  participationContent.push({ text: 'Reviewer completion and participation', id: 'review-participants', outline: true, outlineText: 'Reviewer status and participation', pageBreak: 'before', fontSize: 20, bold: true, color: '#2458a6' },
    { text: `Status for revision ${audit.revision.id} at ${audit.inventory.verifiedAt}. Finishing is a participant assertion about this frozen revision, not approval. A later revision starts a new completion record. Email ownership is self-asserted.`, margin: [0, 8, 0, 12] });
  if (reviewers.length) participationContent.push({ table: { headerRows: 1, widths: [195, 65, 65, 132], body: [
    [{ text: 'Reviewer', bold: true }, { text: 'Review status', bold: true }, { text: 'Stance', bold: true }, { text: 'Last recorded activity', bold: true }],
    ...reviewers.map(r => [
      { text: wrapIdentity(`${r.email ?? r.displayName ?? r.id}${r.email && r.displayName ? `\n${r.displayName}` : ''}`), fontSize: 9 },
      completionLabels[r.status],
      r.stance.conflict ? 'Conflicted' : r.stance.heads.map(e => e.type.replace('review.', '')).join(' / ') || 'Not stated',
      { text: [...audit.events].filter(e => e.actor.id === r.id && !['export.created', 'revision.created', 'reviewer.invited'].includes(e.type)).sort(eventOrder).at(-1)?.occurredAt.replace('T', '\n').replace(/Z$/, ' UTC') ?? 'Not started', fontSize: 8 }
    ])
  ] }, fontSize: 9, layout: 'lightHorizontalLines', margin: [0, 0, 0, 12] });
  else participationContent.push({ text: 'No participant review activity has been recorded.', italics: true });
  const invitations = audit.events.filter(e => invitationAllowed(audit.manifest, e)).sort(eventOrder);
  if (invitations.length) {
    participationContent.push({ text: 'Reviewers added after creation', bold: true, margin: [0, 8, 0, 4] },
      { text: 'Initiator invitations apply across revisions. Existing completion records and revision approval quorums are unchanged. These records do not grant filesystem access or verify email ownership.', fontSize: 9, margin: [0, 0, 0, 6] });
    for (const invitation of invitations) participationContent.push({ text: `${wrapIdentity(invitation.reviewer.email)} - added by ${actorLabel(invitation)}\n${invitation.occurredAt} - Event: ${invitation.id}\nRecorded against revision: ${invitation.revisionId}`, fontSize: 9, margin: [10, 3, 0, 5] });
  }
  for (const reviewer of reviewers) {
    if (!reviewer.completion.history.length) continue;
    participationContent.push({ text: `${reviewer.email ?? reviewer.displayName ?? reviewer.id} - ${completionLabels[reviewer.status]}`, bold: true, margin: [0, 10, 0, 3] },
      { text: `Participant ID: ${reviewer.id}`, fontSize: 8, color: '#526477' });
    for (const event of [...reviewer.completion.history].sort(eventOrder)) participationContent.push({ text: `${event.occurredAt} - ${event.type === 'review.completed' ? 'Finished review' : 'Reopened review'}${'note' in event && event.note ? ` - ${event.note}` : ''}\nEvent: ${event.id}`, fontSize: 9, margin: [10, 4, 0, 3] });
  }
  }
  stanceContent.push({ text: 'Review stances and outcome', id: 'review-stances', outline: true, outlineText: 'Approvals, rejections and outcome', pageBreak: 'before', fontSize: 20, bold: true, color: '#2458a6' }, { text: `Policy result at verification cutoff: ${audit.inventory.policyResult}`, bold: true, margin: [0, 6, 0, 10] });
  if (!state.stances.length) stanceContent.push({ text: 'No participant approval or rejection assertions were recorded.', italics: true });
  for (const stance of [...state.stances].sort((a, b) => ascii(a.actor, b.actor))) {
    const history = [...stance.history].sort(eventOrder), current = stance.conflict ? 'conflicted' : stance.heads.map(event => event.type.replace('review.', '')).join(' / ');
    stanceContent.push({ text: `${history[0]?.actor.displayName ?? stance.actor} (${stance.actor}) - current status: ${current}`, bold: true, margin: [0, 10, 0, 3] });
    for (const transition of history) {
      const explanation = 'reason' in transition && transition.reason ? transition.reason : 'note' in transition && transition.note ? transition.note : '';
      stanceContent.push({ text: `${transition.occurredAt} - ${transition.type.replace('review.', '')}${explanation ? ` - ${explanation}` : ''}`, fontSize: 9, margin: [10, 2, 0, 1] });
    }
  }
  appendixContent.push({ text: 'Audit appendix and exact file inventory', id: 'review-audit', outline: true, outlineText: 'Audit appendix and exact file inventory', pageOrientation: 'portrait', pageBreak: 'before', fontSize: 18, bold: true, color: '#2458a6' });
  const eventInputs = new Map(audit.inventory.events.map(event => [event.eventId, event]));
  for (const event of audit.events) {
    const input = eventInputs.get(event.id)!;
    if (event.revisionId === audit.revision.id) {
      appendixContent.push({ text: `${event.type} - ${event.actor.displayName ?? event.actor.id} (${event.actor.id})\n${event.occurredAt}`, bold: true, margin: [0, 10, 0, 4] });
      const { schemaVersion, id, actor, occurredAt, reviewId, revisionId, revisionDigest, operationId: op, ...payload } = event;
      appendixContent.push({ text: JSON.stringify(payload, null, 2), fontSize: 8 });
    }
    appendixContent.push({ text: `${input.path}\n${input.digest} (${input.byteLength} bytes)`, fontSize: 7, margin: [0, 3, 0, 0] });
  }
  if (resourceContent.length) appendixContent.push({ text: 'Captured resources, attachments and external references', pageBreak: 'before', fontSize: 16, bold: true, color: '#2458a6' },
    { text: 'Frozen image bytes are rendered in their document pages. Other attachments remain in the review package at the exact inventory paths; uncaptured external references are not offline evidence.', fontSize: 9, margin: [0, 7, 0, 10] }, ...resourceContent);
  checkpoint(control, 'Generating the archival PDF…');
  fontsReady ??= pdfFontVfs().then(vfs => { pdfMake.addVirtualFileSystem(vfs); });
  await interruptible(fontsReady, control);
  const archiveContent = [...content, ...participationContent, ...findingsContent, ...stanceContent, ...documentContent, ...appendixContent];
  for (const node of archiveContent) preparePdfTypography(node);
  const footerTitle = audit.manifest.title.length > 65 ? audit.manifest.title.slice(0, 62) + '...' : audit.manifest.title;
  const pdfBytes = new Uint8Array(await interruptible(pdfMake.createPdf({
    info: { title: `${audit.manifest.title} - Offline review archive`, subject: `Open Markdown Review ${audit.manifest.reviewId}, revision ${audit.revision.id}`, author: context.actor.displayName ?? context.actor.id, keywords: 'Markdown review archive, comments, responses, challenged topics, audit' },
    content: archiveContent, defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.12, color: '#172b42' }, pageSize: 'A4', pageMargins: [45, 45, 45, 60],
    pageBreakBefore: (node: { headlineLevel?: number; startPosition?: { verticalRatio?: number } }, container: { getFollowingNodesOnPage(): unknown[] }) => !!node.headlineLevel && ((node.startPosition?.verticalRatio ?? 0) > 0.85 || container.getFollowingNodesOnPage().length === 0),
    footer: (page: number, total: number) => { const node = { text: `${footerTitle} - ${page} / ${total}`, alignment: 'center', fontSize: 8, margin: [45, 18, 45, 0] }; preparePdfTypography(node); return node; }
  }).getBuffer(), control));
  checkpoint(control);
  if (pdfBytes.length > LIMITS.pdf) throw new Error('PDF exceeds the protocol limit.');
  const pdf = evidence(`exports/${digest(pdfBytes).slice(7)}.pdf`, pdfBytes, 'application/pdf');
  const inventory = validate('inventory', { ...audit.inventory, kind: 'audit-export-inventory', exportId, pdf, representedEventIds: audit.events.filter(e => e.revisionId === audit.revision.id).map(e => e.id), renderedDiagrams: diagrams.sort((a, b) => ascii(a.diagramId, b.diagramId)), diagnostics: audit.diagnostics, renderer });
  const inventoryBytes = jsonBytes(inventory), file = evidence(`exports/${digest(inventoryBytes).slice(7)}.inventory.json`, inventoryBytes, 'application/json');
  const event = session.makeEvent(context, { type: 'export.created', exportId, format: 'application/pdf', pdf, inventory: file, renderer }, operationId);
  const plan: ExportPlan = { reviewId: audit.manifest.reviewId, revisionId: audit.revision.id, actorId: context.actor.id, pdfBase64: toBase64(pdfBytes), inventory, event, diagrams: diagramBytes };
  await session.storage.journalPut(`export-plan:${operationId}`, { path: file.path, bytes: Array.from(jsonBytes(plan)), acknowledged: false });
  checkpoint(control, 'Publishing the verified export; this final step will finish atomically per artifact…');
  return publishExportPlan(context, plan, operationId);
}
