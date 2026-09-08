import { escapeHtml as esc, RenderedSource } from '../rendering';
import { Slide, SlidevProfile } from './slidev';
import { Revision } from '../types';

/** Escaped source remains selectable with exact UTF-16 offsets; it is never evaluated. */
export function sourceView(source: string, start = 0, end = source.length): RenderedSource {
  const maps = new Map<string, number[]>(), parts: string[] = [];
  const text = source.slice(start, end); let offset = start;
  for (const [index, match] of [...text.matchAll(/[^\n]*\n|[^\n]+$/g)].entries()) {
    const line = match[0], key = `slide-source-${index}`;
    const map: number[] = [];
    for (let i = 0; i < line.length; i++) { map.push(offset + i); if (line[i] === '\r' && line[i + 1] === '\n') i++; }
    map.push(offset + line.length); maps.set(key, map);
    parts.push(`<span data-source-map="${key}">${esc(line.replace(/\r\n/g, '\n'))}</span>`); offset += line.length;
  }
  return { html: `<pre class="slide-source"><code>${parts.join('')}</code></pre>`, textMaps: maps };
}
export function renderSlide(profile: SlidevProfile, slide: Slide, source: string): RenderedSource {
  const rendered = sourceView(source, slide.range.start, slide.range.end);
  // Whole-slide comments are existing semantic image anchors, with a short exact
  // source quote. The image resource ID distinguishes repeated import occurrences.
  const start = slide.contentRange.start < slide.contentRange.end ? slide.contentRange.start : slide.range.start;
  let end = Math.min(slide.range.end, start + 200);
  const lineEnd = source.indexOf('\n', start); if (lineEnd > start) end = Math.min(end, lineEnd);
  if (source[end - 1] === '\r') end--;
  if (/^[\uDC00-\uDFFF]$/.test(source[end] ?? '')) end--;
  const previous = profile.slides[slide.number - 2], next = profile.slides[slide.number];
  rendered.html = `<nav class="slide-navigation" aria-label="Slide navigation"><button data-slide="${previous?.id ?? ''}" ${previous ? '' : 'disabled'}>← Previous</button><strong>Slide ${slide.number} / ${profile.slides.length} · ${esc(slide.title)}</strong><button data-slide="${next?.id ?? ''}" ${next ? '' : 'disabled'}>Next →</button></nav>
    <p class="profile-notice">Frozen Slidev ${esc(profile.rendererVersion)} export · static view, not an interactive presentation. Click the slide to attach a visual comment; select source text below for precise edits.</p>
    <figure class="semantic slide-preview" tabindex="0" data-kind="image" data-resource-id="${slide.previewResourceId}" data-start="${start}" data-end="${end}"><img data-resource="${slide.previewResourceId}" alt="Slide ${slide.number}: ${esc(slide.title)}"><figcaption>Slide ${slide.number}: ${esc(slide.title)} · ${esc(slide.id)}</figcaption><button data-zoom="${slide.id}">Zoom slide</button></figure>
    <details open class="slide-source-panel"><summary>Reviewed source · ${esc(slide.document)} · notes ${profile.notes}</summary>${rendered.html}</details>
    <details class="profile-notice"><summary>Capture scope and limitations</summary><ul>${profile.limitations.map(v => `<li>${esc(v)}</li>`).join('')}</ul></details>`;
  return rendered;
}
export function frozenReferenceLinks(revision: Revision, document: string): string {
  const resources = revision.resources.filter(r => r.document === document && !r.originalReference.startsWith('urn:open-markdown-review:profile:'));
  const references = revision.externalReferences.filter(r => r.document === document && /^https?:\/\//.test(r.uri));
  if (!resources.length && !references.length) return '';
  return `<details class="profile-notice"><summary>Frozen images, attachments and external references</summary><ul>${resources.map(r => `<li><a href="#" data-attachment="${r.id}">${esc(r.originalReference)}</a> · frozen ${esc(r.mediaType)}</li>`).join('')}${references.map(r => `<li><a href="${esc(r.uri)}" target="_blank" rel="noopener noreferrer">${esc(r.uri)}</a> · external, not archived</li>`).join('')}</ul></details>`;
}
