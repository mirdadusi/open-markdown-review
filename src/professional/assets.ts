import mermaid from 'mermaid';
import { digest, toBase64 } from './bytes';
import { LIMITS, Revision, StoredContent } from './types';
import { rasterDimensions } from './imageLimits';
export function sanitizeSvg(svg: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) throw new Error('SVG document types and entity declarations are not permitted.');
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
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
export function renderDiagram(source: string): Promise<string> {
  if (/%%\s*\{|^\s*---/m.test(source)) return Promise.reject(new Error('Mermaid configuration directives/front matter are not supported in the strict review profile. Keep configuration in the trusted renderer.'));
  const key = digest(source), cached = diagrams.get(key); if (cached) return Promise.resolve(cached);
  const result = renderQueue.then(async () => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', htmlLabels: false, flowchart: { htmlLabels: false }, maxTextSize: LIMITS.diagram });
    const rendered = await mermaid.render(`omr_${key.slice(7, 31)}`, source);
    const svg = sanitizeSvg(rendered.svg); diagrams.set(key, svg);
    while (diagrams.size > 100) diagrams.delete(diagrams.keys().next().value!);
    return svg;
  });
  renderQueue = result.catch(() => undefined); return result;
}
export function dataUrl(bytes: Uint8Array, type: string): string {
  return `data:${type};base64,${toBase64(bytes)}`;
}
export async function populateAssets(host: HTMLElement, revision: Revision, read: (c: StoredContent) => Promise<Uint8Array>): Promise<Map<string, string>> {
  const rendered = new Map<string, string>();
  for (const element of host.querySelectorAll<HTMLImageElement>('img[data-resource]')) {
    const resource = revision.resources.find(r => r.id === element.dataset.resource)!;
    let bytes = await read(resource);
    if (resource.mediaType === 'image/svg+xml') {
      const safe = sanitizeSvg(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), root = new DOMParser().parseFromString(safe, 'image/svg+xml').documentElement;
      const width = Number.parseFloat(root.getAttribute('width') ?? '300'), height = Number.parseFloat(root.getAttribute('height') ?? '150');
      if (!Number.isFinite(width * height) || width <= 0 || height <= 0 || width * height > 25000000) throw new Error('SVG intrinsic dimensions exceed the supported limit.');
      bytes = new TextEncoder().encode(safe);
    } else rasterDimensions(bytes, resource.mediaType);
    element.src = dataUrl(bytes, resource.mediaType); await element.decode();
    if (element.naturalWidth * element.naturalHeight > 25000000) throw new Error('Decoded image exceeds 25 million pixels.');
  }
  for (const element of host.querySelectorAll<HTMLElement>('[data-diagram-id]')) {
    const diagram = revision.mermaidDiagrams.find(d => d.id === element.dataset.diagramId); if (!diagram) throw new Error('Missing diagram descriptor.');
    const svg = await renderDiagram(diagram.source); element.querySelector('.diagram')!.innerHTML = svg; rendered.set(diagram.id, svg);
  }
  return rendered;
}
export async function rasterizeSvg(svg: string, maxWidth = 1900): Promise<string> {
  const image = new Image(); image.src = dataUrl(new TextEncoder().encode(sanitizeSvg(svg)), 'image/svg+xml'); await image.decode();
  const ratio = maxWidth / image.naturalWidth, width = Math.max(1, Math.round(image.naturalWidth * ratio)), height = Math.max(1, Math.round(image.naturalHeight * ratio));
  if (!Number.isFinite(width * height) || width * height > 25000000) throw new Error('Diagram raster dimensions exceed the supported limit.');
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  canvas.getContext('2d')!.drawImage(image, 0, 0, width, height); return canvas.toDataURL('image/png');
}
