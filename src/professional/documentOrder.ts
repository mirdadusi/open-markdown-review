import MarkdownIt from 'markdown-it';
import { scanHtml, attribute } from './html';

export const DOCUMENT_ORDER_PROFILE = 'omr-document-order-v1';
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const integer = (value: string) => value.replace(/^0+(?=\d)/, '');
function numeric(a: string, b: string) { a = integer(a); b = integer(b); return a.length - b.length || compare(a, b); }
function natural(a: string, b: string): number {
  const x = a.split(/(\d+)/), y = b.split(/(\d+)/);
  for (let i = 0; i < Math.min(x.length, y.length); i++) { const n = /^\d+$/.test(x[i]) && /^\d+$/.test(y[i]) ? numeric(x[i], y[i]) : compare(x[i], y[i]); if (n) return n; }
  return x.length - y.length || compare(a, b);
}
function chapter(value: string) {
  const match = value.trim().match(/^(\d+(?:[._-]\d+)*)(?:[._-]?([a-z]))?(?=[.\s_-]|$)/i);
  return match ? { parts: match[1].split(/[._-]/), suffix: (match[2] ?? '').toLowerCase() } : undefined;
}
function compareChapter(a: NonNullable<ReturnType<typeof chapter>>, b: NonNullable<ReturnType<typeof chapter>>) {
  for (let i = 0; i < Math.min(a.parts.length, b.parts.length); i++) { const n = numeric(a.parts[i], b.parts[i]); if (n) return n; }
  return a.parts.length - b.parts.length || compare(a.suffix, b.suffix);
}
/** Frozen presentation only. Never mutates the canonical inventory or follows a link on disk/network. */
export function documentOrder(paths: readonly string[], root: string, rootSource = ''): string[] {
  const scope = new Set(paths), hints = new Map<string, { rank: number; chapter?: ReturnType<typeof chapter> }>();
  const parser = new MarkdownIt({ html: true }), base = `https://review.invalid/${root.split('/').map(encodeURIComponent).join('/')}`;
  const add = (href: string, label = '') => {
    if (!href || /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/\/)/.test(href) || href.includes('\\')) return;
    try {
      // URL resolution clamps above-root traversal; reject it rather than
      // accidentally treating ../a.md as an in-scope root-level a.md.
      const segments = href.startsWith('/') ? [] : root.split('/').slice(0, -1);
      for (const raw of href.split(/[?#]/, 1)[0].split('/')) {
        const segment = decodeURIComponent(raw);
        if (/[\\/\x00-\x1f]/.test(segment)) return;
        if (segment === '..') { if (!segments.length) return; segments.pop(); }
        else if (segment && segment !== '.') segments.push(segment);
      }
      const url = new URL(href, base), path = decodeURIComponent(url.pathname.slice(1));
      if (url.origin !== 'https://review.invalid' || !scope.has(path) || path === root || hints.has(path)) return;
      hints.set(path, { rank: hints.size, chapter: chapter(label) });
    } catch { /* Malformed/out-of-scope references do not influence order. */ }
  };
  const html = (source: string) => { for (const part of scanHtml(source)) if (part.kind === 'tag' && part.name === 'a' && !part.closing && attribute(part, 'title')?.toLowerCase() !== 'review:attach') add(parser.utils.unescapeAll(attribute(part, 'href') ?? '')); };
  if (rootSource) for (const token of parser.parse(rootSource, {})) {
    if (token.type === 'html_block') html(token.content);
    const children = token.children ?? [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i]; if (child.type === 'html_inline') html(child.content);
      if (child.type !== 'link_open' || child.attrGet('title')?.toLowerCase() === 'review:attach') continue;
      let label = ''; for (let j = i + 1; j < children.length && children[j].type !== 'link_close'; j++) if (['text', 'code_inline'].includes(children[j].type)) label += children[j].content;
      add(child.attrGet('href') ?? '', label);
    }
  }
  const entries = [...scope].filter(path => path !== root).map(path => ({ path, hint: hints.get(path), chapter: hints.get(path)?.chapter ?? chapter(path.split('/').at(-1)!) }));
  // An explicitly linked unnumbered index uses its author's link sequence.
  // Otherwise numeric chapter keys work across folders (sections/1 before features/3).
  const indexOrder = entries.some(entry => entry.hint && !entry.chapter);
  entries.sort((a, b) => {
    if (indexOrder) {
      const rank = (a.hint?.rank ?? Number.MAX_SAFE_INTEGER) - (b.hint?.rank ?? Number.MAX_SAFE_INTEGER); if (rank) return rank;
    }
    if (a.chapter && b.chapter) { const n = compareChapter(a.chapter, b.chapter); if (n) return n; }
    else if (a.chapter || b.chapter) return a.chapter ? -1 : 1;
    return (a.hint?.rank ?? Number.MAX_SAFE_INTEGER) - (b.hint?.rank ?? Number.MAX_SAFE_INTEGER) || natural(a.path, b.path);
  });
  return [...(scope.has(root) ? [root] : []), ...entries.map(entry => entry.path)];
}
