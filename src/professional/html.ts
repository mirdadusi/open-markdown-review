import { stableId } from './bytes';
import type { Revision } from './types';

export const SANITIZED_HTML_CAPABILITY = 'sanitized-html-v1' as const;
export const SANITIZED_HTML_PROFILE = 'commonmark-gfm+sanitized-html-v1' as const;
export const SANITIZED_HTML_VERSION = 'omr-sanitized-html-v1' as const;

export interface HtmlAttribute { name: string; value?: string }
export type HtmlPart =
  | { kind: 'text'; raw: string; start: number; end: number }
  | { kind: 'comment'; raw: string; start: number; end: number }
  | { kind: 'tag'; raw: string; start: number; end: number; name: string; closing: boolean; selfClosing: boolean; attributes: HtmlAttribute[] };

const allowed = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'div', 'dl', 'dt',
  'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark',
  'ol', 'p', 'pre', 's', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'u', 'ul',
]);
const voidElements = new Set(['br', 'col', 'hr', 'img']);
const rawTextElements = new Set(['iframe', 'noembed', 'noframes', 'plaintext', 'script', 'style', 'textarea', 'xmp']);
const externalSchemes = /^(?:https:|mailto:)/i;
const auditedSchemes = /^(?:https?:|mailto:|file:)/i;
const relativeReference = /^(?![A-Za-z][A-Za-z0-9+.-]*:)(?!\/\/).+/;

export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));

function decodeAttribute(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/gi, (entity, decimal, hexadecimal) => {
    if (decimal || hexadecimal) {
      const point = Number.parseInt(decimal ?? hexadecimal, hexadecimal ? 16 : 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '\ufffd';
    }
    return ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" } as Record<string, string>)[entity.toLowerCase()] ?? entity;
  });
}

function tagEnd(source: string, start: number): number {
  let quote = '';
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index];
    if (quote) { if (character === quote) quote = ''; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '>') return index + 1;
  }
  return -1;
}

function attributes(raw: string, afterName: number): HtmlAttribute[] {
  const result: HtmlAttribute[] = [], seen = new Set<string>();
  let cursor = afterName;
  while (cursor < raw.length - 1 && result.length < 64) {
    while (/\s/.test(raw[cursor] ?? '')) cursor++;
    if (cursor >= raw.length - 1 || raw[cursor] === '>' || raw[cursor] === '/') break;
    const match = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(raw.slice(cursor));
    if (!match) { cursor++; continue; }
    const name = match[0].toLowerCase(); cursor += match[0].length;
    while (/\s/.test(raw[cursor] ?? '')) cursor++;
    let value: string | undefined;
    if (raw[cursor] === '=') {
      cursor++; while (/\s/.test(raw[cursor] ?? '')) cursor++;
      const quote = raw[cursor];
      if (quote === '"' || quote === "'") {
        const end = raw.indexOf(quote, cursor + 1);
        value = raw.slice(cursor + 1, end < 0 ? raw.length - 1 : end); cursor = end < 0 ? raw.length - 1 : end + 1;
      } else {
        const unquoted = /^[^\s>]+/.exec(raw.slice(cursor));
        value = unquoted?.[0] ?? ''; cursor += value.length;
      }
    }
    if (!seen.has(name)) { seen.add(name); result.push({ name, ...(value === undefined ? {} : { value: decodeAttribute(value) }) }); }
  }
  return result;
}

/** A bounded, non-DOM tokenizer used identically by authoring and both clients. */
export function scanHtml(source: string): HtmlPart[] {
  const result: HtmlPart[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const opening = source.indexOf('<', cursor);
    if (opening < 0) { if (cursor < source.length) result.push({ kind: 'text', raw: source.slice(cursor), start: cursor, end: source.length }); break; }
    if (opening > cursor) result.push({ kind: 'text', raw: source.slice(cursor, opening), start: cursor, end: opening });
    if (source.startsWith('<!--', opening)) {
      const close = source.indexOf('-->', opening + 4), end = close < 0 ? source.length : close + 3;
      result.push({ kind: 'comment', raw: source.slice(opening, end), start: opening, end }); cursor = end; continue;
    }
    const end = tagEnd(source, opening);
    if (end < 0) { result.push({ kind: 'text', raw: source.slice(opening), start: opening, end: source.length }); break; }
    const raw = source.slice(opening, end), match = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(raw);
    if (!match) { result.push({ kind: 'text', raw: '<', start: opening, end: opening + 1 }); cursor = opening + 1; continue; }
    const name = match[2].toLowerCase(), closing = !!match[1], selfClosing = /\/\s*>$/.test(raw) || voidElements.has(name);
    result.push({ kind: 'tag', raw, start: opening, end, name, closing, selfClosing, attributes: closing ? [] : attributes(raw, match[0].length) });
    if (!closing && !selfClosing && rawTextElements.has(name)) {
      if (name === 'plaintext') { if (end < source.length) result.push({ kind: 'text', raw: source.slice(end), start: end, end: source.length }); break; }
      const close = new RegExp(`<\\s*\\/\\s*${name}\\s*>`, 'ig'); close.lastIndex = end;
      const found = close.exec(source);
      if (!found) { if (end < source.length) result.push({ kind: 'text', raw: source.slice(end), start: end, end: source.length }); break; }
      if (found.index > end) result.push({ kind: 'text', raw: source.slice(end, found.index), start: end, end: found.index });
      result.push({ kind: 'tag', raw: found[0], start: found.index, end: close.lastIndex, name, closing: true, selfClosing: false, attributes: [] });
      cursor = close.lastIndex; continue;
    }
    cursor = end;
  }
  return result;
}

export function attribute(part: Extract<HtmlPart, { kind: 'tag' }>, name: string): string | undefined {
  return part.attributes.find(item => item.name === name)?.value;
}

export function isAllowedHtmlTag(name: string): boolean { return allowed.has(name); }
export function isAuditedExternalReference(reference: string): boolean { return auditedSchemes.test(reference); }

function boundedInteger(value: string | undefined, maximum: number): number | undefined {
  if (!value || !/^\d{1,5}$/.test(value)) return undefined;
  const number = Number(value); return number >= 1 && number <= maximum ? number : undefined;
}

interface TableContext { id: string; row: number; column: number }
export interface HtmlRenderState { tableOrdinal: number }
export interface HtmlRenderOptions {
  document: string;
  revision: Revision;
  sourceOffset: number;
  state: HtmlRenderState;
  decodeText: (value: string) => string;
  mapText: (visible: string, start: number, end: number) => string | undefined;
}

function safeId(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

function safeCommonAttributes(part: Extract<HtmlPart, { kind: 'tag' }>, decode: (value: string) => string): string[] {
  const result: string[] = [];
  const read = (name: string) => { const value = attribute(part, name); return value === undefined ? undefined : decode(value); };
  const id = safeId(read('id')), title = read('title');
  if (id) result.push(`data-source-bookmark="${escapeHtml(id)}"`);
  if (title && title.length <= 512) result.push(`title="${escapeHtml(title)}"`);
  if (part.name === 'ol') { const start = boundedInteger(read('start'), 100000); if (start) result.push(`start="${start}"`); }
  if (part.name === 'details' && part.attributes.some(item => item.name === 'open')) result.push('open');
  if (part.name === 'td' || part.name === 'th') {
    const colspan = boundedInteger(read('colspan'), 100), rowspan = boundedInteger(read('rowspan'), 100);
    if (colspan) result.push(`colspan="${colspan}"`); if (rowspan) result.push(`rowspan="${rowspan}"`);
  }
  return result;
}

/** Reconstructs only the normative allowlist; source attributes are never copied wholesale. */
export function renderSanitizedHtml(fragment: string, options: HtmlRenderOptions): string {
  const parts = scanHtml(fragment), tableRanges = new Map<number, number>(), openTables: number[] = [];
  for (const part of parts) {
    if (part.kind !== 'tag' || part.name !== 'table') continue;
    if (!part.closing && !part.selfClosing) openTables.push(part.start);
    else if (part.closing) {
      const start = openTables.pop();
      if (start !== undefined) tableRanges.set(start, part.end);
    }
  }
  for (const start of openTables) tableRanges.set(start, fragment.length);
  const tables: TableContext[] = [];
  let output = '';
  for (const part of parts) {
    if (part.kind === 'comment') continue;
    if (part.kind === 'text') {
      if (!part.raw) continue;
      if (part.raw.includes('<')) { output += escapeHtml(part.raw); continue; }
      if (!part.raw.trim()) { output += part.raw; continue; }
      const visible = options.decodeText(part.raw), id = options.mapText(visible, options.sourceOffset + part.start, options.sourceOffset + part.end);
      output += id ? `<span data-source-map="${id}">${part.raw}</span>` : part.raw;
      continue;
    }
    if (!allowed.has(part.name)) { output += escapeHtml(part.raw); continue; }
    if (part.closing) {
      output += `</${part.name}>`;
      if (part.name === 'table') tables.pop();
      continue;
    }
    if (part.name === 'img') {
      const referenceValue = attribute(part, 'src'), reference = referenceValue === undefined ? undefined : options.decodeText(referenceValue);
      const altValue = attribute(part, 'alt'), alt = altValue === undefined ? '' : options.decodeText(altValue), id = reference ? stableId('resource', `${options.document}\0${reference}`) : '';
      const resource = options.revision.resources.find(item => item.id === id && item.document === options.document && item.role === 'image');
      if (!resource) { output += '<span class="error">Missing frozen HTML image</span>'; continue; }
      const width = boundedInteger(attribute(part, 'width'), 10000), height = boundedInteger(attribute(part, 'height'), 10000);
      const common = safeCommonAttributes(part, options.decodeText);
      output += `<span class="semantic" tabindex="0" data-kind="image" data-resource-id="${id}" data-start="${options.sourceOffset + part.start}" data-end="${options.sourceOffset + part.end}"><img data-resource="${id}" alt="${escapeHtml(alt)}"${width ? ` width="${width}"` : ''}${height ? ` height="${height}"` : ''}${common.length ? ` ${common.join(' ')}` : ''}></span>`;
      continue;
    }
    const attrs = safeCommonAttributes(part, options.decodeText);
    if (part.name === 'a') {
      const hrefValue = attribute(part, 'href'), href = hrefValue === undefined ? undefined : options.decodeText(hrefValue);
      const titleValue = attribute(part, 'title'), title = titleValue === undefined ? undefined : options.decodeText(titleValue);
      if (href && title?.trim().toLowerCase() === 'review:attach') attrs.push('href="#"', `data-attachment="${stableId('resource', `${options.document}\0${href}`)}"`);
      else if (href && externalSchemes.test(href)) attrs.push(`href="${escapeHtml(href)}"`, 'rel="noopener noreferrer"', 'target="_blank"');
      else if (href && relativeReference.test(href)) attrs.push('href="#"', `data-document-link="${escapeHtml(href)}"`);
      else if (href) attrs.push('class="blocked-reference"', 'title="This external reference is retained in the audit record but is not opened by the review client."');
    }
    if (part.name === 'table') {
      const table = { id: stableId('table', `${options.document}\0${options.state.tableOrdinal++}`), row: -1, column: -1 }; tables.push(table);
      attrs.push('class="semantic html-table"', 'tabindex="0"', 'data-kind="table"', `data-table-id="${table.id}"`, `data-start="${options.sourceOffset + part.start}"`, `data-end="${options.sourceOffset + (tableRanges.get(part.start) ?? part.end)}"`);
    } else if (part.name === 'tr' && tables.length) { tables.at(-1)!.row++; tables.at(-1)!.column = -1; }
    else if ((part.name === 'td' || part.name === 'th') && tables.length) {
      const table = tables.at(-1)!; table.column++;
      attrs.push('class="semantic"', 'tabindex="0"', 'data-kind="table-cell"', `data-table-id="${table.id}"`, `data-row="${table.row}"`, `data-column="${table.column}"`);
    }
    output += `<${part.name}${attrs.length ? ` ${attrs.join(' ')}` : ''}${part.selfClosing && !voidElements.has(part.name) ? ' /' : ''}>`;
  }
  return output;
}
