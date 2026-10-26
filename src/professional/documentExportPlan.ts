import { FileEvidence, LIMITS, ProtocolError } from './types';
import { parseJson } from './bytes';

export const DOCUMENT_EXPORT_ID_PREFIX = 'document-export:';
export interface DocumentExportPlan {
  kind: 'omr-document-export/1'; reviewId: string; revisionId: string; actorId: string;
  operationId: string; pdf: FileEvidence; pdfBase64: string;
}
export interface DocumentExportResult { profile: 'clean'; operationId: string; pdfPath: string; pdf: FileEvidence; inventoryPath?: undefined; event?: undefined }
export function documentExportPlan(bytes: Uint8Array, context: { reviewId: string; revisionId?: string; actorId?: string }, operationId: string): DocumentExportPlan {
  const plan = parseJson<DocumentExportPlan>(bytes, LIMITS.pdf * 2);
  if (plan.kind !== 'omr-document-export/1' || plan.reviewId !== context.reviewId || plan.operationId !== operationId
    || typeof plan.revisionId !== 'string' || !plan.revisionId || typeof plan.actorId !== 'string' || !plan.actorId || typeof plan.pdfBase64 !== 'string'
    || context.revisionId && plan.revisionId !== context.revisionId || context.actorId && plan.actorId !== context.actorId
    || !/^exports\/[a-f0-9]{64}\.pdf$/.test(plan.pdf?.path) || plan.pdf?.mediaType !== 'application/pdf'
    || !/^sha256:[a-f0-9]{64}$/.test(plan.pdf.digest) || plan.pdf.path !== `exports/${plan.pdf.digest.slice(7)}.pdf`
    || !Number.isSafeInteger(plan.pdf.byteLength) || plan.pdf.byteLength < 1 || plan.pdf.byteLength > LIMITS.pdf) {
    throw new ProtocolError('invalid', 'The clean PDF recovery record does not match this review, operation or PDF.');
  }
  return plan;
}
