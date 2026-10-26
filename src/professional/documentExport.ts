import { ActionContext } from './session';
import { LIMITS, ProtocolError } from './types';
import { ascii, decode, digest, fromBase64, jsonBytes, toBase64 } from './bytes';
import { evidence, publish } from './storage';
import { renderDocument } from './rendering';
import { populateAssets } from './assets';
import { documentDestination, pdfNavigation, pdfNodes, PDF_LANDSCAPE_WIDTH, PDF_PORTRAIT_WIDTH } from './pdfLayout';
import { PdfNode, preparePdfTypography } from './pdfTypography';
import { renderPdfDocument } from './pdfDocument';
import { loadSlidev } from './profiles/slidev';
import { OperationControl, checkpoint } from './operation';

import { documentExportPlan, DocumentExportPlan, DocumentExportResult } from './documentExportPlan';

/** Document projection only: no review event/inventory is asserted or embedded in the PDF. */
export async function exportDocument(context: ActionContext, operationId: string, control?: OperationControl): Promise<DocumentExportResult> {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(operationId)) throw new ProtocolError('invalid', 'Invalid clean PDF export operation.');
  const { session } = context, key = `document-export-plan:${operationId}`;
  checkpoint(control, 'Checking for a resumable clean document export…');
  const previous = await session.storage.journalGet(key);
  let plan: DocumentExportPlan;
  if (previous) plan = documentExportPlan(new Uint8Array(previous.bytes), { reviewId: session.manifest.reviewId, revisionId: context.revision.id, actorId: context.actor.id }, operationId);
  else {
    const audit = await session.audit(context, control);
    const documents = [...audit.revision.documents].sort((a, b) => a.path === audit.revision.rootDocument ? -1 : b.path === audit.revision.rootDocument ? 1 : ascii(a.path, b.path));
    const rendered = documents.map(doc => { const host = document.createElement('article'); host.innerHTML = renderDocument(decode(audit.bytes.get(doc.blobPath)!), doc.path, audit.revision).html; return { path: doc.path, host }; });
    const navigation = pdfNavigation(rendered), sources = new Map(documents.map(d => [d.path, decode(audit.bytes.get(d.blobPath)!)]));
    const presentation = await loadSlidev(audit.manifest, audit.revision, sources, async c => audit.bytes.get(c.blobPath)!);
    const content: PdfNode[] = [], title = navigation.documents.get(audit.revision.rootDocument)!.title;
    if (presentation) {
      for (const slide of presentation.slides) {
        const image = audit.revision.resources.find(r => r.id === slide.previewResourceId)!;
        content.push({ text: slide.title, fontSize: 18, bold: true, ...(content.length ? { pageBreak: 'before' } : {}) },
          { image: `data:image/png;base64,${toBase64(audit.bytes.get(image.blobPath)!)}`, fit: [PDF_PORTRAIT_WIDTH, 600], margin: [0, 12, 0, 8] });
        if (presentation.notes === 'included' && slide.noteRange) content.push({ text: sources.get(slide.document)!.slice(slide.noteRange.start, slide.noteRange.end) });
      }
    } else for (const doc of documents) {
      checkpoint(control, `Rendering ${doc.path} without review information…`);
      const layout = navigation.documents.get(doc.path)!;
      await populateAssets(layout.host, audit.revision, async c => { const bytes = audit.bytes.get(c.blobPath); if (!bytes) throw new Error('Frozen document input is missing.'); return bytes; }, control);
      content.push({ text: '\u200b', id: documentDestination(doc.path), fontSize: 0.1,
        pageOrientation: layout.landscape ? 'landscape' : 'portrait', ...(content.length ? { pageBreak: 'before' } : {}) });
      content.push(...await pdfNodes(layout.host, { document: doc.path, navigation, width: layout.landscape ? PDF_LANDSCAPE_WIDTH : PDF_PORTRAIT_WIDTH, clean: true, control }));
    }
    const bytes = await renderPdfDocument({ info: { title, keywords: 'Markdown document' }, content,
      defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.12, color: '#172b42' }, pageSize: 'A4', pageMargins: [45, 45, 45, 60],
      footer: (page: number, total: number) => { const node = { text: `${page} / ${total}`, alignment: 'center', fontSize: 8, margin: [45, 18, 45, 0] }; preparePdfTypography(node); return node; }
    }, [], control);
    checkpoint(control);
    if (bytes.length > LIMITS.pdf) throw new ProtocolError('unsupported', 'PDF exceeds the size limit.');
    plan = { kind: 'omr-document-export/1', reviewId: audit.manifest.reviewId, revisionId: audit.revision.id, actorId: context.actor.id, operationId,
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
