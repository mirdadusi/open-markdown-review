import pdfMake from 'pdfmake/build/pdfmake';
import fonts from 'pdfmake/build/vfs_fonts';
import pdfPackage from 'pdfmake/package.json';
import mermaidPackage from 'mermaid/package.json';
import markdownPackage from 'markdown-it/package.json';
import { digest, encode, jsonBytes, newId, decode, ascii, parseJson, toBase64, fromBase64 } from './bytes';
import { renderDocument } from './rendering';
import { populateAssets, rasterizeSvg, sanitizeSvg } from './assets';
import { CapturedAudit, ActionContext } from './session';
import { AuditInventory, Event, LIMITS, Renderer } from './types';
import { blobEvidence, evidence, publish } from './storage';
import { fold } from './state';
import { validate } from './validation';
import eventSchema from '../../protocol/schemas/v0.5/event.schema.json';
import manifestSchema from '../../protocol/schemas/v0.5/manifest.schema.json';
import revisionSchema from '../../protocol/schemas/v0.5/revision.schema.json';
import policySchema from '../../protocol/schemas/v0.5/policy.schema.json';
import verificationSchema from '../../protocol/schemas/v0.5/verification.schema.json';
import inventorySchema from '../../protocol/schemas/v0.5/inventory.schema.json';
import clientPackage from '../../package.json';
import { loadSlidev } from './profiles/slidev';
import { SANITIZED_HTML_PROFILE, SANITIZED_HTML_VERSION } from './html';

pdfMake.addVirtualFileSystem(fonts);
type PdfNode = Record<string, unknown>;
function inlineNodes(root: Node, style: PdfNode = {}): PdfNode[] {
  if (root.nodeType === Node.TEXT_NODE) return [{ text: root.textContent ?? '', ...style }];
  if (!(root instanceof Element)) return [];
  const tag = root.localName;
  const next: PdfNode = { ...style, ...(['strong', 'b'].includes(tag) ? { bold: true } : {}), ...(['em', 'i'].includes(tag) ? { italics: true } : {}), ...(['s', 'del'].includes(tag) ? { decoration: 'lineThrough' } : {}), ...(tag === 'u' ? { decoration: 'underline' } : {}), ...(tag === 'sup' ? { sup: true } : {}), ...(tag === 'sub' ? { sub: true } : {}), ...(tag === 'mark' ? { background: '#fff0ba' } : {}) };
  if (tag === 'a' && /^(?:https:|mailto:)/.test(root.getAttribute('href') ?? '')) next.link = root.getAttribute('href');
  if (tag === 'br') return [{ text: '\n' }];
  return [...root.childNodes].flatMap(n => inlineNodes(n, next));
}
function directTableRows(table: Element): Array<{ row: Element; header: boolean }> {
  const result: Array<{ row: Element; header: boolean }> = [];
  for (const child of table.children) {
    if (child.localName === 'tr') result.push({ row: child, header: false });
    else if (['thead', 'tbody', 'tfoot'].includes(child.localName)) for (const row of child.children) if (row.localName === 'tr') result.push({ row, header: child.localName === 'thead' });
  }
  return result;
}
async function pdfNodes(root: Node): Promise<PdfNode[]> {
  if (root.nodeType === Node.TEXT_NODE) return root.textContent?.trim() ? [{ text: root.textContent }] : [];
  if (!(root instanceof HTMLElement) && !(root instanceof SVGElement)) return [];
  const element = root as Element, tag = element.localName;
  // Browser rasterization preserves Mermaid's embedded CSS. PDF's limited SVG
  // interpreter otherwise renders CSS-styled nodes black. Keep the exact SVG in evidence.
  if (tag === 'svg') return [{ image: await rasterizeSvg(new XMLSerializer().serializeToString(element)), fit: [475, 500], margin: [0, 8, 0, 8] }];
  if (tag === 'img') {
    const img = element as HTMLImageElement; let url = img.src;
    if (url.startsWith('data:image/svg+xml;base64,')) {
      const raw = fromBase64(url.split(',')[1]);
      return [{ image: await rasterizeSvg(decode(raw)), fit: [Math.min(475, img.naturalWidth), 620], margin: [0, 6, 0, 6] }];
    }
    if (!/^data:image\/(?:png|jpeg);/i.test(url)) { const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; canvas.getContext('2d')!.drawImage(img, 0, 0); url = canvas.toDataURL('image/png'); }
    return [{ image: url, fit: [475, 620], margin: [0, 6, 0, 6] }];
  }
  if (tag === 'table') {
    const rows = directTableRows(element), body: PdfNode[][] = [], occupied: boolean[][] = []; let width = 0;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      body[rowIndex] ??= []; occupied[rowIndex] ??= []; let column = 0;
      for (const cell of rows[rowIndex].row.children) {
        if (!['td', 'th'].includes(cell.localName)) continue;
        while (occupied[rowIndex][column]) column++;
        const colSpan = Math.min(100, Math.max(1, Number.parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1));
        const rowSpan = Math.min(100, Math.max(1, Number.parseInt(cell.getAttribute('rowspan') ?? '1', 10) || 1));
        body[rowIndex][column] = { stack: await pdfNodes(cell), fillColor: cell.localName === 'th' ? '#e5ecf6' : '#ffffff', bold: cell.localName === 'th', ...(colSpan > 1 ? { colSpan } : {}), ...(rowSpan > 1 ? { rowSpan } : {}) };
        for (let y = rowIndex; y < rowIndex + rowSpan; y++) for (let x = column; x < column + colSpan; x++) {
          occupied[y] ??= []; body[y] ??= []; occupied[y][x] = true;
          if (y !== rowIndex || x !== column) body[y][x] ??= {};
        }
        column += colSpan; width = Math.max(width, column);
      }
    }
    for (const row of body) for (let column = 0; column < width; column++) row[column] ??= {};
    const explicitHeaders = rows.findIndex(item => !item.header), headerRows = explicitHeaders < 0 ? rows.length : explicitHeaders || (rows[0]?.row.children.length && [...rows[0].row.children].every(cell => cell.localName === 'th') ? 1 : 0);
    return [{ table: { headerRows, widths: Array.from({ length: Math.max(width, 1) }, () => '*'), body: body.length ? body : [[{ text: '' }]] }, layout: 'lightHorizontalLines', margin: [0, 8, 0, 8] }];
  }
  const children = (await Promise.all([...element.childNodes].map(pdfNodes))).flat();
  if (!children.length) return [];
  if (/^h[1-6]$/.test(tag)) return [{ text: element.textContent, fontSize: 22 - Number(tag[1]) * 2, bold: true, margin: [0, 14, 0, 6] }];
  if (['p', 'figcaption', 'td', 'th', 'li'].includes(tag) && !element.querySelector('img,svg,table,ul,ol,p')) return [{ text: inlineNodes(element), margin: [0, 4, 0, 6] }];
  if (tag === 'p' || tag === 'figcaption') return [{ stack: children, margin: [0, 4, 0, 6] }];
  if (tag === 'pre') return [{ text: element.textContent, fontSize: 8, background: '#f2f4f8', margin: [0, 6, 0, 6] }];
  if (tag === 'ul' || tag === 'ol') return [{ [tag]: children.map(c => c.stack ? c : { stack: [c] }) }];
  if (tag === 'li' || tag === 'td' || tag === 'th') return children;
  if (['strong', 'b', 'em', 'i', 'code', 'del', 's', 'a', 'span', 'u', 'sup', 'sub', 'mark', 'kbd', 'small', 'ins'].includes(tag) && !element.querySelector('img,svg,table')) {
    const inline: PdfNode = { text: element.textContent, ...(tag === 'strong' || tag === 'b' ? { bold: true } : {}), ...(tag === 'em' || tag === 'i' ? { italics: true } : {}), ...(tag === 's' || tag === 'del' ? { decoration: 'lineThrough' } : {}), ...(tag === 'u' ? { decoration: 'underline' } : {}), ...(tag === 'sup' ? { sup: true } : {}), ...(tag === 'sub' ? { sub: true } : {}), ...(tag === 'mark' ? { background: '#fff0ba' } : {}) };
    if (tag === 'a' && /^(?:https:|mailto:)/.test(element.getAttribute('href') ?? '')) inline.link = element.getAttribute('href');
    return [inline];
  }
  return children;
}
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
const actorLabel = (event: Event) => `${event.actor.displayName ?? event.actor.id} (${event.actor.id})`;
/** Deterministic, renderer-neutral index used by the PDF archive and tests. */
export function archiveFindingIndex(events: readonly Event[], revisionId: string, documents: readonly string[]): ArchiveFindingIndexEntry[] {
  const state = fold(events, revisionId), documentOrder = new Map(documents.map((path, index) => [path, index]));
  const findings: Array<Omit<ArchiveFindingIndexEntry, 'reference'>> = [
    ...state.threads.map(thread => ({
      kind: 'comment' as const, eventId: thread.root.id, subjectId: thread.root.threadId, document: thread.root.anchor.document,
      line: thread.root.anchor.range.start.line + 1, character: thread.root.anchor.range.start.character + 1, quote: thread.root.anchor.quote.exact,
      status: `${thread.open ? 'open' : 'resolved'}${thread.status.conflict || thread.decision.conflict ? ' - conflict' : ''}`,
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
export async function exportAudit(context: ActionContext, captured?: CapturedAudit, operationId = newId('export')): Promise<ExportResult> {
  const session = context.session;
  const previous = await session.storage.journalGet(`export-plan:${operationId}`);
  if (previous) return publishExportPlan(context, parseJson<ExportPlan>(new Uint8Array(previous.bytes), LIMITS.pdf * 6), operationId);
  const audit = captured ?? await session.audit(context), exportId = newId('export');
  const renderer: Renderer = { client: 'open-markdown-review-shared', clientVersion: clientPackage.version, markdownVersion: markdownPackage.version, mermaidVersion: mermaidPackage.version, pdfEngine: `pdfmake ${pdfPackage.version}`, fontSetDigest: digest(jsonBytes(fonts)), sanitizerVersion: `${audit.revision.renderer.markdownProfile === SANITIZED_HTML_PROFILE ? SANITIZED_HTML_VERSION : 'omr-html-disabled'}+omr-svg-static-1`, schemaSetDigest: digest(jsonBytes({ event: eventSchema, manifest: manifestSchema, revision: revisionSchema, policy: policySchema, verification: verificationSchema, inventory: inventorySchema })) };
  const state = fold(audit.events, audit.revision.id);
  const orderedDocuments = [...audit.revision.documents].sort((a, b) => a.path === audit.revision.rootDocument ? -1 : b.path === audit.revision.rootDocument ? 1 : ascii(a.path, b.path));
  const findingIndex = archiveFindingIndex(audit.events, audit.revision.id, orderedDocuments.map(item => item.path));
  const threads = new Map(state.threads.map(thread => [thread.root.threadId, thread]));
  const suggestions = new Map(state.suggestions.map(suggestion => [suggestion.root.suggestionId, suggestion]));
  const rootFor = (finding: ArchiveFindingIndexEntry) => finding.kind === 'comment' ? threads.get(finding.subjectId)!.root : suggestions.get(finding.subjectId)!.root;
  const content: PdfNode[] = [
    { text: audit.manifest.title, fontSize: 26, bold: true, color: '#2458a6' },
    { text: 'Offline auditable review archive', fontSize: 16, margin: [0, 10, 0, 20] },
    { text: `Review: ${audit.manifest.reviewId}\nRevision: ${audit.revision.id}\nExport: ${exportId}\nVerified cutoff: ${audit.inventory.verifiedAt}\nExported by: ${context.actor.displayName ?? context.actor.id} (${context.actor.id})\nPolicy result: ${audit.inventory.policyResult}` },
    { text: 'This PDF preserves the frozen review documents and a complete human-readable record of challenged topics, comments, responses, decisions, suggested edits, and review stances. It can be read offline. The detached JSON inventory remains the machine-verifiable exact-byte record.', margin: [0, 15, 0, 8] },
    { text: 'Identities are self-asserted. This archive covers the exact locally observed event set at the verification cutoff, not events still disconnected or in transit.', italics: true, margin: [0, 0, 0, 15] },
    { text: 'Archive sections', fontSize: 16, bold: true, color: '#2458a6', margin: [0, 10, 0, 5] },
    { ol: ['Review challenge register', 'Frozen review documents and per-document challenge maps', 'Review comments, responses and challenged topics', 'Review stances and outcome', 'Audit appendix and exact file inventory'], margin: [0, 0, 0, 12] },
    { text: 'Review challenge register', fontSize: 18, bold: true, color: '#2458a6', margin: [0, 12, 0, 6] },
    { text: `${findingIndex.length} challenged topic(s): ${state.threads.filter(item => item.open).length} open comment finding(s), ${state.threads.filter(item => !item.open).length} resolved comment finding(s), and ${state.suggestions.filter(item => item.open).length} unfinished suggested edit(s).`, margin: [0, 0, 0, 8] }
  ];
  if (findingIndex.length) content.push({
    table: { headerRows: 1, widths: [48, 72, 92, '*'], body: [
      [{ text: 'Item', bold: true }, { text: 'Status', bold: true }, { text: 'Location', bold: true }, { text: 'Challenged topic', bold: true }],
      ...findingIndex.map(finding => [
        { text: finding.reference, bold: true, color: '#2458a6', linkToDestination: finding.detailDestination },
        finding.status.toUpperCase(), `${finding.document}:${finding.line}:${finding.character}`, compactQuote(finding.quote)
      ])
    ] }, layout: 'lightHorizontalLines', margin: [0, 0, 0, 12]
  });
  else content.push({ text: 'No comments or suggested edits were recorded for this revision.', italics: true, margin: [0, 0, 0, 12] });
  const diagrams: AuditInventory['renderedDiagrams'] = [];
  for (const diagnostic of audit.diagnostics) content.push({ text: `Notice: ${diagnostic.path ?? ''} ${diagnostic.message}`, fontSize: 9, margin: [0, 8, 0, 0] });
  const diagramBytes: ExportPlan['diagrams'] = [];
  const frozenSources = new Map(audit.revision.documents.map(d => [d.path, decode(audit.bytes.get(d.blobPath)!)]));
  const presentation = await loadSlidev(audit.manifest, audit.revision, frozenSources, async c => audit.bytes.get(c.blobPath)!);
  if (presentation) {
    content.push({ text: `Slidev presentation - ${presentation.slides.length} frozen slides - renderer ${presentation.rendererVersion} - notes ${presentation.notes}`, bold: true, margin: [0, 15, 0, 5] });
    for (const limitation of presentation.limitations) content.push({ text: limitation, fontSize: 9, margin: [0, 4, 0, 0] });
    for (const slide of presentation.slides) {
      const resource = audit.revision.resources.find(r => r.id === slide.previewResourceId)!;
      const slideFindings = findingIndex.filter(finding => { const target = rootFor(finding).anchor.target; return target?.kind === 'image' && target.resourceId === slide.previewResourceId; });
      content.push({ text: `Slide ${slide.number} - ${slide.title}`, pageBreak: 'before', fontSize: 20, bold: true },
        { image: `data:image/png;base64,${toBase64(audit.bytes.get(resource.blobPath)!)}`, fit: [475, 500], margin: [0, 14, 0, 10] },
        { text: `${slide.id}\nSource: ${slide.document} - UTF-16 offsets ${slide.range.start}-${slide.range.end}\nFrozen image: ${resource.digest}`, fontSize: 8 });
      if (slideFindings.length) content.push({ text: [{ text: 'Review items on this slide: ', bold: true }, ...slideFindings.flatMap((finding, index) => [...(index ? [{ text: ', ' }] : []), { text: finding.reference, color: '#2458a6', linkToDestination: finding.detailDestination }])], margin: [0, 8, 0, 0] });
      if (presentation.notes === 'included' && slide.noteRange) content.push({ text: 'Speaker notes', bold: true, margin: [0, 10, 0, 5] }, { text: frozenSources.get(slide.document)!.slice(slide.noteRange.start, slide.noteRange.end), fontSize: 10 });
    }
  }
  for (const doc of orderedDocuments) {
    const host = document.createElement('article'); host.innerHTML = renderDocument(decode(audit.bytes.get(doc.blobPath)!), doc.path, audit.revision).html;
    const svgs = await populateAssets(host, audit.revision, async c => { const bytes = audit.bytes.get(c.blobPath); if (!bytes) throw new Error('Frozen export input is missing.'); return bytes; });
    const documentFindings = findingIndex.filter(finding => finding.document === doc.path);
    content.push({ text: presentation ? `Frozen source: ${doc.path}` : doc.path, id: `document-${doc.digest.slice(7, 23)}`, pageBreak: 'before', fontSize: 20, bold: true, color: '#2458a6' }, { text: doc.digest, fontSize: 7, margin: [0, 5, 0, 10] });
    content.push({ text: 'Challenge map for this document', fontSize: 13, bold: true, margin: [0, 7, 0, 5] });
    if (documentFindings.length) content.push({
      table: { headerRows: 1, widths: [48, 68, 62, '*'], body: [
        [{ text: 'Item', bold: true }, { text: 'Status', bold: true }, { text: 'Line', bold: true }, { text: 'Challenged text or object', bold: true }],
        ...documentFindings.map(finding => [
          { text: finding.reference, id: finding.markerDestination, bold: true, color: '#2458a6', linkToDestination: finding.detailDestination },
          finding.status.toUpperCase(), `${finding.line}:${finding.character}`, compactQuote(finding.quote)
        ])
      ] }, layout: 'lightHorizontalLines', margin: [0, 0, 0, 12]
    });
    else content.push({ text: 'No challenged topics were recorded in this document.', italics: true, margin: [0, 0, 0, 12] });
    content.push(...(presentation ? [{ text: frozenSources.get(doc.path), fontSize: 8 }] : await pdfNodes(host)));
    for (const resource of audit.revision.resources.filter(r => r.document === doc.path)) content.push({ text: `${resource.role}: ${resource.originalReference}\n${resource.digest} (${resource.byteLength} bytes; ${resource.mediaType})`, fontSize: 8, margin: [0, 5, 0, 0] });
    for (const reference of audit.revision.externalReferences.filter(r => r.document === doc.path)) content.push({ text: `External live reference - not captured for offline use: ${reference.uri}`, fontSize: 8, margin: [0, 5, 0, 0] });
    for (const [diagramId, svg] of svgs) {
      const bytes = encode(sanitizeSvg(svg)), file = blobEvidence(bytes, 'image/svg+xml');
      diagrams.push({ diagramId, sourceDigest: audit.revision.mermaidDiagrams.find(d => d.id === diagramId)!.sourceDigest, svg: file });
      diagramBytes.push({ path: file.path, base64: toBase64(bytes) });
    }
  }
  content.push({ text: 'Review comments, responses and challenged topics', id: 'review-findings', pageBreak: 'before', fontSize: 20, bold: true, color: '#2458a6' });
  content.push({ text: 'Every comment finding and suggested edit is recorded here once with its frozen location, exact challenged text, complete response history, and current outcome. Use the item links to move between this section and each document challenge map.', margin: [0, 5, 0, 12] });
  if (!findingIndex.length) content.push({ text: 'No challenged topics were recorded for this revision.', italics: true });
  for (const finding of findingIndex) {
    const backLink: PdfNode = { text: 'Back to document challenge map', color: '#2458a6', linkToDestination: finding.markerDestination, fontSize: 8, margin: [0, 2, 0, 8] };
    content.push({ text: `${finding.reference} - ${finding.kind === 'comment' ? 'Comment finding' : 'Suggested edit'} - ${finding.status.toUpperCase()}`, id: finding.detailDestination, fontSize: 15, bold: true, color: '#2458a6', margin: [0, 16, 0, 2] }, backLink,
      { text: `Location: ${finding.document}:${finding.line}:${finding.character}\nRoot event: ${finding.eventId}`, fontSize: 8, color: '#526477' },
      { text: 'Challenged text or object', bold: true, margin: [0, 8, 0, 3] }, { text: finding.quote, italics: true, background: '#f2f4f8', margin: [0, 0, 0, 7] });
    if (finding.kind === 'comment') {
      const thread = threads.get(finding.subjectId)!;
      content.push({ text: `Initial comment - ${actorLabel(thread.root)} - ${thread.root.occurredAt}`, bold: true, margin: [0, 5, 0, 3] }, { text: thread.root.body.text, margin: [0, 0, 0, 8] });
      const replies = [...thread.replies].filter((event): event is Extract<Event, { type: 'comment.replied' }> => event.type === 'comment.replied').sort(eventOrder);
      content.push({ text: `Responses (${replies.length})`, bold: true, margin: [0, 5, 0, 3] });
      if (!replies.length) content.push({ text: 'No responses.', italics: true, margin: [10, 0, 0, 5] });
      for (const reply of replies) content.push({ text: `${actorLabel(reply)} - ${reply.occurredAt}`, fontSize: 8, color: '#526477', margin: [10, 5, 0, 1] }, { text: reply.body.text, margin: [10, 0, 0, 4] });
      const transitions = [...thread.decision.history, ...thread.status.history].sort(eventOrder);
      content.push({ text: `Decision and lifecycle history (${transitions.length})`, bold: true, margin: [0, 7, 0, 3] });
      if (!transitions.length) content.push({ text: 'No decision or lifecycle transition.', italics: true, margin: [10, 0, 0, 5] });
      for (const transition of transitions) {
        const action = transition.type === 'thread.decided' ? `decision: ${transition.decision}` : transition.type === 'thread.resolved' ? 'thread closed' : 'thread reopened';
        const explanation = 'reason' in transition && transition.reason ? transition.reason : 'note' in transition && transition.note ? transition.note : '';
        content.push({ text: `${actorLabel(transition)} - ${transition.occurredAt} - ${action}${explanation ? ` - ${explanation}` : ''}`, fontSize: 9, margin: [10, 3, 0, 1] });
      }
    } else {
      const suggestion = suggestions.get(finding.subjectId)!, operation = suggestion.root.operation;
      content.push({ text: `Proposal - ${actorLabel(suggestion.root)} - ${suggestion.root.occurredAt}`, bold: true, margin: [0, 5, 0, 3] }, { text: suggestion.root.rationale.text, margin: [0, 0, 0, 7] }, { text: 'Proposed change', bold: true, margin: [0, 4, 0, 3] });
      if (operation.kind !== 'insert') content.push({ text: operation.kind === 'delete' ? `Delete: ${finding.quote}` : `Replace: ${finding.quote}`, decoration: 'lineThrough', color: '#8b2f24' });
      if (operation.kind !== 'delete') content.push({ text: `${operation.kind === 'insert' ? `Insert ${operation.position}` : 'With'}: ${operation.replacement}`, color: '#146b35' });
      const transitions = [...suggestion.decision.history, ...suggestion.applications].sort(eventOrder);
      content.push({ text: `Suggestion history (${transitions.length})`, bold: true, margin: [0, 7, 0, 3] });
      if (!transitions.length) content.push({ text: 'No acceptance, rejection, or application event.', italics: true, margin: [10, 0, 0, 5] });
      for (const transition of transitions) {
        const action = transition.type === 'suggestion.accepted' ? 'accepted' : transition.type === 'suggestion.rejected' ? 'rejected' : transition.type === 'suggestion.applied' ? `applied (${transition.sourceDigestBefore} -> ${transition.sourceDigestAfter})` : transition.type;
        const explanation = 'reason' in transition && transition.reason ? transition.reason : 'note' in transition && transition.note ? transition.note : '';
        content.push({ text: `${actorLabel(transition)} - ${transition.occurredAt} - ${action}${explanation ? ` - ${explanation}` : ''}`, fontSize: 9, margin: [10, 3, 0, 1] });
      }
    }
  }
  content.push({ text: 'Review stances and outcome', pageBreak: 'before', fontSize: 20, bold: true, color: '#2458a6' }, { text: `Policy result at verification cutoff: ${audit.inventory.policyResult}`, bold: true, margin: [0, 6, 0, 10] });
  if (!state.stances.length) content.push({ text: 'No participant approval or rejection assertions were recorded.', italics: true });
  for (const stance of [...state.stances].sort((a, b) => ascii(a.actor, b.actor))) {
    const history = [...stance.history].sort(eventOrder), current = stance.conflict ? 'conflicted' : stance.heads.map(event => event.type.replace('review.', '')).join(' / ');
    content.push({ text: `${history[0]?.actor.displayName ?? stance.actor} (${stance.actor}) - current status: ${current}`, bold: true, margin: [0, 10, 0, 3] });
    for (const transition of history) {
      const explanation = 'reason' in transition && transition.reason ? transition.reason : 'note' in transition && transition.note ? transition.note : '';
      content.push({ text: `${transition.occurredAt} - ${transition.type.replace('review.', '')}${explanation ? ` - ${explanation}` : ''}`, fontSize: 9, margin: [10, 2, 0, 1] });
    }
  }
  content.push({ text: 'Audit appendix and exact file inventory', pageBreak: 'before', fontSize: 18, bold: true, color: '#2458a6' });
  const eventInputs = new Map(audit.inventory.events.map(event => [event.eventId, event]));
  for (const event of audit.events) {
    const input = eventInputs.get(event.id)!;
    if (event.revisionId === audit.revision.id) {
      content.push({ text: `${event.type} - ${event.actor.displayName ?? event.actor.id} (${event.actor.id})\n${event.occurredAt}`, bold: true, margin: [0, 10, 0, 4] });
      const { schemaVersion, id, actor, occurredAt, reviewId, revisionId, revisionDigest, operationId: op, ...payload } = event;
      content.push({ text: JSON.stringify(payload, null, 2), fontSize: 8 });
    }
    content.push({ text: `${input.path}\n${input.digest} (${input.byteLength} bytes)`, fontSize: 7, margin: [0, 3, 0, 0] });
  }
  const pdfBytes = new Uint8Array(await pdfMake.createPdf({
    info: { title: `${audit.manifest.title} - Offline review archive`, subject: `Open Markdown Review ${audit.manifest.reviewId}, revision ${audit.revision.id}`, author: context.actor.displayName ?? context.actor.id, keywords: 'Markdown review archive, comments, responses, challenged topics, audit' },
    content, defaultStyle: { font: 'Roboto', fontSize: 10 }, pageSize: 'A4', pageMargins: [45, 45, 45, 45],
    footer: (page: number, total: number) => ({ text: `${audit.manifest.title} - ${page} / ${total}`, alignment: 'center', fontSize: 8 })
  }).getBuffer());
  if (pdfBytes.length > LIMITS.pdf) throw new Error('PDF exceeds the protocol limit.');
  const pdf = evidence(`exports/${digest(pdfBytes).slice(7)}.pdf`, pdfBytes, 'application/pdf');
  const inventory = validate('inventory', { ...audit.inventory, kind: 'audit-export-inventory', exportId, pdf, representedEventIds: audit.events.filter(e => e.revisionId === audit.revision.id).map(e => e.id), renderedDiagrams: diagrams.sort((a, b) => ascii(a.diagramId, b.diagramId)), diagnostics: audit.diagnostics, renderer });
  const inventoryBytes = jsonBytes(inventory), file = evidence(`exports/${digest(inventoryBytes).slice(7)}.inventory.json`, inventoryBytes, 'application/json');
  const event = session.makeEvent(context, { type: 'export.created', exportId, format: 'application/pdf', pdf, inventory: file, renderer }, operationId);
  const plan: ExportPlan = { reviewId: audit.manifest.reviewId, revisionId: audit.revision.id, actorId: context.actor.id, pdfBase64: toBase64(pdfBytes), inventory, event, diagrams: diagramBytes };
  await session.storage.journalPut(`export-plan:${operationId}`, { path: file.path, bytes: Array.from(jsonBytes(plan)), acknowledged: false });
  return publishExportPlan(context, plan, operationId);
}
