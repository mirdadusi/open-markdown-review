import type Token from 'markdown-it/lib/token.mjs';
import { digest, offsetAt, pointAt, stableId } from './bytes';
import { inspect, markdown } from './validation';
import { Event, MarkdownAnchor, Revision } from './types';
import { fold } from './state';
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export interface RenderedSource { html: string; textMaps: Map<string, number[]> }
/** Stable source spans are independent of comments. New events update annotations, not Mermaid. */
export function renderDocument(source: string, document: string, revision: Revision): RenderedSource {
  const md = markdown(), { tokens, tables, diagrams } = inspect(source, document);
  const lines = [...source.matchAll(/\r\n|\r|\n/g)], lineOffset = (line: number) => line === 0 ? 0 : lines[line - 1] ? lines[line - 1].index! + lines[line - 1][0].length : source.length;
  const textMaps = new Map<string, number[]>(); let mapId = 0, tableIndex = -1, row = -1, column = -1, diagramIndex = 0;
  const inlineCursors = new Map<number, number>();
  // Skip non-visible destinations/titles. Searching their text would attach a
  // later repeated phrase to a URL rather than to the visible document phrase.
  const afterLink = (from: number, end: number, image = false): number => {
    let close = from;
    if (image) {
      const opener = source.indexOf('![', from); if (opener < 0 || opener >= end) return from;
      close = opener + 2; let depth = 1;
      for (; close < end; close++) { if (source[close] === '\\') { close++; continue; } if (source[close] === '[') depth++; if (source[close] === ']' && --depth === 0) break; }
    } else { close = source.indexOf(']', from); if (close < 0 || close >= end) return from; }
    let next = close + 1;
    if (source[next] === '(') {
      next++; while (next < end && /\s/.test(source[next])) next++;
      const destination = md.helpers.parseLinkDestination(source, next, end);
      if (!destination.ok) return from;
      next = destination.pos; while (next < end && /\s/.test(source[next])) next++;
      if (source[next] !== ')') { const title = md.helpers.parseLinkTitle(source, next, end); if (!title.ok) return from; next = title.pos; while (next < end && /\s/.test(source[next])) next++; }
      return source[next] === ')' ? next + 1 : from;
    }
    if (source[next] === '[') { const last = source.indexOf(']', next + 1); if (last >= 0 && last < end) return last + 1; }
    return next;
  };
  const mapText = (content: string, start: number, end: number): number[] | undefined => {
    // First use an exact match; then decode only Markdown escapes/entities/line endings.
    const exact = source.indexOf(content, start);
    if (exact >= start && exact + content.length <= end) return Array.from({ length: content.length + 1 }, (_, i) => exact + i);
    let cursor = start; const offsets: number[] = [];
    for (const character of content) {
      let found = false;
      while (cursor < end) {
        const entity = source[cursor] === '&' ? /^&(?:#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]+);/.exec(source.slice(cursor, end)) : null;
        const escaped = source[cursor] === '\\' && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(source[cursor + 1] ?? '');
        const length = entity ? entity[0].length : escaped ? 2 : source.codePointAt(cursor)! > 0xffff ? 2 : source[cursor] === '\r' && source[cursor + 1] === '\n' ? 2 : 1;
        const raw = source.slice(cursor, cursor + length), visible = entity || escaped ? md.utils.unescapeAll(raw) : /\r|\n/.test(raw) ? ' ' : raw;
        if (visible === character || /\s/.test(character) && /^\s+$/.test(visible)) {
          for (let i = 0; i < character.length; i++) offsets.push(cursor + (length === character.length ? i : 0));
          cursor += length; found = true; break;
        }
        cursor += length;
      }
      if (!found) return undefined;
    }
    offsets.push(cursor); return offsets;
  };
  for (const token of tokens) {
    if (token.map && token.nesting === 1) { token.attrSet('data-start', String(lineOffset(token.map[0]))); token.attrSet('data-end', String(lineOffset(token.map[1]))); }
    if (token.type === 'heading_open' && token.map) token.attrSet('id', `heading-${token.map[0]}`);
    if (token.type === 'table_open') { tableIndex++; row = -1; token.attrSet('tabindex', '0'); token.attrSet('data-kind', 'table'); token.attrSet('data-table-id', tables[tableIndex].id); token.attrJoin('class', 'semantic'); }
    if (token.type === 'tr_open') { row++; column = -1; }
    if (token.type === 'td_open' || token.type === 'th_open') {
      column++; token.attrSet('tabindex', '0'); token.attrSet('data-kind', 'table-cell'); token.attrSet('data-table-id', tables[tableIndex].id); token.attrSet('data-row', String(row)); token.attrSet('data-column', String(column)); token.attrJoin('class', 'semantic');
    }
    if (token.type === 'fence' && token.info.trim().split(/\s+/)[0].toLowerCase() === 'mermaid') token.meta = { diagram: diagrams[diagramIndex++], start: lineOffset(token.map![0]), end: lineOffset(token.map![1]) };
    if (token.type === 'inline') {
      const line = token.map?.[0] ?? 0;
      let cursor = inlineCursors.get(line) ?? lineOffset(line); const end = lineOffset(token.map?.[1] ?? source.split(/\r\n|\r|\n/).length);
      for (const child of token.children ?? []) {
        if (child.type === 'text' || child.type === 'code_inline') {
          const offsets = mapText(child.content, cursor, end);
          if (offsets) { cursor = offsets.at(-1)!; const id = `source-${mapId++}`; textMaps.set(id, offsets); child.meta = { sourceId: id }; }
        }
        if (child.type === 'link_close' && !['autolink', 'linkify'].includes(child.markup)) cursor = afterLink(cursor, end);
        if (child.type === 'image') { child.meta = { start: lineOffset(token.map?.[0] ?? 0), end }; cursor = afterLink(cursor, end, true); }
      }
      inlineCursors.set(line, cursor);
    }
  }
  for (const rule of ['text', 'code_inline']) {
    const original = md.renderer.rules[rule];
    md.renderer.rules[rule] = (tokens, i, options, env, self) => {
      const token = tokens[i], text = original ? original(tokens, i, options, env, self) : escapeHtml(token.content);
      return token.meta?.sourceId ? `<span data-source-map="${token.meta.sourceId}">${text}</span>` : text;
    };
  }
  md.renderer.rules.image = (items, index) => {
    const token = items[index], id = stableId('resource', `${document}\0${token.attrGet('src')}`), resource = revision.resources.find(r => r.id === id);
    if (!resource) return '<span class="error">Missing frozen image</span>';
    return `<span class="semantic" tabindex="0" data-kind="image" data-resource-id="${id}" data-start="${token.meta.start}" data-end="${token.meta.end}"><img data-resource="${id}" alt="${escapeHtml(token.content)}"></span>`;
  };
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (items, i, options, env, self) => {
    const t = items[i]; if (!t.meta?.diagram) return fence(items, i, options, env, self);
    return `<figure tabindex="0" class="semantic" data-kind="mermaid" data-diagram-id="${t.meta.diagram.id}" data-start="${t.meta.start}" data-end="${t.meta.end}"><figcaption>Mermaid diagram ${t.meta.diagram.ordinal + 1}</figcaption><div class="diagram">Rendering diagram…</div></figure>`;
  };
  const link = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (items, i, options, env, self) => {
    const t = items[i], href = t.attrGet('href') ?? '';
    if (t.attrGet('title')?.trim().toLowerCase() === 'review:attach') { t.attrSet('data-attachment', stableId('resource', `${document}\0${href}`)); t.attrSet('href', '#'); }
    else if (/^(?:https?:|mailto:)/i.test(href)) { t.attrSet('rel', 'noopener noreferrer'); t.attrSet('target', '_blank'); }
    else { t.attrSet('data-document-link', href); t.attrSet('href', '#'); }
    return link ? link(items, i, options, env, self) : self.renderToken(items, i, options);
  };
  return { html: md.renderer.render(tokens, md.options, {}), textMaps };
}
export function selectionAnchor(host: HTMLElement, rendered: RenderedSource, source: string, document: string, revision: Revision, semantic?: HTMLElement): MarkdownAnchor {
  let start: number, end: number; let target: MarkdownAnchor['target'] = { kind: 'text' };
  if (semantic) {
    const block = semantic.closest<HTMLElement>('[data-start][data-end]') ?? semantic.closest('table');
    start = Number(block?.dataset.start); end = Number(block?.dataset.end);
    const label = semantic.textContent?.trim().slice(0, 120) || semantic.querySelector('img')?.alt || 'Selected target';
    switch (semantic.dataset.kind) {
      case 'image': target = { kind: 'image', resourceId: semantic.dataset.resourceId!, label }; break;
      case 'mermaid': target = { kind: 'mermaid', diagramId: semantic.dataset.diagramId!, label }; break;
      case 'table': target = { kind: 'table', tableId: semantic.dataset.tableId!, label }; break;
      case 'table-cell': target = { kind: 'table-cell', tableId: semantic.dataset.tableId!, row: Number(semantic.dataset.row), column: Number(semantic.dataset.column), label }; break;
    }
  } else {
    const selection = host.ownerDocument.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) throw new Error('Select text in the document or click an image, diagram, table, or cell first.');
    const range = selection.getRangeAt(0);
    const locate = (node: Node, offset: number): number => {
      const span = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-source-map]');
      if (!span || !host.contains(span)) throw new Error('Selection must start and end in mapped document text.');
      const prefix = documentRange(span, node, offset), map = rendered.textMaps.get(span.dataset.sourceMap!);
      const result = map?.[prefix]; if (result === undefined) throw new Error('Selection could not be mapped safely.'); return result;
    };
    start = locate(range.startContainer, range.startOffset); end = locate(range.endContainer, range.endOffset);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.length) throw new Error('The selected target has no exact source range.');
  return { document, documentDigest: revision.documents.find(d => d.path === document)!.digest, range: { start: pointAt(source, start), end: pointAt(source, end) }, quote: { exact: source.slice(start, end), prefix: source.slice(Math.max(0, start - 32), start), suffix: source.slice(end, end + 32) }, target };
}
function documentRange(span: Element, node: Node, offset: number): number { const range = span.ownerDocument.createRange(); range.selectNodeContents(span); range.setEnd(node, offset); return range.toString().length; }
/** CSS annotations retain document DOM, selection, scroll and rendered diagrams. */
export function annotate(host: HTMLElement, rendered: RenderedSource, source: string, events: readonly Event[], document: string): void {
  const commentRanges: Range[] = [], suggestionRanges: Range[] = [];
  const openEdits = new Set(fold(events, events[0]?.revisionId ?? '').suggestions.filter(s => s.open && s.root.operation.kind !== 'insert').map(s => s.root.id));
  host.querySelectorAll('.commented').forEach(e => { e.classList.remove('commented'); e.removeAttribute('data-thread-ids'); });
  for (const event of events) {
    if ((event.type !== 'comment.created' && event.type !== 'suggestion.created') || event.anchor.document !== document) continue;
    if (event.type === 'suggestion.created' && !openEdits.has(event.id)) continue;
    const a = event.anchor; let elements: Element[] = [];
    if (a.target?.kind && a.target.kind !== 'text') {
      const t = a.target, attrs = t.kind === 'image' ? `[data-resource-id="${t.resourceId}"]` : t.kind === 'mermaid' ? `[data-diagram-id="${t.diagramId}"]` : t.kind === 'table-cell' ? `[data-table-id="${t.tableId}"][data-row="${t.row}"][data-column="${t.column}"]` : `table[data-table-id="${t.tableId}"]`;
      elements = [...host.querySelectorAll(attrs)];
    } else {
      const start = offsetAt(source, a.range.start), end = offsetAt(source, a.range.end);
      for (const span of host.querySelectorAll<HTMLElement>('[data-source-map]')) {
        const map = rendered.textMaps.get(span.dataset.sourceMap!)!;
        if (map[0] < end && map.at(-1)! > start) {
          elements.push(span);
          const first = Math.max(0, map.findIndex(offset => offset >= start)), after = map.findIndex(offset => offset >= end), last = after < 0 ? map.length - 1 : after;
          const walker = span.ownerDocument.createTreeWalker(span, NodeFilter.SHOW_TEXT), nodes: Text[] = [];
          while (walker.nextNode()) nodes.push(walker.currentNode as Text);
          const locate = (offset: number): [Text, number] => { for (const node of nodes) { if (offset <= node.length) return [node, offset]; offset -= node.length; } return [nodes.at(-1)!, nodes.at(-1)!.length]; };
          if (nodes.length && last > first) { const range = host.ownerDocument.createRange(); range.setStart(...locate(first)); range.setEnd(...locate(last)); (event.type === 'comment.created' ? commentRanges : suggestionRanges).push(range); }
        }
      }
    }
    if (event.type === 'comment.created') for (const element of elements) { element.classList.add('commented'); const previous = element.getAttribute('data-thread-ids'); element.setAttribute('data-thread-ids', `${previous ? previous + ' ' : ''}${event.threadId}`); element.setAttribute('title', 'Click to open attached review comments'); }
  }
  const api = globalThis as typeof globalThis & { Highlight?: new (...ranges: Range[]) => unknown };
  const registry = (CSS as typeof CSS & { highlights?: Map<string, unknown> }).highlights;
  if (registry && api.Highlight) { registry.set('omr-comments', new api.Highlight(...commentRanges)); registry.set('omr-edits', new api.Highlight(...suggestionRanges)); host.classList.add('exact-highlights'); }
}
