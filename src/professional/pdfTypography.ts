import data from './generated/pdf-fonts.json';
import { ProtocolError } from './types';
import { fromBase64, toBase64, digest } from './bytes';

export type PdfNode = Record<string, unknown>;
type Style = { font?: string; fontSize?: number; bold?: boolean; italics?: boolean };
const metrics = data.metrics as Record<string, Record<string, number>>;
export const pdfFontSources = data.sources;
export const PDF_LAYOUT_VERSION = 'omr-archive-layout-3';
export const pdfFonts = {
  Symbols: { normal: 'NotoSansSymbols2-Regular.ttf', bold: 'NotoSansSymbols2-Regular.ttf', italics: 'NotoSansSymbols2-Regular.ttf', bolditalics: 'NotoSansSymbols2-Regular.ttf' },
  Mono: { normal: 'NotoSansMono-Regular.ttf', bold: 'NotoSansMono-Regular.ttf', italics: 'NotoSansMono-Regular.ttf', bolditalics: 'NotoSansMono-Regular.ttf' },
};
/** Compressed offline fonts are decoded once, on export, not during review open. */
export async function pdfFontVfs(): Promise<Record<string, string>> {
  const vfs: Record<string, string> = {};
  for (const [name, compressed] of Object.entries(data.vfsGzip)) {
    const stream = new Blob([fromBase64(compressed) as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    if (digest(bytes).slice(7) !== (data.sources as Record<string, string>)[name]) throw new Error(`Bundled PDF font changed: ${name}`);
    vfs[name] = toBase64(bytes);
  }
  return vfs;
}
function filename(style: Style): string {
  return style.font === 'Symbols' ? 'NotoSansSymbols2-Regular.ttf' : style.font === 'Mono' ? 'NotoSansMono-Regular.ttf' : `Roboto-${style.bold ? style.italics ? 'MediumItalic' : 'Medium' : style.italics ? 'Italic' : 'Regular'}.ttf`;
}
function family(character: string, style: Style): string | undefined {
  const point = character.codePointAt(0)!;
  if (point < 32 || /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f]/u.test(character) || metrics[filename(style)][point] !== undefined) return style.font ?? 'Roboto';
  if (metrics['Roboto-Regular.ttf'][point] !== undefined) return 'Roboto';
  if (metrics['NotoSansSymbols2-Regular.ttf'][point] !== undefined) return 'Symbols';
  if (metrics['NotoSansMono-Regular.ttf'][point] !== undefined) return 'Mono';
}
export function pdfTextWidth(text: string, style: Style = {}): number {
  let width = 0;
  for (const character of text) {
    const font = family(character, style), point = character.codePointAt(0)!;
    const file = font ? filename({ ...style, font }) : filename(style);
    width += (metrics[file][point] ?? (/[\s\u200b\ufe0f]/u.test(character) ? 0 : 0.6)) * (style.fontSize ?? 10);
  }
  return width;
}
/** Never let a machine identifier, URL, or source path determine a table width. */
export function wrapPdfToken(text: string, width: number, style: Style = {}): string {
  return text.replace(/[^\s\u200b]+/gu, token => {
    if (pdfTextWidth(token, style) <= width) return token;
    let result = '', used = 0;
    const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(token);
    for (const { segment } of segments) {
      const advance = pdfTextWidth(segment, style);
      if (used && used + advance > Math.max(8, width - 1)) { result += '\u200b'; used = 0; }
      result += segment; used += advance;
    }
    return result;
  });
}
/** Preserve actual Unicode; select an embedded font per run, never transliterate. */
export function pdfFontRuns(text: string, style: Style = {}): PdfNode[] {
  const result: PdfNode[] = [], missing = new Set<string>();
  for (const character of text) {
    const font = family(character, style);
    if (!font) { missing.add(`U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} (${character})`); continue; }
    const last = result.at(-1);
    if (last?.font === font) last.text = String(last.text) + character;
    else result.push({ text: character, font, ...(font === 'Symbols' ? { bold: false, italics: false } : {}) });
  }
  if (missing.size) throw new ProtocolError('unsupported', `PDF fonts do not cover ${[...missing].slice(0, 12).join(', ')}. No archive was published. The reviewed UTF-8 source is unchanged.`);
  return result.length ? result : [{ text: '' }];
}
/** Applies to report prose as well as Markdown: titles, identities and replies too. */
export function preparePdfTypography(node: unknown, inherited: Style = {}, width = 490): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (let index = 0; index < node.length; index++) { if (typeof node[index] === 'string') node[index] = { text: node[index] }; preparePdfTypography(node[index], inherited, width); } return; }
  const item = node as PdfNode, style = { ...inherited, ...Object.fromEntries(['font', 'fontSize', 'bold', 'italics'].filter(key => item[key] !== undefined).map(key => [key, item[key]])) } as Style;
  const runs = (value: unknown, props: PdfNode): PdfNode[] => {
    if (typeof value === 'string') return pdfFontRuns(wrapPdfToken(value, width, props), props).map(run => ({ ...props, ...run }));
    if (!value || typeof value !== 'object') return [{ text: String(value ?? ''), ...props }];
    const { text, ...rest } = value as PdfNode, next = { ...props, ...rest };
    if (Array.isArray(text)) return text.flatMap(child => runs(child, next));
    if (typeof text === 'string') return runs(text, next);
    return [next]; // pageReference/textReference are resolved by the PDF engine.
  };
  if (typeof item.text === 'string' || Array.isArray(item.text)) item.text = Array.isArray(item.text) ? item.text.flatMap(child => runs(child, style)) : runs(item.text, style);
  for (const key of ['stack', 'ul', 'ol', 'columns']) if (item[key]) preparePdfTypography(item[key], style, width);
  if (item.table) {
    const table = item.table as { widths: unknown[]; body: unknown[][] };
    for (const row of table.body) for (let index = 0; index < row.length; index++) {
      if (typeof row[index] === 'string' || typeof row[index] === 'number') row[index] = { text: String(row[index]) };
      const cellWidth = typeof table.widths[index] === 'number' ? table.widths[index] as number : width / row.length - 10;
      preparePdfTypography(row[index], style, Math.max(10, cellWidth));
    }
  }
}
