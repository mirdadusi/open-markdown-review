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

pdfMake.addVirtualFileSystem(fonts);
type PdfNode = Record<string, unknown>;
function inlineNodes(root: Node, style: PdfNode = {}): PdfNode[] {
  if (root.nodeType === Node.TEXT_NODE) return [{ text: root.textContent ?? '', ...style }];
  if (!(root instanceof Element)) return [];
  const tag = root.localName;
  const next: PdfNode = { ...style, ...(['strong', 'b'].includes(tag) ? { bold: true } : {}), ...(['em', 'i'].includes(tag) ? { italics: true } : {}), ...(['s', 'del'].includes(tag) ? { decoration: 'lineThrough' } : {}) };
  if (tag === 'a' && /^https?:/.test(root.getAttribute('href') ?? '')) next.link = root.getAttribute('href');
  if (tag === 'br') return [{ text: '\n' }];
  return [...root.childNodes].flatMap(n => inlineNodes(n, next));
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
    const rows = [...element.querySelectorAll('tr')]; const body: PdfNode[][] = [];
    for (const row of rows) { const cells: PdfNode[] = []; for (const cell of row.children) cells.push({ stack: await pdfNodes(cell), fillColor: cell.localName === 'th' ? '#e5ecf6' : '#ffffff', bold: cell.localName === 'th' }); body.push(cells); }
    return [{ table: { headerRows: 1, widths: Array.from({ length: body[0]?.length ?? 1 }, () => '*'), body }, layout: 'lightHorizontalLines', margin: [0, 8, 0, 8] }];
  }
  const children = (await Promise.all([...element.childNodes].map(pdfNodes))).flat();
  if (!children.length) return [];
  if (/^h[1-6]$/.test(tag)) return [{ text: element.textContent, fontSize: 22 - Number(tag[1]) * 2, bold: true, margin: [0, 14, 0, 6] }];
  if (['p', 'figcaption', 'td', 'th', 'li'].includes(tag) && !element.querySelector('img,svg,table,ul,ol,p')) return [{ text: inlineNodes(element), margin: [0, 4, 0, 6] }];
  if (tag === 'p' || tag === 'figcaption') return [{ stack: children, margin: [0, 4, 0, 6] }];
  if (tag === 'pre') return [{ text: element.textContent, fontSize: 8, background: '#f2f4f8', margin: [0, 6, 0, 6] }];
  if (tag === 'ul' || tag === 'ol') return [{ [tag]: children.map(c => c.stack ? c : { stack: [c] }) }];
  if (tag === 'li' || tag === 'td' || tag === 'th') return children;
  if (['strong', 'b', 'em', 'i', 'code', 'del', 's', 'a', 'span'].includes(tag) && !element.querySelector('img,svg,table')) {
    const inline: PdfNode = { text: element.textContent, ...(tag === 'strong' || tag === 'b' ? { bold: true } : {}), ...(tag === 'em' || tag === 'i' ? { italics: true } : {}), ...(tag === 's' || tag === 'del' ? { decoration: 'lineThrough' } : {}) };
    if (tag === 'a' && /^https?:/.test(element.getAttribute('href') ?? '')) inline.link = element.getAttribute('href');
    return [inline];
  }
  return children;
}
export interface ExportResult { pdfPath: string; inventoryPath: string; event: Event }
interface ExportPlan { reviewId: string; revisionId: string; actorId: string; pdf?: number[]; pdfBase64?: string; inventory: AuditInventory; event: Event; diagrams: Array<{ path: string; bytes?: number[]; base64?: string }> }
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
  const renderer: Renderer = { client: 'open-markdown-review-shared', clientVersion: clientPackage.version, markdownVersion: markdownPackage.version, mermaidVersion: mermaidPackage.version, pdfEngine: `pdfmake ${pdfPackage.version}`, fontSetDigest: digest(jsonBytes(fonts)), sanitizerVersion: 'omr-svg-static-1', schemaSetDigest: digest(jsonBytes({ event: eventSchema, manifest: manifestSchema, revision: revisionSchema, policy: policySchema, verification: verificationSchema, inventory: inventorySchema })) };
  const content: PdfNode[] = [
    { text: audit.manifest.title, fontSize: 26, bold: true, color: '#2458a6' },
    { text: 'Auditable review record', fontSize: 16, margin: [0, 10, 0, 20] },
    { text: `Review: ${audit.manifest.reviewId}\nRevision: ${audit.revision.id}\nExport: ${exportId}\nVerified: ${audit.inventory.verifiedAt}\nReviewer: ${context.actor.displayName ?? context.actor.id} (${context.actor.id})\nPolicy: ${audit.inventory.policyResult}` },
    { text: 'Identities are self-asserted. This export covers the exact locally observed event set, not events still disconnected or in transit.', italics: true, margin: [0, 15, 0, 15] }
  ];
  const diagrams: AuditInventory['renderedDiagrams'] = [];
  for (const diagnostic of audit.diagnostics) content.push({ text: `Notice: ${diagnostic.path ?? ''} ${diagnostic.message}`, fontSize: 9, margin: [0, 8, 0, 0] });
  const diagramBytes: ExportPlan['diagrams'] = [];
  const frozenSources = new Map(audit.revision.documents.map(d => [d.path, decode(audit.bytes.get(d.blobPath)!)]));
  const presentation = await loadSlidev(audit.manifest, audit.revision, frozenSources, async c => audit.bytes.get(c.blobPath)!);
  if (presentation) {
    content.push({ text: `Slidev presentation · ${presentation.slides.length} frozen slides · renderer ${presentation.rendererVersion} · notes ${presentation.notes}`, bold: true, margin: [0, 15, 0, 5] });
    for (const limitation of presentation.limitations) content.push({ text: limitation, fontSize: 9, margin: [0, 4, 0, 0] });
    for (const slide of presentation.slides) {
      const resource = audit.revision.resources.find(r => r.id === slide.previewResourceId)!;
      content.push({ text: `Slide ${slide.number} — ${slide.title}`, pageBreak: 'before', fontSize: 20, bold: true },
        { image: `data:image/png;base64,${toBase64(audit.bytes.get(resource.blobPath)!)}`, fit: [475, 500], margin: [0, 14, 0, 10] },
        { text: `${slide.id}\nSource: ${slide.document} · UTF-16 offsets ${slide.range.start}–${slide.range.end}\nFrozen image: ${resource.digest}`, fontSize: 8 });
      if (presentation.notes === 'included' && slide.noteRange) content.push({ text: 'Speaker notes', bold: true, margin: [0, 10, 0, 5] }, { text: frozenSources.get(slide.document)!.slice(slide.noteRange.start, slide.noteRange.end), fontSize: 10 });
      const related = fold(audit.events, audit.revision.id).threads.filter(t => t.root.anchor.target?.kind === 'image' && t.root.anchor.target.resourceId === slide.previewResourceId);
      for (const thread of related) {
        content.push({ text: `${thread.open ? 'OPEN' : 'RESOLVED'} · ${thread.root.actor.id}: ${thread.root.body.text}`, margin: [0, 8, 0, 0] });
        for (const reply of thread.replies) if (reply.type === 'comment.replied') content.push({ text: `${reply.actor.id}: ${reply.body.text}`, margin: [12, 4, 0, 0] });
      }
    }
  }
  const orderedDocuments = [...audit.revision.documents].sort((a, b) => a.path === audit.revision.rootDocument ? -1 : b.path === audit.revision.rootDocument ? 1 : ascii(a.path, b.path));
  for (const doc of orderedDocuments) {
    const host = document.createElement('article'); host.innerHTML = renderDocument(decode(audit.bytes.get(doc.blobPath)!), doc.path, audit.revision).html;
    const svgs = await populateAssets(host, audit.revision, async c => { const bytes = audit.bytes.get(c.blobPath); if (!bytes) throw new Error('Frozen export input is missing.'); return bytes; });
    content.push({ text: presentation ? `Frozen source: ${doc.path}` : doc.path, pageBreak: 'before', fontSize: 20, bold: true }, { text: doc.digest, fontSize: 7, margin: [0, 5, 0, 10] }, ...(presentation ? [{ text: frozenSources.get(doc.path), fontSize: 8 }] : await pdfNodes(host)));
    for (const resource of audit.revision.resources.filter(r => r.document === doc.path)) content.push({ text: `${resource.role}: ${resource.originalReference}\n${resource.digest} (${resource.byteLength} bytes; ${resource.mediaType})`, fontSize: 8, margin: [0, 5, 0, 0] });
    for (const reference of audit.revision.externalReferences.filter(r => r.document === doc.path)) content.push({ text: `External link (not captured): ${reference.uri}`, fontSize: 8, margin: [0, 5, 0, 0] });
    for (const [diagramId, svg] of svgs) {
      const bytes = encode(sanitizeSvg(svg)), file = blobEvidence(bytes, 'image/svg+xml');
      diagrams.push({ diagramId, sourceDigest: audit.revision.mermaidDiagrams.find(d => d.id === diagramId)!.sourceDigest, svg: file });
      diagramBytes.push({ path: file.path, base64: toBase64(bytes) });
    }
  }
  content.push({ text: 'Comments, replies, decisions and suggested edits', pageBreak: 'before', fontSize: 20, bold: true });
  const state = fold(audit.events, audit.revision.id);
  for (const thread of state.threads) {
    content.push({ text: `${thread.root.actor.displayName ?? thread.root.actor.id} (${thread.root.actor.id}) · ${thread.root.occurredAt}`, fontSize: 9, color: '#526477', margin: [0, 10, 0, 0] });
    content.push({ text: `${thread.root.anchor.document}:${thread.root.anchor.range.start.line + 1} — ${thread.open ? 'OPEN' : 'RESOLVED'}`, bold: true, margin: [0, 12, 0, 5] }, { text: thread.root.anchor.quote.exact, italics: true }, { text: thread.root.body.text, margin: [0, 5, 0, 5] });
    for (const reply of thread.replies) if (reply.type === 'comment.replied') content.push({ text: `${reply.actor.displayName ?? reply.actor.id}: ${reply.body.text}`, margin: [12, 3, 0, 3] });
    for (const transition of [...thread.decision.heads, ...thread.status.heads]) content.push({ text: `${transition.actor.displayName ?? transition.actor.id}: ${transition.type === 'thread.decided' ? transition.decision : transition.type.replace('thread.', '')}${'reason' in transition && transition.reason ? ' — ' + transition.reason : 'note' in transition && transition.note ? ' — ' + transition.note : ''}`, fontSize: 9, margin: [0, 5, 0, 0] });
  }
  for (const suggestion of state.suggestions) {
    const operation = suggestion.root.operation;
    content.push({ text: `Suggested ${operation.kind} — ${suggestion.status}`, bold: true, margin: [0, 12, 0, 5] }, { text: suggestion.root.anchor.quote.exact, decoration: operation.kind === 'insert' ? undefined : 'lineThrough' });
    if (operation.kind !== 'delete') content.push({ text: operation.replacement, color: '#146b35' });
    content.push({ text: suggestion.root.rationale.text });
  }
  content.push({ text: 'Complete event history and exact file inventory', pageBreak: 'before', fontSize: 18, bold: true });
  const eventInputs = new Map(audit.inventory.events.map(event => [event.eventId, event]));
  for (const event of audit.events) {
    const input = eventInputs.get(event.id)!;
    if (event.revisionId === audit.revision.id) {
      content.push({ text: `${event.type} — ${event.actor.displayName ?? event.actor.id} (${event.actor.id})\n${event.occurredAt}`, bold: true, margin: [0, 10, 0, 4] });
      const { schemaVersion, id, actor, occurredAt, reviewId, revisionId, revisionDigest, operationId: op, ...payload } = event;
      content.push({ text: JSON.stringify(payload, null, 2), fontSize: 8 });
    }
    content.push({ text: `${input.path}\n${input.digest} (${input.byteLength} bytes)`, fontSize: 7, margin: [0, 3, 0, 0] });
  }
  const pdfBytes = new Uint8Array(await pdfMake.createPdf({ content, defaultStyle: { font: 'Roboto', fontSize: 10 }, pageSize: 'A4', pageMargins: [45, 45, 45, 45], footer: (page: number, total: number) => ({ text: `${audit.manifest.title} · ${page} / ${total}`, alignment: 'center', fontSize: 8 }) }).getBuffer());
  if (pdfBytes.length > LIMITS.pdf) throw new Error('PDF exceeds the protocol limit.');
  const pdf = evidence(`exports/${digest(pdfBytes).slice(7)}.pdf`, pdfBytes, 'application/pdf');
  const inventory = validate('inventory', { ...audit.inventory, kind: 'audit-export-inventory', exportId, pdf, representedEventIds: audit.events.filter(e => e.revisionId === audit.revision.id).map(e => e.id), renderedDiagrams: diagrams.sort((a, b) => ascii(a.diagramId, b.diagramId)), diagnostics: audit.diagnostics, renderer });
  const inventoryBytes = jsonBytes(inventory), file = evidence(`exports/${digest(inventoryBytes).slice(7)}.inventory.json`, inventoryBytes, 'application/json');
  const event = session.makeEvent(context, { type: 'export.created', exportId, format: 'application/pdf', pdf, inventory: file, renderer }, operationId);
  const plan: ExportPlan = { reviewId: audit.manifest.reviewId, revisionId: audit.revision.id, actorId: context.actor.id, pdfBase64: toBase64(pdfBytes), inventory, event, diagrams: diagramBytes };
  await session.storage.journalPut(`export-plan:${operationId}`, { path: file.path, bytes: Array.from(jsonBytes(plan)), acknowledged: false });
  return publishExportPlan(context, plan, operationId);
}
