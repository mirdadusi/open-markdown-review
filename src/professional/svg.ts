import { fromBase64 } from './bytes';
import { rasterDimensions } from './imageLimits';
import { LIMITS } from './types';

/** Rendering-only compatibility; frozen SVG bytes and their digests never change. */
export const SVG_SANITIZER_VERSION = 'omr-svg-static-3';

/** A deliberately closed CSS subset: no fetches, escapes or comment obfuscation. */
export function validateSvgCss(value: string): void {
  if (/\\|\/\*|@import|expression\s*\(/i.test(value)) throw new Error('SVG CSS escapes, comments, imports and expressions are not permitted.');
  const urls = /url\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = urls.exec(value))) {
    // Consume the whole function, not an optional quote followed by a negative
    // lookahead: regex backtracking previously rejected safe quoted fragments.
    const local = /^\s*(?:"#[^"\s()<>]+"|'#[^'\s()<>]+'|#[^\s"'()<>]+)\s*\)/.exec(value.slice(urls.lastIndex));
    if (!local) throw new Error('SVG CSS URL must reference a nonempty fragment inside the same SVG.');
    urls.lastIndex += local[0].length;
  }
}

export function svgEmbeddedRaster(reference: string): { uri: string; byteLength: number; pixels: number } {
  const comma = reference.indexOf(','), header = reference.slice(0, comma);
  if (comma < 0 || !/^data:image\/(?:png|jpeg|gif|webp);base64$/i.test(header)) throw new Error('SVG embedded images must be base64 PNG, JPEG, GIF or WebP, not SVG, HTML or external resources.');
  // Inkscape emits XML character references for line breaks in long base64
  // attributes. DOMParser has already decoded those; only ASCII whitespace is
  // removed. No URL decoding, MIME parameters or nested data documents.
  if (reference.length - comma - 1 > LIMITS.resource * 2) throw new Error('SVG embedded image exceeds the encoded byte limit.');
  const payload = reference.slice(comma + 1).replace(/[\t\n\f\r ]/g, '');
  if (!payload.length || payload.length > 4 * Math.ceil(LIMITS.resource / 3)) throw new Error('SVG embedded image exceeds the byte limit or is empty.');
  let bytes: Uint8Array;
  try { bytes = fromBase64(payload); } catch { throw new Error('SVG embedded image has malformed base64.'); }
  if (bytes.length > LIMITS.resource) throw new Error('SVG embedded image exceeds the byte limit.');
  const mediaType = header.slice(5, -7).toLowerCase();
  const ascii = (start: number, count: number) => String.fromCharCode(...bytes.subarray(start, start + count));
  const signature = mediaType === 'image/png' ? ascii(0, 8) === '\x89PNG\r\n\x1a\n'
    : mediaType === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : mediaType === 'image/gif' ? /^GIF8[79]a$/.test(ascii(0, 6))
    : ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
  if (!signature) throw new Error('SVG embedded image bytes do not match the declared raster MIME type.');
  const { width, height } = rasterDimensions(bytes, mediaType);
  return { uri: `data:${mediaType};base64,${payload}`, byteLength: bytes.length, pixels: width * height };
}
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
