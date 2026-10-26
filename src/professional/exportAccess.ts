import { contained, NativeStorage } from './nativeStorage';
import { ReviewSession } from './session';
import { ProtocolError } from './types';
import { documentExportPlan, DOCUMENT_EXPORT_ID_PREFIX } from './documentExportPlan';

/** The webview supplies an admitted event ID or a private clean-export operation, never a native path. */
export async function verifiedExportFile(storage: NativeStorage, eventId: string): Promise<string> {
  if (typeof eventId !== 'string' || !eventId || eventId.length > 128) throw new ProtocolError('invalid', 'Choose an archived PDF export.');
  const session = new ReviewSession(storage); await session.open();
  if (eventId.startsWith(DOCUMENT_EXPORT_ID_PREFIX)) {
    const operationId = eventId.slice(DOCUMENT_EXPORT_ID_PREFIX.length);
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(operationId)) throw new ProtocolError('invalid', 'Invalid clean PDF export operation.');
    const saved = await storage.journalGet(`document-export-plan:${operationId}`);
    if (!saved) throw new ProtocolError('missing', 'This clean PDF has no private export record on this client.');
    const plan = documentExportPlan(new Uint8Array(saved.bytes), { reviewId: session.manifest.reviewId }, operationId);
    if (!session.revisions.has(plan.revisionId)) throw new ProtocolError('invalid', 'The clean PDF refers to an unknown revision.');
    await session.content({ ...plan.pdf, blobPath: plan.pdf.path }, true);
    return contained(storage.root, plan.pdf.path);
  }
  const event = session.events.find(e => e.id === eventId && e.type === 'export.created');
  if (event?.type !== 'export.created') throw new ProtocolError('invalid', 'This review has no verified PDF export with that event ID.');
  if (!/^exports\/[a-f0-9]{64}\.pdf$/.test(event.pdf.path)) throw new ProtocolError('invalid', 'Invalid PDF export location.');
  await session.content({ ...event.pdf, blobPath: event.pdf.path }, true);
  return contained(storage.root, event.pdf.path);
}
