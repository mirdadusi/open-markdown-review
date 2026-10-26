import { ProtocolError } from './types';
export type PdfExportMode = 'review' | 'clean';
export const REVIEW_PDF_PROFILE = 'omr-review-annotations-v1';
export const CLEAN_PDF_PROFILE = 'omr-document-only-v1';
export function pdfExportMode(value: unknown = 'review'): PdfExportMode {
  if (value !== 'review' && value !== 'clean') throw new ProtocolError('invalid', 'PDF export mode must be review or clean.');
  return value;
}
export function reviewerStatusStyle(status: string): { color?: string; fillColor?: string } {
  if (status === 'in-progress' || status === 'reopened') return { color: '#9a3412', fillColor: '#ffedd5' };
  if (status === 'finished') return { color: '#166534', fillColor: '#dcfce7' };
  return {};
}
