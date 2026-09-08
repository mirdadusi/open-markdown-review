import { parseSync, extractImagesUsage } from '@slidev/parser/core';
import { parseDocument } from 'yaml';
import { encode, safePath } from '../bytes';
import { LIMITS, ProtocolError } from '../types';
import { Slide, SourceRange, slideIdentity } from './slidev';

export interface ParsedSlide {
  index: number; title: string; range: SourceRange; contentRange: SourceRange; noteRange?: SourceRange;
  frontmatter: Record<string, unknown>; images: string[];
}
/** Only the pure parser is used, never a project's preparsers or Vue evaluation. */
export function parseSlidev(source: string, document: string): ParsedSlide[] {
  if (encode(source).length > LIMITS.markdown || /\r(?!\n)/.test(source)) throw new ProtocolError('unsupported', 'Slidev sources require LF or CRLF and at most 2 MiB.');
  const offsets = [0, ...[...source.matchAll(/\n/g)].map(m => m.index! + 1)];
  const parsed = parseSync(source, document, { preserveCR: true, noParseYAML: true });
  if (parsed.slides.length > 200) throw new ProtocolError('unsupported', 'Slidev profile supports at most 200 slides.');
  return parsed.slides.map(slide => {
    const yaml = parseDocument(slide.frontmatterRaw ?? '', { uniqueKeys: true, schema: 'failsafe' });
    if (yaml.errors.length || yaml.warnings.length) throw new ProtocolError('invalid', `Invalid or unsupported Slidev YAML in ${document}: ${[...yaml.errors, ...yaml.warnings][0].message}`);
    const frontmatter = (yaml.toJS({ maxAliasCount: 0 }) ?? {}) as Record<string, unknown>;
    if (!frontmatter || Array.isArray(frontmatter) || typeof frontmatter !== 'object') throw new ProtocolError('invalid', 'Slidev frontmatter must be a mapping.');
    // Custom preparsing can reorder or rewrite slides, invalidating the source map.
    if (frontmatter.addons || frontmatter.preparser) throw new ProtocolError('unsupported', 'Slidev addons/preparsers are not supported by the v1 source-mapping profile.');
    const range = { start: offsets[slide.start] ?? source.length, end: Math.min(source.length, offsets[slide.end] ?? source.length) };
    let start = offsets[slide.contentStart] ?? range.start;
    // YAML code-block frontmatter is also part of Slidev syntax.
    if (slide.frontmatterStyle === 'yaml') { const raw = source.slice(start, range.end), block = /^\s*```ya?ml[^\n]*\r?\n[\s\S]*?```\s*/.exec(raw); if (block) start += block[0].length; }
    let end = range.end;
    let noteRange: SourceRange | undefined;
    if (slide.note !== undefined) {
      const raw = source.slice(start, end), note = /<!--[\s\S]*?-->\s*$/.exec(raw);
      // Locate the last complete comment, not an earlier comment followed by prose.
      const comments = [...raw.matchAll(/<!--[\s\S]*?-->/g)], last = comments.at(-1);
      if (note && last && !raw.slice(last.index! + last[0].length).trim()) { noteRange = { start: start + last.index!, end: start + last.index! + last[0].length }; end = noteRange.start; }
    }
    while (start < end && /\s/.test(source[start])) start++;
    while (end > start && /\s/.test(source[end - 1])) end--;
    const titleValue = frontmatter.title ?? frontmatter.name ?? /^#+\s+(.+)$/m.exec(source.slice(start, end))?.[1];
    return { index: slide.index, title: typeof titleValue === 'string' ? titleValue.slice(0, 200) : `Slide ${slide.index + 1}`, range, contentRange: { start, end }, noteRange, frontmatter, images: extractImagesUsage(source.slice(start, end), frontmatter) };
  });
}
export function redactNotes(source: string, slides: ParsedSlide[]): string {
  for (const slide of [...slides].reverse()) if (slide.noteRange) {
    const { start, end } = slide.noteRange;
    source = source.slice(0, start) + source.slice(start, end).replace(/[^\r\n]/g, ' ') + source.slice(end);
  }
  return source;
}
export interface SlidevSources {
  documents: Map<string, string>; parsed: Map<string, ParsedSlide[]>;
  slides: Array<Omit<Slide, 'documentDigest' | 'previewResourceId'>>;
}
/** Resolve a portable relative path without ever interpreting URLs or escaping the source root. */
export function importedPath(owner: string, reference: string): { document: string; range?: string } {
  if (/^[a-z]+:|^[/\\]|\\/i.test(reference)) throw new ProtocolError('permission', 'Slidev imports must be relative Markdown files inside the source folder.');
  const [file, range, extra] = reference.split('#');
  if (extra !== undefined || !file || !/\.md$/i.test(file) || file.includes('?')) throw new ProtocolError('invalid', 'Invalid Slidev Markdown import.');
  const parts = owner.split('/').slice(0, -1);
  for (const part of decodeURIComponent(file).split('/')) { if (part === '..') { if (!parts.length) throw new ProtocolError('permission', 'Slidev import escapes the source folder.'); parts.pop(); } else if (part && part !== '.') parts.push(part); }
  return { document: safePath(parts.join('/')), range };
}
function selectedIndices(range: string | undefined, length: number): number[] {
  if (range === undefined) return Array.from({ length }, (_, i) => i);
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(range)) throw new ProtocolError('invalid', 'Slidev import range must be a comma-separated list of slide numbers or inclusive ranges.');
  const result = new Set<number>();
  for (const part of range.split(',')) { const [a, last] = part.split('-').map(Number), b = last ?? a; if (a < 1 || b < a || b > length) throw new ProtocolError('invalid', 'Slidev import range is outside the imported document.'); for (let i = a; i <= b; i++) result.add(i - 1); }
  return [...result].sort((a, b) => a - b);
}
export async function collectSlidev(entry: string, read: (document: string) => Promise<string>): Promise<SlidevSources> {
  safePath(entry);
  const documents = new Map<string, string>(), parsed = new Map<string, ParsedSlide[]>(), slides: SlidevSources['slides'] = [];
  async function visit(document: string, parents: string[], occurrence: number[], selection?: string): Promise<void> {
    if (parents.includes(document) || parents.length >= 16) throw new ProtocolError('invalid', 'Cyclic or excessively deep Slidev imports.');
    if (!documents.has(document)) { const source = await read(document); documents.set(document, source); parsed.set(document, parseSlidev(source, document)); }
    if (documents.size > LIMITS.documents) throw new ProtocolError('unsupported', 'Too many imported Markdown files.');
    const fileSlides = parsed.get(document)!;
    for (const index of selectedIndices(selection, fileSlides.length)) {
      const slide = fileSlides[index], chain = [...occurrence, index];
      if (slide.frontmatter.src !== undefined) {
        if (typeof slide.frontmatter.src !== 'string') throw new ProtocolError('invalid', 'Slidev src must be a string.');
        const imported = importedPath(document, slide.frontmatter.src); await visit(imported.document, [...parents, document], chain, imported.range);
      } else {
        if (String(slide.frontmatter.disabled).toLowerCase() === 'true' || String(slide.frontmatter.hide).toLowerCase() === 'true') throw new ProtocolError('unsupported', 'Disabled/hidden slides must be removed before capture; they make export-to-source numbering ambiguous.');
        if (slide.range.start === slide.range.end) continue;
        slides.push({ id: slideIdentity(document, chain), number: slides.length + 1, title: slide.title, document, sourceIndex: index, occurrence: chain, range: slide.range, contentRange: slide.contentRange, ...(slide.noteRange ? { noteRange: slide.noteRange } : {}) });
        if (slides.length > 200) throw new ProtocolError('unsupported', 'Slidev profile supports at most 200 expanded slides.');
      }
    }
  }
  await visit(entry, [], []);
  if (!slides.length) throw new ProtocolError('invalid', 'Slidev entry has no reviewable slides.');
  return { documents, parsed, slides };
}
