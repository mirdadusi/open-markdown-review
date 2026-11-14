/** Synthetic fixture only: never copy participant documents/images into tests. */
export const embeddedPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
export function staticRasterSvg(width = 240, height = 80): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><linearGradient id="local"><stop stop-color="#2458a6"/><stop offset="1" stop-color="#3d8260"/></linearGradient></defs>
<rect width="${width}" height="${height}" fill="url('#local')"/>
<image width="${width / 2}" height="${height}" xlink:href="data:image/png;base64,${embeddedPng.slice(0, 44)}&#10;${embeddedPng.slice(44)}&#10;"/>
</svg>`;
}
