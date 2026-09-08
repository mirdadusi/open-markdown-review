import { ProtocolError } from './types';

/** Header-only limits run before the browser decoder allocates raster pixels. */
export function rasterDimensions(bytes: Uint8Array, mediaType: string): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, count: number) => String.fromCharCode(...bytes.subarray(offset, offset + count));
  let width = 0, height = 0;
  try {
    if (mediaType === 'image/png' && text(1, 3) === 'PNG' && text(12, 4) === 'IHDR') { width = view.getUint32(16); height = view.getUint32(20); }
    else if (mediaType === 'image/gif' && /^GIF8[79]a$/.test(text(0, 6))) { width = view.getUint16(6, true); height = view.getUint16(8, true); }
    else if (mediaType === 'image/jpeg' && view.getUint16(0) === 0xffd8) {
      let i = 2;
      while (i < bytes.length) {
        if (bytes[i++] !== 0xff) break;
        while (bytes[i] === 0xff) i++;
        const marker = bytes[i++]; if (marker === 0xd9 || marker === 0xda) break;
        if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
        const size = view.getUint16(i); if (size < 2 || i + size > bytes.length) break;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) { height = view.getUint16(i + 3); width = view.getUint16(i + 5); break; }
        i += size;
      }
    } else if (mediaType === 'image/webp' && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
      const kind = text(12, 4);
      if (kind === 'VP8X') { width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16); height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16); }
      if (kind === 'VP8L' && bytes[20] === 0x2f) { const bits = view.getUint32(21, true); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
      if (kind === 'VP8 ' && text(23, 3) === '\x9d\x01\x2a') { width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff; }
    }
  } catch { /* Truncated or malformed header is rejected below. */ }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new ProtocolError('invalid', `Cannot verify image dimensions: ${mediaType}`);
  if (width * height > 25000000) throw new ProtocolError('unsupported', 'Image exceeds 25 million pixels before decoding.');
  return { width, height };
}
