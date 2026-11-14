import { AuditInventory, FileEvidence, ProtocolError } from './types';
/** Optional export profile: render-only resources are not added to a frozen revision. */
export const PDF_TEMPLATE_PROFILE = 'omr-pdf-template-v1=';
export function pdfTemplateReceipt(engine: string, resources: readonly FileEvidence[]): FileEvidence | undefined {
  const tokens = engine.split(';').map(value => value.trim()).filter(value => value.startsWith(PDF_TEMPLATE_PROFILE));
  if (!tokens.length) return;
  if (tokens.length !== 1 || !/^omr-pdf-template-v1=sha256:[a-f0-9]{64}$/.test(tokens[0])) throw new ProtocolError('invalid', 'Invalid PDF template render-input profile.');
  const hash = tokens[0].slice(PDF_TEMPLATE_PROFILE.length), matches = resources.filter(file => file.digest === hash);
  const file = matches[0];
  if (matches.length !== 1 || file.path !== `blobs/sha256/${hash.slice(7, 9)}/${hash.slice(7)}` || file.mediaType !== 'application/json' || file.byteLength < 1 || file.byteLength > 98304) throw new ProtocolError('integrity', 'PDF template render-input receipt is missing or inconsistent.');
  return file;
}
export const exportTemplateReceipt = (inventory: AuditInventory) => pdfTemplateReceipt(inventory.renderer.pdfEngine, inventory.resources);
