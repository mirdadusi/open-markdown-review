/** Rendering-only compatibility; frozen SVG bytes and their digests never change. */
export const SVG_SANITIZER_VERSION = 'omr-svg-static-2';
const publicDtds = new Map([
  ['-//W3C//DTD SVG 1.0//EN', 'www.w3.org/TR/2001/REC-SVG-20010904/DTD/svg10.dtd'],
  ['-//W3C//DTD SVG 1.1//EN', 'www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd'],
]);
export function svgWithoutLegacyDoctype(svg: string): string {
  const denied = () => { throw new Error('SVG document types and entity declarations are not permitted, except a standard SVG 1.0/1.1 public declaration without an internal subset.'); };
  if (/<!ENTITY/i.test(svg)) return denied();
  if (!/<!DOCTYPE/i.test(svg)) return svg;
  // Only one declaration in the XML prolog is eligible. Unknown DTDs, SYSTEM
  // declarations, internal subsets and entity definitions never reach DOMParser.
  const prefix = /^(?:\uFEFF)?\s*(?:<\?xml\s[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*/.exec(svg)![0];
  const declaration = /^<!DOCTYPE\s+svg\s+PUBLIC\s+(["'])([^"']+)\1\s+(["'])([^"'<>\[\]]+)\3\s*>/.exec(svg.slice(prefix.length));
  if (!declaration || !publicDtds.has(declaration[2]) || !['http://', 'https://'].some(scheme => declaration[4] === scheme + publicDtds.get(declaration[2]))) return denied();
  const normalized = prefix + svg.slice(prefix.length + declaration[0].length);
  if (/<!DOCTYPE|<!ENTITY/i.test(normalized)) return denied();
  return normalized;
}
