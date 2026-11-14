import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(import.meta.url);
const { parsePdfTemplate, selectPdfTemplate, pdfTemplateStyle } = require('../out/src/professional/pdfTemplate.js');
const guidePath = path.join(root, 'docs/CREATE-PDF-TEMPLATE.md');
const guide = await readFile(guidePath, 'utf8');
const starter = parsePdfTemplate(await readFile(path.join(root, 'examples/pdf-template.json')));

test('template authoring guide links to a complete starter that validates with its documented input', () => {
  assert.match(guide, /\.\.\/examples\/pdf-template\.json/);
  assert.throws(() => selectPdfTemplate({ customTemplate: starter }), /Specification number is required/);
  const selected = selectPdfTemplate({ customTemplate: starter, metadata: { documentId: 'DOC-123' } });
  assert.equal(selected.metadata.documentId, 'DOC-123');
});

test('every JSON and token-CSS fragment in the template guide conforms to the real contract', () => {
  const blocks = [...guide.matchAll(/^```json\r?\n([\s\S]*?)^```/gm)];
  assert.equal(blocks.length, 4, 'Cover section, page fields, defaults and logo fragments must remain executable examples.');
  for (const [, text] of blocks) {
    const value = JSON.parse(text);
    const template = Array.isArray(value) ? { ...starter, pageFields: value }
      : Array.isArray(value.fields) ? { ...starter, coverSections: [value] }
      : value.logoSvg ? { ...starter, ...value }
      : { ...starter, defaults: value };
    assert.ok(selectPdfTemplate({ customTemplate: template, metadata: { documentId: 'DOC-123' } }));
  }
  const styles = [...guide.matchAll(/^```css\r?\n([\s\S]*?)^```/gm)];
  assert.equal(styles.length, 1);
  for (const [, css] of styles) assert.ok(pdfTemplateStyle(css));
});

test('template authoring guide local links resolve, including linked heading anchors', async () => {
  for (const [, target] of guide.matchAll(/\]\(([^)]+)\)/g)) {
    assert.ok(!/^[a-z]+:/i.test(target), 'This neutral guide should use local reference links.');
    const [relative, anchor] = target.split('#'), filename = path.resolve(path.dirname(guidePath), relative);
    assert.ok((await stat(filename)).isFile(), target);
    if (anchor) {
      const text = await readFile(filename, 'utf8');
      const headings = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, label]) => label.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-'));
      assert.ok(headings.includes(anchor), target);
    }
  }
});
