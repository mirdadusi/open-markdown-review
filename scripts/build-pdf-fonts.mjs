import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import * as fontkit from 'fontkit';

// Checked-in font bytes, no network or host-installed fonts during a build/export.
const files = {
  'Roboto-Regular.ttf': 'node_modules/pdfmake/fonts/Roboto/Roboto-Regular.ttf',
  'Roboto-Medium.ttf': 'node_modules/pdfmake/fonts/Roboto/Roboto-Medium.ttf',
  'Roboto-Italic.ttf': 'node_modules/pdfmake/fonts/Roboto/Roboto-Italic.ttf',
  'Roboto-MediumItalic.ttf': 'node_modules/pdfmake/fonts/Roboto/Roboto-MediumItalic.ttf',
  'NotoSansSymbols2-Regular.ttf': 'third-party/fonts/NotoSansSymbols2-Regular.ttf',
  'NotoSansMono-Regular.ttf': 'third-party/fonts/NotoSansMono-Regular.ttf',
};
const metrics = {}, vfsGzip = {}, sources = {};
for (const [name, file] of Object.entries(files)) {
  const bytes = await readFile(file), font = fontkit.create(bytes);
  metrics[name] = Object.fromEntries(font.characterSet.map(point => [point, Math.round(font.glyphForCodePoint(point).advanceWidth / font.unitsPerEm * 10000) / 10000]));
  sources[name] = createHash('sha256').update(bytes).digest('hex');
  if (!name.startsWith('Roboto-')) vfsGzip[name] = gzipSync(bytes, { level: 9 }).toString('base64');
}
await mkdir('src/professional/generated', { recursive: true });
await writeFile('src/professional/generated/pdf-fonts.json', JSON.stringify({ metrics, vfsGzip, sources }) + '\n');
console.log('Built offline PDF font coverage and advance metrics.');
