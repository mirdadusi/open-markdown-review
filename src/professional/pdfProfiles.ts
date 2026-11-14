import { ProtocolError } from './types';
export type PdfExportMode = 'review' | 'clean';
export type PdfOrientation = 'auto' | 'portrait';
export const PDF_ORIENTATION_PROFILE = 'omr-pdf-orientation-v1=';
export function pdfOrientation(value: unknown = 'auto'): PdfOrientation {
  if (value !== 'auto' && value !== 'portrait') throw new ProtocolError('invalid', 'PDF orientation must be auto or portrait.');
  return value;
}
export function assertPdfOrientationRecovery(recorded: unknown, requested: PdfOrientation): void {
  if (pdfOrientation(recorded) !== requested) throw new ProtocolError('invalid', 'PDF recovery belongs to a different page orientation. Resume the original options or start a new export.');
}
export function pdfOrientationFromRenderer(engine: string): PdfOrientation {
  const values = engine.split(';').map(value => value.trim()).filter(value => value.startsWith(PDF_ORIENTATION_PROFILE));
  if (!values.length) return 'auto';
  if (values.length !== 1) throw new ProtocolError('invalid', 'Invalid PDF orientation presentation profile.');
  return pdfOrientation(values[0].slice(PDF_ORIENTATION_PROFILE.length));
}
export function pdfOrientationToken(orientation: PdfOrientation): string {
  return orientation === 'portrait' ? `; ${PDF_ORIENTATION_PROFILE}portrait` : '';
}
export const REVIEW_PDF_PROFILE = 'omr-review-annotations-v3';
export const CLEAN_PDF_PROFILE = 'omr-document-only-v1';
export const PDF_DOCUMENT_LIST_PROFILE = 'omr-document-list-v1=';
/** Listing is presentation only; every frozen document is always exported. */
export function pdfDocumentList(options: { includeDocumentList?: boolean } = {}, mode: PdfExportMode = 'review'): boolean {
  if (options.includeDocumentList !== undefined && typeof options.includeDocumentList !== 'boolean') throw new ProtocolError('invalid', 'Include document list must be true or false.');
  return options.includeDocumentList ?? mode === 'review';
}
export function assertPdfDocumentListRecovery(recorded: unknown, requested: boolean, mode: PdfExportMode) {
  if (recorded !== undefined && typeof recorded !== 'boolean' || (recorded ?? mode === 'review') !== requested) throw new ProtocolError('invalid', 'PDF recovery belongs to a different document-list setting. Resume the original options or start a new export.');
}
/** Older review archives always included their document list. */
export function pdfDocumentListFromRenderer(engine: string): boolean {
  const values = engine.split(';').map(value => value.trim()).filter(value => value.startsWith(PDF_DOCUMENT_LIST_PROFILE));
  if (!values.length) return true;
  if (values.length !== 1 || !/^omr-document-list-v1=(included|omitted)$/.test(values[0])) throw new ProtocolError('invalid', 'Invalid PDF document-list presentation profile.');
  return values[0] === PDF_DOCUMENT_LIST_PROFILE + 'included';
}
export function pdfExportMode(value: unknown = 'review'): PdfExportMode {
  if (value !== 'review' && value !== 'clean') throw new ProtocolError('invalid', 'PDF export mode must be review or clean.');
  return value;
}
export function reviewerStatusStyle(status: string): { color?: string; fillColor?: string } {
  if (status === 'in-progress' || status === 'reopened') return { color: '#9a3412', fillColor: '#ffedd5' };
  if (status === 'finished') return { color: '#166534', fillColor: '#dcfce7' };
  return {};
}
