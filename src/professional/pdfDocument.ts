import pdfMake from 'pdfmake/build/pdfmake';
import fonts from 'pdfmake/build/vfs_fonts';
import { PdfNode, pdfFonts, pdfFontVfs, preparePdfTypography } from './pdfTypography';
import { installPdfComments, PdfComment } from './pdfComments';
import { OperationControl, checkpoint, interruptible } from './operation';

pdfMake.addVirtualFileSystem(fonts); pdfMake.addFonts(pdfFonts);
let fontsReady: Promise<void> | undefined;
export async function renderPdfDocument(definition: PdfNode & { content: PdfNode[] }, comments: readonly PdfComment[], control?: OperationControl): Promise<Uint8Array> {
  fontsReady ??= pdfFontVfs().then(vfs => { pdfMake.addVirtualFileSystem(vfs); });
  await interruptible(fontsReady, control);
  for (const node of definition.content) preparePdfTypography(node);
  checkpoint(control, 'Laying out the PDF…');
  // Native reply relationships/state require PDF 1.5/1.6, not pdfmake's 1.3 default.
  const output = pdfMake.createPdf({ ...definition, version: '1.7' }, { bufferPages: true });
  const stream = await interruptible(output.getStream(), control);
  checkpoint(control, 'Adding native PDF comments and replies…');
  if (comments.length) installPdfComments(stream, comments);
  return new Uint8Array(await interruptible(output.getBuffer(), control));
}
