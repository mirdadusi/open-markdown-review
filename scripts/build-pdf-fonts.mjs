import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
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
const generate = process.argv[2] === '--generate';
if (process.argv.length > (generate ? 3 : 2) || process.argv[2] && !generate) throw new Error('Use --generate only for an intentional font asset update; default mode verifies committed bytes.');
const output = 'src/professional/generated/pdf-fonts.json';
const frozen = generate ? undefined : JSON.parse(await readFile(output, 'utf8'));
const metrics = {}, vfsGzip = {}, sources = {};
for (const [name, file] of Object.entries(files)) {
  const bytes = await readFile(file), font = fontkit.create(bytes);
  metrics[name] = Object.fromEntries(font.characterSet.map(point => [point, Math.round(font.glyphForCodePoint(point).advanceWidth / font.unitsPerEm * 10000) / 10000]));
  sources[name] = createHash('sha256').update(bytes).digest('hex');
  if (!name.startsWith('Roboto-')) {
    if (generate) vfsGzip[name] = gzipSync(bytes, { level: 9 }).toString('base64');
    else {
      // gzip headers identify the producing OS. Recompression during ordinary
      // builds changes the toolbox/SEA digest on macOS, Linux and Windows even
      // when the decoded font is identical. Validate the versioned bytes instead.
      if (typeof frozen.vfsGzip[name] !== 'string' || !gunzipSync(Buffer.from(frozen.vfsGzip[name], 'base64'), { maxOutputLength: bytes.length }).equals(bytes)) throw new Error(`Frozen PDF font differs: ${name}. Review source bytes before explicitly regenerating assets.`);
    }
  }
}
if (generate) {
  await mkdir('src/professional/generated', { recursive: true });
  await writeFile(output, JSON.stringify({ metrics, vfsGzip, sources }) + '\n');
  console.log('Generated versioned PDF font coverage, compressed bytes and metrics. Rebuild/re-pin all client artifacts.');
} else {
  if (JSON.stringify(frozen.metrics) !== JSON.stringify(metrics) || JSON.stringify(frozen.sources) !== JSON.stringify(sources)) throw new Error('PDF font source digests/metrics changed. Review and explicitly regenerate the versioned assets.');
  console.log('Verified frozen PDF font bytes, coverage and advance metrics without recompression.');
}
