import { stableId } from './bytes';
import { rasterizeSvg } from './assets';
import { OperationControl, checkpoint } from './operation';
import { PdfNode, pdfTextWidth, wrapPdfToken } from './pdfTypography';
import { offsetAt } from './bytes';
import { MarkdownAnchor } from './types';
import { RenderedSource } from './rendering';
import { PDF_COMMENT_PREFIX } from './pdfComments';

export const PDF_PORTRAIT_WIDTH = 505.28;
export const PDF_LANDSCAPE_WIDTH = 751.89;
const PT_PER_PIXEL = 0.75;
const INK = '#172b42', BLUE = '#2458a6';
export const documentDestination = (path: string) => stableId('document', path);
export const headingSlug = (text: string) => text.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s/g, '-');
export interface PdfDocumentLayout { path: string; host: HTMLElement; title: string; landscape: boolean }
export interface PdfNavigation { documents: Map<string, PdfDocumentLayout>; destinations: WeakMap<Element, string>; fragments: Map<string, string> }
export interface PdfLayoutContext { document: string; navigation: PdfNavigation; width: number; fontSize?: number; inTable?: boolean; nativeComments?: boolean; clean?: boolean; control?: OperationControl }

/** PDF annotations are derived from the same UTF-16 source maps as the live view. */
export function highlightPdfFindings(host: HTMLElement, rendered: RenderedSource, source: string, findings: Array<{ anchor: MarkdownAnchor; destination: string; reference: string }>, nativeComments = false): void {
  for (const finding of findings) {
    const target = finding.anchor.target;
    if (target && target.kind !== 'text') {
      const selector = target.kind === 'image' ? `[data-resource-id="${target.resourceId}"]` : target.kind === 'mermaid' ? `[data-diagram-id="${target.diagramId}"]` : target.kind === 'table-cell' ? `[data-table-id="${target.tableId}"][data-row="${target.row}"][data-column="${target.column}"]` : `[data-table-id="${target.tableId}"]`;
      const element = host.querySelector(selector);
      if (nativeComments && element) { element.setAttribute('data-pdf-finding', [...new Set([...(element.getAttribute('data-pdf-finding')?.split(',') ?? []), finding.destination])].join(',')); continue; }
      if (element) { const marker = document.createElement('p'), link = document.createElement('a'); link.dataset.pdfFinding = finding.destination; link.textContent = `Review item ${finding.reference}`; marker.append(link); if (['td', 'th'].includes(element.localName)) element.prepend(marker); else element.after(marker); }
      continue;
    }
    const start = offsetAt(source, finding.anchor.range.start), end = offsetAt(source, finding.anchor.range.end);
    for (const span of host.querySelectorAll<HTMLElement>('[data-source-map]')) {
      const map = rendered.textMaps.get(span.dataset.sourceMap!);
      if (!map || map[0] >= end || map.at(-1)! <= start) continue;
      const from = Math.max(0, map.findIndex(offset => offset >= start)), to = map.findIndex(offset => offset >= end), limit = to < 0 ? map.length - 1 : to;
      const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT), nodes: Array<{ text: Text; from: number; to: number }> = []; let position = 0;
      while (walker.nextNode()) { const text = walker.currentNode as Text; nodes.push({ text, from: position, to: position + text.length }); position += text.length; }
      for (const node of nodes.reverse()) {
        const left = Math.max(from, node.from) - node.from, right = Math.min(limit, node.to) - node.from;
        if (right <= left) continue;
        if (right < node.text.length) node.text.splitText(right);
        const selected = left ? node.text.splitText(left) : node.text, mark = document.createElement('mark'); mark.dataset.pdfFinding = finding.destination;
        selected.replaceWith(mark); mark.append(selected);
      }
    }
  }
}

export function pdfNavigation(documents: Array<{ path: string; host: HTMLElement }>): PdfNavigation {
  const navigation: PdfNavigation = { documents: new Map(), destinations: new WeakMap(), fragments: new Map() };
  for (const doc of documents) {
    const title = doc.host.querySelector('h1,h2')?.textContent?.trim() || doc.path.split('/').at(-1)!, used = new Map<string, number>();
    const landscape = [...doc.host.querySelectorAll('table')].some(table => tableRows(table).some(({ row }) => [...row.children].reduce((n, cell) => n + span(cell, 'colspan'), 0) > 5));
    navigation.documents.set(doc.path, { ...doc, title, landscape });
    for (const element of doc.host.querySelectorAll('h1,h2,h3,h4,h5,h6,[data-source-bookmark]')) {
      const bookmark = element.getAttribute('data-source-bookmark'), slug = bookmark ?? headingSlug(element.textContent ?? '');
      if (!slug) continue;
      const key = `${doc.path}#${slug}`, occurrence = used.get(key) ?? 0; used.set(key, occurrence + 1);
      const destination = stableId('heading', `${key}\0${occurrence}`); navigation.destinations.set(element, destination);
      if (!navigation.fragments.has(key)) navigation.fragments.set(key, destination);
      if (occurrence && !bookmark) navigation.fragments.set(`${key}-${occurrence}`, destination);
    }
  }
  return navigation;
}
function baseLinkStyle(element: Element, context: PdfLayoutContext): PdfNode {
  const local = element.getAttribute('data-document-link');
  if (local) {
    try {
      const resolved = new URL(local, `https://review.invalid/${context.document}`), path = decodeURIComponent(resolved.pathname.slice(1)), fragment = decodeURIComponent(resolved.hash.slice(1));
      const destination = fragment ? context.navigation.fragments.get(`${path}#${fragment}`) : context.navigation.documents.has(path) ? documentDestination(path) : undefined;
      if (destination) return { color: BLUE, decoration: 'underline', linkToDestination: destination };
    } catch { /* An invalid/out-of-scope reference remains visible, not a dead link. */ }
    return { color: '#526477', italics: true };
  }
  const attachment = element.getAttribute('data-attachment');
  if (attachment) return context.clean ? { color: BLUE } : { color: BLUE, decoration: 'underline', linkToDestination: `attachment-${attachment}` };
  const finding = context.nativeComments ? null : element.getAttribute('data-pdf-finding');
  if (finding) return { linkToDestination: finding, background: '#fff0ba', color: INK };
  const href = element.getAttribute('href');
  return href && /^(?:https:|mailto:)/i.test(href) ? { color: BLUE, decoration: 'underline', link: href } : {};
}
function linkStyle(element: Element, context: PdfLayoutContext): PdfNode {
  const ids: string[] = [];
  if (context.nativeComments) for (let parent: Element | null = element; parent; parent = parent.parentElement) ids.push(...(parent.getAttribute('data-pdf-finding')?.split(',') ?? []));
  const target = ids.length ? element.closest('a[data-document-link],a[data-attachment],a[href]') ?? element : element;
  const base = baseLinkStyle(target, context);
  return ids.length ? { ...base, linkToDestination: PDF_COMMENT_PREFIX + [...new Set(ids)].join(',') + '|' + encodeURIComponent(typeof base.linkToDestination === 'string' ? base.linkToDestination : '') } : base;
}
function inline(root: Node, context: PdfLayoutContext, style: PdfNode = {}): PdfNode[] {
  if (root.nodeType === Node.TEXT_NODE) return [{ text: wrapPdfToken((root.textContent ?? '').replace(/[\t\r\n ]+/g, ' '), context.width, { fontSize: context.fontSize ?? 10, ...style }), ...style }];
  if (!(root instanceof Element)) return [];
  const tag = root.localName;
  if (tag === 'br') return [{ text: '\n', ...style }];
  const next: PdfNode = { ...style, ...(['strong', 'b'].includes(tag) ? { bold: true } : {}), ...(['em', 'i'].includes(tag) ? { italics: true } : {}), ...(['s', 'del', 'strike'].includes(tag) ? { decoration: 'lineThrough' } : {}), ...(tag === 'u' || tag === 'ins' ? { decoration: 'underline' } : {}), ...(tag === 'sup' ? { sup: true } : {}), ...(tag === 'sub' ? { sub: true } : {}), ...(tag === 'mark' && !context.nativeComments ? { background: '#fff0ba' } : {}), ...(tag === 'code' || tag === 'kbd' ? { font: 'Mono', fontSize: (context.fontSize ?? 10) * 0.9, background: '#f1f4f8' } : {}), ...linkStyle(root, context) };
  const children = [...root.childNodes].flatMap(child => inline(child, context, next));
  return tag === 'a' && root.hasAttribute('data-document-link') && !next.linkToDestination ? [...children, { text: ' [target not in this archive]', fontSize: 7.5, color: '#526477', italics: true }] : children;
}
const span = (cell: Element, name: string) => Math.min(100, Math.max(1, Number.parseInt(cell.getAttribute(name) ?? '1', 10) || 1));
function tableRows(table: Element): Array<{ row: Element; header: boolean }> {
  return [...table.children].flatMap(child => child.localName === 'tr' ? [{ row: child, header: [...child.children].every(cell => cell.localName === 'th') }] : ['thead', 'tbody', 'tfoot'].includes(child.localName) ? [...child.children].filter(row => row.localName === 'tr').map(row => ({ row, header: child.localName === 'thead' })) : []);
}
/** Numeric widths deliberately do not inherit pdfmake's largest-word star minimum. */
export function fitTableColumns(preferences: readonly number[], width: number): number[] {
  const count = Math.max(1, preferences.length), available = Math.max(count * 0.5, width - count * 8 - (count + 1) * 0.4);
  const minimums = preferences.map(value => Math.min(70, Math.max(16, value + 5))), minimum = minimums.reduce((a, b) => a + b, 0);
  if (minimum >= available) return minimums.map(value => value * available / minimum);
  const weights = preferences.map((value, index) => Math.max(0, Math.min(320, value) - minimums[index])), sum = weights.reduce((a, b) => a + b, 0);
  return minimums.map((value, index) => value + (available - minimum) * (sum ? weights[index] / sum : 1 / count));
}
export function fitPdfImage(naturalWidth: number, naturalHeight: number, available: number, declaredWidth?: number, declaredHeight?: number, inTable = false): { width: number; height: number } {
  if (!(naturalWidth > 0 && naturalHeight > 0)) throw new Error('Image has no usable intrinsic dimensions.');
  const ratio = naturalWidth / naturalHeight, intendedWidth = declaredWidth ?? (declaredHeight ? declaredHeight * ratio : naturalWidth);
  const maximumHeight = inTable ? 120 : 360;
  const width = Math.min(available, intendedWidth * PT_PER_PIXEL, maximumHeight * ratio);
  return { width, height: width / ratio };
}
async function imageNode(element: Element, context: PdfLayoutContext): Promise<PdfNode[]> {
  let image: string, width: number, height: number;
  if (element instanceof SVGElement) {
    const box = element.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    width = box?.[2] || Number.parseFloat(element.getAttribute('width') ?? '') || 300;
    height = box?.[3] || Number.parseFloat(element.getAttribute('height') ?? '') || 150;
    image = await rasterizeSvg(new XMLSerializer().serializeToString(element), 1900, context.control);
  } else {
    const img = element as HTMLImageElement; width = img.naturalWidth; height = img.naturalHeight;
    if (!width || !height || !img.complete) throw new Error(`Frozen image did not decode: ${img.alt || img.dataset.resource}`);
    if (img.src.startsWith('data:image/svg+xml;')) {
      const svg = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(img.src.split(',')[1]), c => c.charCodeAt(0)));
      image = await rasterizeSvg(svg, 1900, context.control);
    } else if (/^data:image\/(?:png|jpeg);/i.test(img.src)) image = img.src;
    else { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; canvas.getContext('2d')!.drawImage(img, 0, 0); image = canvas.toDataURL('image/png'); }
  }
  const number = (name: string) => { const value = Number(element.getAttribute(name)); return Number.isFinite(value) && value > 0 ? value : undefined; };
  const size = fitPdfImage(width, height, context.width, number('width'), number('height'), context.inTable);
  return [{ image, ...size, ...linkStyle(element, context), alignment: context.inTable ? 'left' : 'center', margin: [0, 5, 0, 6] }];
}
async function tableNode(element: Element, context: PdfLayoutContext): Promise<PdfNode[]> {
  const rows = tableRows(element), cells: Array<{ element: Element; row: number; column: number; colSpan: number; rowSpan: number }> = [], occupied: boolean[][] = [];
  let count = 0;
  for (let y = 0; y < rows.length; y++) {
    occupied[y] ??= []; let x = 0;
    for (const cell of rows[y].row.children) {
      if (!['td', 'th'].includes(cell.localName)) continue;
      while (occupied[y][x]) x++;
      const colSpan = span(cell, 'colspan'), rowSpan = Math.min(span(cell, 'rowspan'), rows.length - y);
      cells.push({ element: cell, row: y, column: x, colSpan, rowSpan });
      for (let row = y; row < y + rowSpan; row++) for (let col = x; col < x + colSpan; col++) { occupied[row] ??= []; occupied[row][col] = true; }
      x += colSpan; count = Math.max(count, x);
    }
  }
  if (!count || !rows.length) return [];
  const fontSize = count > 6 ? 8.2 : 9.2, preferences = Array.from({ length: count }, () => 24);
  for (const cell of cells) {
    const text = cell.element.textContent?.trim() ?? '', lines = text.split(/\r?\n/);
    const preferred = Math.min(320, Math.max(...lines.map(line => pdfTextWidth(line, { fontSize, bold: cell.element.localName === 'th' })), 24));
    for (let x = cell.column; x < cell.column + cell.colSpan; x++) preferences[x] = Math.max(preferences[x], preferred / cell.colSpan);
  }
  const widths = fitTableColumns(preferences, context.width), body: PdfNode[][] = rows.map(() => Array.from({ length: count }, () => ({})));
  if (widths.some(width => width < 14)) throw new Error('This table has too many columns for a legible PDF at its containing width. Split the source table or use fewer nested columns. No archive was published.');
  for (const cell of cells) {
    const width = widths.slice(cell.column, cell.column + cell.colSpan).reduce((a, b) => a + b, 0) + (cell.colSpan - 1) * 8.4;
    const stack = await pdfNodes(cell.element, { ...context, width, fontSize, inTable: true });
    body[cell.row][cell.column] = { stack: stack.length ? stack : [{ text: '' }], fontSize, color: INK, fillColor: cell.element.localName === 'th' ? '#eaf0f7' : cell.row % 2 ? '#f8fafc' : '#ffffff', bold: cell.element.localName === 'th', ...(cell.colSpan > 1 ? { colSpan: cell.colSpan } : {}), ...(cell.rowSpan > 1 ? { rowSpan: cell.rowSpan } : {}) };
  }
  const firstBody = rows.findIndex(item => !item.header), headerRows = firstBody < 0 ? rows.length : firstBody;
  const caption = [...element.children].find(child => child.localName === 'caption');
  return [...(caption ? [{ text: inline(caption, context), bold: true, margin: [0, 6, 0, 3] }] : []), {
    table: { headerRows, widths, body, keepWithHeaderRows: headerRows ? 1 : 0 },
    layout: { hLineWidth: () => 0.4, vLineWidth: () => 0.4, hLineColor: () => '#cbd7e4', vLineColor: () => '#cbd7e4', paddingLeft: () => 4, paddingRight: () => 4, paddingTop: () => 4, paddingBottom: () => 4 },
    margin: [0, 7, 0, 10]
  }];
}
export async function pdfNodes(root: Node, context: PdfLayoutContext): Promise<PdfNode[]> {
  checkpoint(context.control);
  if (root.nodeType === Node.TEXT_NODE) return root.textContent?.trim() ? [{ text: inline(root, context) }] : [];
  if (!(root instanceof Element)) return [];
  const tag = root.localName, id = context.navigation.destinations.get(root);
  const bookmark = (destination: string): PdfNode => ({ text: '\u200b', id: destination, fontSize: 0.1, margin: [0, 0, 0, 0] });
  if (tag === 'img' || tag === 'svg') return [...(id ? [bookmark(id)] : []), ...await imageNode(root, context)];
  if (tag === 'table') return [...(id ? [bookmark(id)] : []), ...await tableNode(root, context)];
  if (tag === 'pre') return [{ text: wrapPdfToken(root.textContent ?? '', context.width - 16, { font: 'Mono', fontSize: 8 }), font: 'Mono', fontSize: 8, preserveLeadingSpaces: true, background: '#f2f4f8', margin: [8, 6, 8, 8], ...(id ? { id } : {}) }];
  if (tag === 'hr') return [{ canvas: [{ type: 'line', x1: 0, x2: context.width, y1: 0, y2: 0, lineWidth: 0.5, lineColor: '#cbd7e4' }], margin: [0, 9, 0, 9] }];
  if (/^h[1-6]$/.test(tag)) return [{ text: inline(root, { ...context, fontSize: 22 - Number(tag[1]) * 2 }), fontSize: 22 - Number(tag[1]) * 2, bold: true, color: INK, headlineLevel: Number(tag[1]), margin: [0, 12, 0, 5], ...(id ? { id } : {}) }];
  const blockSelector = 'img,svg,table,ul,ol,p,pre,blockquote,figure,div,details,dl';
  if (!root.querySelector(blockSelector) && !['article', 'figure', 'ul', 'ol'].includes(tag)) {
    const alignment = /text-align:\s*(left|center|right)/.exec(root.getAttribute('style') ?? '')?.[1];
    const bookmarks = [...root.querySelectorAll('[data-source-bookmark]')].map(element => context.navigation.destinations.get(element)).filter((value): value is string => !!value);
    const text = inline(root, context);
    return [...bookmarks.map(bookmark), { text: text.length ? text : '\u200b', ...(alignment ? { alignment } : {}), ...(tag === 'summary' || tag === 'dt' ? { bold: true } : {}), margin: context.inTable ? [0, 1, 0, 2] : ['p', 'li', 'figcaption'].includes(tag) ? [0, 3, 0, 7] : [0, 0, 0, 0], ...(id ? { id } : {}) }];
  }
  if (tag === 'ul' || tag === 'ol') {
    const items = await Promise.all([...root.children].filter(child => child.localName === 'li').map(async child => ({ stack: await pdfNodes(child, { ...context, width: context.width - 20 }) })));
    return [{ [tag]: items, ...(tag === 'ol' && root.hasAttribute('start') ? { start: Number(root.getAttribute('start')) } : {}), margin: [0, 3, 0, 8] }];
  }
  const children: PdfNode[] = [];
  for (const child of root.childNodes) children.push(...await pdfNodes(child, { ...context, width: tag === 'blockquote' ? context.width - 16 : context.width }));
  if (tag === 'blockquote') return [{ stack: children, color: '#526477', margin: [12, 5, 4, 8] }];
  if (id) children.unshift({ text: '\u200b', id, fontSize: 1, margin: [0, 0, 0, 0] });
  return children;
}
