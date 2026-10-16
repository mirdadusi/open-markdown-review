import test from 'node:test';
import assert from 'node:assert/strict';
import { fitPdfImage, fitTableColumns } from '../src/professional/pdfLayout';
import { pdfFontRuns, pdfTextWidth, preparePdfTypography, wrapPdfToken } from '../src/professional/pdfTypography';

test('PDF tables allocate bounded numeric widths without one long identifier expanding all columns', () => {
  for (const width of [120, 505.28, 751.89]) for (const columns of [[30, 300], [200, 35, 35, 35, 35, 300], Array(12).fill(900)]) {
    const fitted = fitTableColumns(columns, width);
    assert.ok(fitted.every(value => Number.isFinite(value) && value > 0));
    assert.ok(fitted.reduce((a, b) => a + b, 0) + columns.length * 8 + (columns.length + 1) * 0.4 <= width + 0.001);
  }
  assert.ok(fitTableColumns([35, 300], 505)[1] > fitTableColumns([35, 300], 505)[0] * 2);
});
test('PDF images preserve proportion, declared size, small graphics and table-cell bounds', () => {
  assert.deepEqual(fitPdfImage(24, 16, 500), { width: 18, height: 12 });
  assert.deepEqual(fitPdfImage(1000, 500, 80, undefined, undefined, true), { width: 80, height: 40 });
  assert.deepEqual(fitPdfImage(1000, 500, 500, 120), { width: 90, height: 45 });
  assert.deepEqual(fitPdfImage(100, 1000, 500), { width: 36, height: 360 });
});
test('PDF fonts retain diacritics, decomposed Unicode, Greek and technical symbols exactly', () => {
  for (const text of ['Příliš žluťoučký kůň', 'Pr\u030ci\u0301lis\u030c', 'αβΓΔ Ω μ µ ± ≤ ≥ ≠ × −', '→ ← ↔ ␣ ✓ ✗', '1\u202f000 kg']) for (const style of [{}, { bold: true }, { italics: true }, { font: 'Mono' }]) {
    const runs = pdfFontRuns(text, style); assert.equal(runs.map(run => run.text).join(''), text);
    assert.ok(pdfTextWidth(text, style) > 0);
  }
  assert.ok(pdfFontRuns('x→␣✓').some(run => run.font === 'Symbols'));
  assert.throws(() => pdfFontRuns('Unsupported: \u{10ffff}'), /U\+10FFFF.*No archive was published/);
});
test('PDF wrapping preserves original Unicode graphemes and applies fallback in identities, tables and replies', () => {
  const token = 'anExtremelyLongMachineIdentifier123'.repeat(4), wrapped = wrapPdfToken(token, 40, { fontSize: 9 });
  assert.equal(wrapped.replaceAll('\u200b', ''), token);
  assert.ok(wrapped.split('\u200b').every(part => pdfTextWidth(part, { fontSize: 9 }) <= 40));
  const node = { stack: [{ text: 'Miroslav → reviewer' }, { table: { widths: [50, 50], body: [[{ text: '␣ ␣ ✓', bold: true }, '→ ␣ ✓']] } }] };
  preparePdfTypography(node); assert.match(JSON.stringify(node), /Symbols/);
  const linked = { text: [{ text: '→ link ␣', linkToDestination: 'target', color: '#2458a6', bold: true }] };
  preparePdfTypography(linked);
  assert.ok(linked.text.every(run => run.linkToDestination === 'target'));
});
