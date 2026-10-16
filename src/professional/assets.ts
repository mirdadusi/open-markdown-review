import mermaid from 'mermaid';
import { digest, toBase64 } from './bytes';
import { LIMITS, ProtocolError, Revision, StoredContent } from './types';
import { rasterDimensions } from './imageLimits';
import { OperationControl, checkpoint } from './operation';
import { svgWithoutLegacyDoctype } from './svg';
export function sanitizeSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svgWithoutLegacyDoctype(svg), 'image/svg+xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') throw new Error('Invalid SVG.');
  for (const element of doc.querySelectorAll('*')) {
    if (['script', 'foreignObject', 'iframe', 'object', 'embed', 'animate', 'animateMotion', 'animateTransform', 'set'].includes(element.localName)) throw new Error(`Active SVG element is not permitted: ${element.localName}`);
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || /(?:href|src)$/i.test(attribute.name) && !attribute.value.startsWith('#') || /(?:@import|expression\s*\(|url\(\s*['"]?(?!#))/i.test(attribute.value)) throw new Error('Active or externally referenced SVG is not permitted.');
    }
    if (element.localName === 'style' && /\\|@import|url\(\s*['"]?(?!#)/i.test(element.textContent ?? '')) throw new Error('External or escaped SVG stylesheet is not permitted.');
  }
  return new XMLSerializer().serializeToString(doc.documentElement);
}
const diagrams = new Map<string, string>();
let renderQueue: Promise<unknown> = Promise.resolve();
export const MERMAID_RENDER_DEADLINE_MS = 20000;
export interface RenderControl extends OperationControl { deadlineMs?: number }
function bounded<T>(work: Promise<T>, control?: RenderControl): Promise<T> {
  const deadline = control?.deadlineMs ?? MERMAID_RENDER_DEADLINE_MS;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); control?.signal?.removeEventListener('abort', abort); action(); };
    const abort = () => finish(() => reject(new ProtocolError('cancelled', 'Rendering was cancelled. No review evidence was changed.')));
    const timer = setTimeout(() => finish(() => reject(new ProtocolError('unsupported', `Mermaid rendering exceeded the ${Math.ceil(deadline / 1000)}-second client deadline.`))), deadline);
    control?.signal?.addEventListener('abort', abort, { once: true });
    if (control?.signal?.aborted) return abort();
    work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
export function renderDiagram(source: string, control?: RenderControl): Promise<string> {
  if (/%%\s*\{|^\s*---/m.test(source)) return Promise.reject(new Error('Mermaid configuration directives/front matter are not supported in the strict review profile. Keep configuration in the trusted renderer.'));
  const key = digest(source), cached = diagrams.get(key); if (cached) return Promise.resolve(cached);
  const result = renderQueue.then(async () => {
    checkpoint(control, 'Rendering Mermaid diagram…');
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', htmlLabels: false, flowchart: { htmlLabels: false }, maxTextSize: LIMITS.diagram });
    const rendered = await mermaid.render(`omr_${key.slice(7, 31)}`, source);
    checkpoint(control);
    const svg = sanitizeSvg(rendered.svg); diagrams.set(key, svg);
    while (diagrams.size > 100) diagrams.delete(diagrams.keys().next().value!);
    return svg;
  });
  // Keep the underlying renderer serialized even when the caller times out or
  // cancels. This prevents a late Mermaid task from overlapping a newer one.
  renderQueue = result.catch(() => undefined); return bounded(result, control);
}
export function dataUrl(bytes: Uint8Array, type: string): string {
  return `data:${type};base64,${toBase64(bytes)}`;
}
export async function populateAssets(host: HTMLElement, revision: Revision, read: (c: StoredContent) => Promise<Uint8Array>, control?: RenderControl): Promise<Map<string, string>> {
  const rendered = new Map<string, string>();
  for (const element of host.querySelectorAll<HTMLImageElement>('img[data-resource]')) {
    checkpoint(control, 'Loading frozen image…');
    const resource = revision.resources.find(r => r.id === element.dataset.resource)!;
    try {
      let bytes = await read(resource);
      if (resource.mediaType === 'image/svg+xml') {
        const safe = sanitizeSvg(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), root = new DOMParser().parseFromString(safe, 'image/svg+xml').documentElement;
        const width = Number.parseFloat(root.getAttribute('width') ?? '300'), height = Number.parseFloat(root.getAttribute('height') ?? '150');
        if (!Number.isFinite(width * height) || width <= 0 || height <= 0 || width * height > 25000000) throw new Error('SVG intrinsic dimensions exceed the supported limit.');
        bytes = new TextEncoder().encode(safe);
      } else rasterDimensions(bytes, resource.mediaType);
      element.src = dataUrl(bytes, resource.mediaType); await bounded(element.decode(), control);
      if (element.naturalWidth * element.naturalHeight > 25000000) throw new Error('Decoded image exceeds 25 million pixels.');
    } catch (error) {
      if (error instanceof ProtocolError && error.code === 'cancelled') throw error;
      throw new Error(`Cannot render image ${resource.originalReference} in ${resource.document}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const element of host.querySelectorAll<HTMLElement>('[data-diagram-id]')) {
    checkpoint(control, 'Rendering Mermaid diagram…');
    const diagram = revision.mermaidDiagrams.find(d => d.id === element.dataset.diagramId); if (!diagram) throw new Error('Missing diagram descriptor.');
    const svg = await renderDiagram(diagram.source, control); element.querySelector('.diagram')!.innerHTML = svg; rendered.set(diagram.id, svg);
  }
  return rendered;
}
export async function rasterizeSvg(svg: string, maxWidth = 1900, control?: RenderControl): Promise<string> {
  checkpoint(control);
  const image = new Image(); image.src = dataUrl(new TextEncoder().encode(sanitizeSvg(svg)), 'image/svg+xml'); await bounded(image.decode(), control);
  checkpoint(control);
  const ratio = maxWidth / image.naturalWidth, width = Math.max(1, Math.round(image.naturalWidth * ratio)), height = Math.max(1, Math.round(image.naturalHeight * ratio));
  if (!Number.isFinite(width * height) || width * height > 25000000) throw new Error('Diagram raster dimensions exceed the supported limit.');
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  canvas.getContext('2d')!.drawImage(image, 0, 0, width, height); return canvas.toDataURL('image/png');
}
