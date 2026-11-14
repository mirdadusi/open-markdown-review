import { ActionContext } from './session';
import { LIMITS, ProtocolError } from './types';
import { decode, digest, fromBase64, jsonBytes, toBase64 } from './bytes';
import { documentOrder, DOCUMENT_ORDER_PROFILE } from './documentOrder';
import { evidence, publish } from './storage';
import { renderDocument } from './rendering';
import { populateAssets } from './assets';
import { documentDestination, pdfNavigation, pdfNodes, PDF_LANDSCAPE_WIDTH, PDF_PORTRAIT_WIDTH } from './pdfLayout';
import { PdfNode, preparePdfTypography } from './pdfTypography';
import { renderPdfDocument } from './pdfDocument';
import { loadSlidev } from './profiles/slidev';
import { OperationControl, checkpoint } from './operation';

import { documentExportPlan, DocumentExportPlan, DocumentExportResult } from './documentExportPlan';
import { PdfTemplateOptions, selectPdfTemplate, assertPdfTemplateRecovery } from './pdfTemplate';
import { applyPdfTemplate, templateWidth } from './pdfTemplateLayout';
import { pdfDocumentList, assertPdfDocumentListRecovery, PDF_DOCUMENT_LIST_PROFILE, pdfOrientation, pdfOrientationToken, assertPdfOrientationRecovery } from './pdfProfiles';

/** Document projection only: no review event/inventory is asserted or embedded in the PDF. */
export async function exportDocument(context: ActionContext, operationId: string, control?: OperationControl, options: PdfTemplateOptions = {}): Promise<DocumentExportResult> {
  const template = selectPdfTemplate(options), includeDocumentList = pdfDocumentList(options, 'clean');
  const orientation = pdfOrientation(options.orientation);
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(operationId)) throw new ProtocolError('invalid', 'Invalid clean PDF export operation.');
  const { session } = context, key = `document-export-plan:${operationId}`;
  checkpoint(control, 'Checking for a resumable clean document export…');
  const previous = await session.storage.journalGet(key);
  let plan: DocumentExportPlan;
  if (previous) { plan = documentExportPlan(new Uint8Array(previous.bytes), { reviewId: session.manifest.reviewId, revisionId: context.revision.id, actorId: context.actor.id }, operationId); assertPdfTemplateRecovery(plan.templateDigest, template); assertPdfDocumentListRecovery(plan.includeDocumentList, includeDocumentList, 'clean'); assertPdfOrientationRecovery(plan.orientation, orientation); }
  else {
    const audit = await session.audit(context, control);
    const root = audit.revision.documents.find(d => d.path === audit.revision.rootDocument)!;
    const order = documentOrder(audit.revision.documents.map(d => d.path), audit.revision.rootDocument, decode(audit.bytes.get(root.blobPath)!));
    const documentsByPath = new Map(audit.revision.documents.map(d => [d.path, d]));
    const documents = order.map(path => documentsByPath.get(path)!);
    const rendered = documents.map(doc => { const host = document.createElement('article'); host.innerHTML = renderDocument(decode(audit.bytes.get(doc.blobPath)!), doc.path, audit.revision).html; return { path: doc.path, host }; });
    const navigation = pdfNavigation(rendered, orientation), sources = new Map(documents.map(d => [d.path, decode(audit.bytes.get(d.blobPath)!)]));
    const presentation = await loadSlidev(audit.manifest, audit.revision, sources, async c => audit.bytes.get(c.blobPath)!);
    const content: PdfNode[] = [], title = navigation.documents.get(audit.revision.rootDocument)!.title;
    if (includeDocumentList) {
      const entries = presentation ? presentation.slides.map(slide => ({ title: slide.title, destination: `clean-slide-${slide.number}` }))
        : documents.map(doc => ({ title: navigation.documents.get(doc.path)!.title, destination: documentDestination(doc.path) }));
      content.push({ text: 'Contents', fontSize: 20, bold: true, color: '#2458a6', margin: [0, 0, 0, 14] });
      for (const entry of entries) content.push({ columns: [
        { text: entry.title, linkToDestination: entry.destination, color: '#2458a6', decoration: 'underline' },
        { text: [{ pageReference: entry.destination }], width: 35, alignment: 'right' }
      ], margin: [0, 0, 0, 8] });
    }
    if (presentation) {
      for (const slide of presentation.slides) {
        const image = audit.revision.resources.find(r => r.id === slide.previewResourceId)!;
        content.push({ text: slide.title, ...(includeDocumentList ? { id: `clean-slide-${slide.number}` } : {}), fontSize: 18, bold: true, ...(content.length ? { pageBreak: 'before' } : {}) },
          { image: `data:image/png;base64,${toBase64(audit.bytes.get(image.blobPath)!)}`, fit: [PDF_PORTRAIT_WIDTH, 600], margin: [0, 12, 0, 8] });
        if (presentation.notes === 'included' && slide.noteRange) content.push({ text: sources.get(slide.document)!.slice(slide.noteRange.start, slide.noteRange.end) });
      }
    } else for (const doc of documents) {
      checkpoint(control, `Rendering ${doc.path} without review information…`);
      const layout = navigation.documents.get(doc.path)!;
      await populateAssets(layout.host, audit.revision, async c => { const bytes = audit.bytes.get(c.blobPath); if (!bytes) throw new Error('Frozen document input is missing.'); return bytes; }, control);
      content.push({ text: '\u200b', id: documentDestination(doc.path), fontSize: 0.1,
        pageOrientation: layout.landscape ? 'landscape' : 'portrait', ...(content.length ? { pageBreak: 'before' } : {}) });
      content.push(...await pdfNodes(layout.host, { document: doc.path, navigation, width: template ? templateWidth(template, layout.landscape) : layout.landscape ? PDF_LANDSCAPE_WIDTH : PDF_PORTRAIT_WIDTH, clean: true, control, ...(template ? { templateStyle: template.style, fontSize: template.style.bodySize } : {}) }));
    }
    const bytes = await renderPdfDocument(await applyPdfTemplate({ info: { title, keywords: `Markdown document; ${DOCUMENT_ORDER_PROFILE}; ${PDF_DOCUMENT_LIST_PROFILE}${includeDocumentList ? 'included' : 'omitted'}${pdfOrientationToken(orientation)}` }, content,
      defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.12, color: '#172b42' }, pageSize: 'A4', pageMargins: [45, 45, 45, 60],
      footer: (page: number, total: number) => { const node = { text: `${page} / ${total}`, alignment: 'center', fontSize: 8, margin: [45, 18, 45, 0] }; preparePdfTypography(node); return node; }
    }, template, title, control), [], control);
    checkpoint(control);
    if (bytes.length > LIMITS.pdf) throw new ProtocolError('unsupported', 'PDF exceeds the size limit.');
    plan = { kind: 'omr-document-export/1', reviewId: audit.manifest.reviewId, revisionId: audit.revision.id, actorId: context.actor.id, operationId, includeDocumentList, ...(orientation === 'portrait' ? { orientation } : {}), ...(template ? { templateDigest: template.digest } : {}),
      pdf: evidence(`exports/${digest(bytes).slice(7)}.pdf`, bytes, 'application/pdf'), pdfBase64: toBase64(bytes) };
    await session.storage.journalPut(key, { path: plan.pdf.path, bytes: Array.from(jsonBytes(plan)), acknowledged: false });
  }
  const bytes = fromBase64(plan.pdfBase64);
  if (bytes.length !== plan.pdf.byteLength || digest(bytes) !== plan.pdf.digest) throw new ProtocolError('integrity', 'Clean PDF recovery bytes changed.');
  checkpoint(control, 'Saving the clean PDF…');
  // Complete an already-started immutable publication even if cancellation arrives now.
  await publish(session.storage, `${operationId}_document_pdf`, plan.pdf, bytes);
  return { profile: 'clean', operationId, pdfPath: plan.pdf.path, pdf: plan.pdf };
}
