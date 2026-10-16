// Test/qualification tool only; PDF.js is not shipped in either review client.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { getDocument, OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';

export async function inspectPdf(bytes, margin = 40) {
  const loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  const pdf = await loading.promise, pages = [], violations = [], links = [], images = [];
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
      for (const annotation of await page.getAnnotations()) if (annotation.subtype === 'Link') {
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
    return { pageCount: pages.length, landscapePages: pages.filter(page => page.width > page.height).length, pages, links, images, bookmarks, violations };
  } finally { await loading.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await inspectPdf(await readFile(process.argv[2]));
  const { pages, links, images, ...summary } = result;
  console.log(JSON.stringify({ ...summary, images: images.length, links: links.length, participantsPage: pages.find(page => page.text.includes('Reviewer completion and participation'))?.number, commentsPage: pages.find(page => page.text.includes('Review comments, responses and challenged topics'))?.number }, null, 2));
  if (summary.violations.length) process.exitCode = 1;
}
