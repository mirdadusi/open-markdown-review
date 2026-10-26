// Test/qualification tool only; PDF.js is not shipped in either review client.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { getDocument, OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';

export async function inspectPdf(bytes, margin = 40) {
  const loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  const pdf = await loading.promise, pages = [], violations = [], links = [], images = [], annotations = [];
  try {
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 }), text = await page.getTextContent({ disableNormalization: true });
      const items = text.items.filter(item => 'str' in item);
      pages.push({ number, width: viewport.width, height: viewport.height, text: items.map(item => item.str + (item.hasEOL ? '\n' : '')).join('') });
      for (const item of items) {
        if (!item.str.trim()) continue;
        const [a, b, c, d, x, y] = item.transform;
        const size = Math.hypot(c, d), bottom = y - size * 0.25, top = y + size;
        if (x < margin - 1 || x + item.width > viewport.width - margin + 1 || bottom < 14 || top > viewport.height - 30) violations.push({ page: number, kind: 'text-outside-page', text: item.str.slice(0, 120), x, right: x + item.width, bottom, top });
        if (/[\u0000\ufffd]/u.test(item.str)) violations.push({ page: number, kind: 'missing-glyph', text: item.str.slice(0, 120) });
      }
      for (const annotation of await page.getAnnotations()) {
        const box = annotation.rect;
        if (!['Link', 'Popup'].includes(annotation.subtype) && (!Array.isArray(box) || box.length !== 4 || box.some(v => !Number.isFinite(v)) || box[0] < 0 || box[1] < 0 || box[2] > viewport.width || box[3] > viewport.height || box[2] <= box[0] || box[3] <= box[1])) violations.push({ page: number, kind: 'comment-outside-page', id: annotation.id, rect: box });
        if (!['Link', 'Popup'].includes(annotation.subtype)) annotations.push({ page: number, id: annotation.id, subtype: annotation.subtype,
          contents: annotation.contentsObj?.str ?? annotation.contents ?? '', author: annotation.titleObj?.str ?? annotation.title ?? '',
          inReplyTo: annotation.inReplyTo, replyType: annotation.replyType, state: annotation.state, stateModel: annotation.stateModel, rect: annotation.rect, quadPoints: annotation.quadPoints, hasPopup: !!annotation.popupRef });
        if (annotation.subtype !== 'Link') continue;
        let targetPage;
        if (annotation.dest) {
          const destination = typeof annotation.dest === 'string' ? await pdf.getDestination(annotation.dest) : annotation.dest;
          if (!destination) violations.push({ page: number, kind: 'broken-link', destination: annotation.dest });
          else targetPage = await pdf.getPageIndex(destination[0]) + 1;
        }
        links.push({ page: number, destination: annotation.dest, url: annotation.url, targetPage });
      }
      const operators = await page.getOperatorList(), stack = []; let matrix = [1, 0, 0, 1, 0, 0];
      for (let i = 0; i < operators.fnArray.length; i++) {
        const operation = operators.fnArray[i], args = operators.argsArray[i];
        if (operation === OPS.save) stack.push([...matrix]);
        else if (operation === OPS.restore) matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        else if (operation === OPS.transform) matrix = Util.transform(matrix, args);
        else if ([OPS.paintImageXObject, OPS.paintInlineImageXObject].includes(operation)) {
          const xs = [matrix[4], matrix[4] + matrix[0], matrix[4] + matrix[2], matrix[4] + matrix[0] + matrix[2]];
          const ys = [matrix[5], matrix[5] + matrix[1], matrix[5] + matrix[3], matrix[5] + matrix[1] + matrix[3]];
          const image = { page: number, left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) }; images.push(image);
          if (image.left < margin - 1 || image.right > viewport.width - margin + 1 || image.bottom < 35 || image.top > viewport.height - 35) violations.push({ ...image, kind: 'image-outside-page' });
        }
      }
      page.cleanup();
    }
    let bookmarks = 0;
    const inspectOutline = async entries => { for (const entry of entries) { bookmarks++; if (typeof entry.dest === 'string' && !await pdf.getDestination(entry.dest)) violations.push({ kind: 'broken-bookmark', title: entry.title }); await inspectOutline(entry.items ?? []); } };
    await inspectOutline(await pdf.getOutline() ?? []);
    const metadata = await pdf.getMetadata(), attachments = await pdf.getAttachments();
    const annotationIds = new Set(annotations.map(a => a.id));
    for (const annotation of annotations) if (annotation.inReplyTo) {
      if (!annotationIds.has(annotation.inReplyTo)) violations.push({ page: annotation.page, kind: 'orphan-pdf-reply', id: annotation.id });
      else if (annotations.find(a => a.id === annotation.inReplyTo).page !== annotation.page) violations.push({ page: annotation.page, kind: 'cross-page-pdf-reply', id: annotation.id });
    }
    return { pageCount: pages.length, landscapePages: pages.filter(page => page.width > page.height).length, pages, links, images, annotations, metadata: metadata.info, attachments, bookmarks, violations };
  } finally { await loading.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await inspectPdf(await readFile(process.argv[2]));
  const { pages, links, images, annotations, metadata, attachments, ...summary } = result;
  console.log(JSON.stringify({ ...summary, images: images.length, links: links.length, comments: annotations.length, participantsPage: pages.find(page => page.text.includes('Reviewer completion and participation'))?.number }, null, 2));
  if (summary.violations.length) process.exitCode = 1;
}
