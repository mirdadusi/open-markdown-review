import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePdfTemplate, pdfTemplatePresets, pdfTemplateStyle, selectPdfTemplate, assertPdfTemplateRecovery, validatePdfRenderInput, validatePdfTemplate, pdfTemplateForm, PdfTemplate } from '../src/professional/pdfTemplate';
import { exportTemplateReceipt, PDF_TEMPLATE_PROFILE } from '../src/professional/pdfTemplateReceipt';
import { digest, encode, jsonBytes } from '../src/professional/bytes';
import { blobEvidence } from '../src/professional/storage';
import { AuditInventory } from '../src/professional/types';
import registry from '../release/pdf-templates.json';

const template: PdfTemplate = { schemaVersion: 'omr-pdf-template/1', id: 'Neutral', label: 'Neutral template', version: '1.0.0', distribution: 'all', cover: true, css: ':root { --text-color: #000000; --body-size: 11pt; --margin-left: 15mm; }' };
test('Default is unchanged and rejects misleading cover metadata', () => {
  assert.equal(selectPdfTemplate(), undefined); assert.equal(selectPdfTemplate({ templateId: 'Default' }), undefined);
  assert.throws(() => selectPdfTemplate({ metadata: { status: 'Approved' } }), /Default/);
  assert.throws(() => selectPdfTemplate({ templateId: 'missing' }), /unavailable/);
});
test('Default cover is an explicit option and stays distinct from the unchanged Default export', () => {
  assert.equal(selectPdfTemplate({ includeCover: false }), undefined);
  const result = selectPdfTemplate({ includeCover: true, metadata: { project: 'User project', product: 'User product', title: 'User title', author: 'User author' } })!;
  assert.equal(result.template.label, 'Default'); assert.equal(result.template.cover, true);
  assert.deepEqual(result.template.coverSections!.map(section => section.title), ['Project / Product', 'Document']);
  assert.equal(result.metadata.project, 'User project'); validatePdfRenderInput(result.bytes, result.digest);
  assert.throws(() => assertPdfTemplateRecovery(undefined, result), /different template/);
  assert.throws(() => selectPdfTemplate({ includeCover: 'yes' } as never), /must be true or false/);
  const imported = selectPdfTemplate({ customTemplate: template, includeCover: false })!; assert.equal(imported.template.cover, false);
});
test('PDF templates copy known fields and bind all metadata and asset bytes', () => {
  const options = { customTemplate: { ...template }, metadata: { title: ' Příliš žluťoučký ', version: '2' } };
  const first = selectPdfTemplate(options)!;
  assert.equal(first.metadata.title, 'Příliš žluťoučký'); assert.equal(first.style.bodySize, 11);
  options.customTemplate.label = 'Changed'; assert.equal(first.template.label, template.label);
  assert.notEqual(selectPdfTemplate(options)!.digest, first.digest);
  assert.notEqual(selectPdfTemplate({ customTemplate: template, metadata: { title: 'Příliš žluťoučký', version: '3' } })!.digest, first.digest);
  assert.equal(digest(first.bytes), first.digest);
  assert.deepEqual(parsePdfTemplate(jsonBytes(template)), template);
});
test('token CSS rejects executable CSS, imports, references, unknown selectors and duplicates', () => {
  for (const css of ['@import "https://example.com/x";', 'body { color:red }', ':root { --text-color: url(file:///a); }', ':root { --text-color: #000000; --text-color: #ffffff; }', ':root { --font: Arial; }', ':root { --constructor: 12pt; }', ':root { --body-size: 0pt; }', ':root { --line-height: 3; }', ':root { --margin-top: 1mm; }', ':root { --table-size: NaNpt; }', ':root { --text-color: #000000 !important; }', ':root {} <script/>']) assert.throws(() => pdfTemplateStyle(css), /PDF template/, css);
});
test('template import rejects duplicate JSON, unexpected fields, metadata controls and oversize payloads', () => {
  assert.throws(() => parsePdfTemplate(encode('{"id":"A","id":"B"}')), /Duplicate/);
  assert.throws(() => parsePdfTemplate(encode(' '.repeat(98305))), /exceeds/);
  assert.throws(() => selectPdfTemplate({ customTemplate: { ...template, script: 'alert(1)' } as PdfTemplate }), /unknown field/);
  assert.throws(() => selectPdfTemplate({ customTemplate: template, metadata: { title: '\u202eHidden' } }), /invalid title/);
  assert.throws(() => selectPdfTemplate({ customTemplate: template, metadata: { title: 'a'.repeat(161) } }), /invalid title/);
  assert.throws(() => selectPdfTemplate({ templateId: 'Neutral', customTemplate: template }), /not both/);
  assert.throws(() => selectPdfTemplate({ customTemplate: { ...template, id: 'Default' } }), /invalid identity/);
});
test('templates and metadata are inseparable from a recovered PDF plan', () => {
  const first = selectPdfTemplate({ customTemplate: template })!, changed = selectPdfTemplate({ customTemplate: template, metadata: { version: 'new' } })!;
  assertPdfTemplateRecovery(undefined, undefined); assertPdfTemplateRecovery(first.digest, first);
  assert.throws(() => assertPdfTemplateRecovery(undefined, first), /different template/);
  assert.throws(() => assertPdfTemplateRecovery(first.digest, undefined), /different template/);
  assert.throws(() => assertPdfTemplateRecovery(first.digest, changed), /different template/);
});
test('audit profile binds exactly one content-addressed render-only resource', () => {
  const selected = selectPdfTemplate({ customTemplate: template })!, file = blobEvidence(selected.bytes, 'application/json');
  const inventory = { renderer: { pdfEngine: `pdfmake; ${PDF_TEMPLATE_PROFILE}${file.digest}` }, resources: [file] } as AuditInventory;
  assert.deepEqual(exportTemplateReceipt(inventory), file);
  assert.throws(() => exportTemplateReceipt({ ...inventory, resources: [] }), /missing/);
  assert.throws(() => exportTemplateReceipt({ ...inventory, resources: [file, file] }), /inconsistent/);
  assert.throws(() => exportTemplateReceipt({ ...inventory, resources: [{ ...file, path: 'assets/template.json' }] }), /inconsistent/);
});
test('edition registry enforces enterprise-only preset delivery and public import restrictions', () => {
  const presets = pdfTemplatePresets();
  if (registry.edition === 'public') {
    assert.deepEqual(presets, []);
    assert.throws(() => selectPdfTemplate({ customTemplate: { ...template, distribution: 'enterprise-only' } }), /restricted/);
  } else {
    assert.ok(presets.length); assert.ok(presets.every(p => p.distribution === 'enterprise-only'));
    for (const preset of presets) assert.ok(selectPdfTemplate({ templateId: preset.id }));
  }
});
test('readers verify exact render receipts across editions without enabling restricted presets', () => {
  const receipt = { kind: 'omr-pdf-render-input/1', template: validatePdfTemplate({ ...template, distribution: 'enterprise-only' }, false), metadata: { title: 'Read-only provenance' } };
  const bytes = jsonBytes(receipt); validatePdfRenderInput(bytes, digest(bytes));
  assert.throws(() => validatePdfRenderInput(bytes, digest('different')), /not exact/);
  const malformed = jsonBytes({ ...receipt, kind: 'unknown' }); assert.throws(() => validatePdfRenderInput(malformed, digest(malformed)), /unsupported/);
  const noncanonical = encode(JSON.stringify(receipt)); assert.throws(() => validatePdfRenderInput(noncanonical, digest(noncanonical)), /canonical/);
});
test('grouped covers preserve ordered labels, validate fields and bind preset defaults', () => {
  const grouped: PdfTemplate = { ...template, defaults: { title: 'Specification', division: 'Neutral division' }, coverSections: [
    { title: 'Project / Product', showEmpty: true, fields: [{ key: 'project', label: 'Project name / version' }, { key: 'product', label: 'Product name / version' }] },
    { title: 'Document', fields: [{ key: 'author', label: 'Author' }] }
  ], css: ':root { --margin-top: 27mm; --cover-top: 17mm; --heading-rule: 0.75pt; --table-padding-x: 8pt; --table-padding-y: 6pt; }' };
  const result = selectPdfTemplate({ customTemplate: grouped, metadata: { author: 'Author', division: '' } })!;
  assert.equal(result.metadata.title, 'Specification'); assert.equal(result.metadata.author, 'Author'); assert.equal(result.metadata.division, undefined);
  assert.equal(result.style.coverTop, 17 * 72 / 25.4); assert.equal(result.style.headingRule, 0.75); assert.equal(result.style.tablePaddingX, 8);
  validatePdfRenderInput(result.bytes, result.digest);
  assert.throws(() => selectPdfTemplate({ customTemplate: { ...grouped, coverSections: [{ title: 'Invalid', fields: [{ key: 'project', label: 'A' }, { key: 'project', label: 'B' }] }] } }), /duplicate/);
  assert.throws(() => selectPdfTemplate({ customTemplate: { ...grouped, defaults: { approval: 'approved' } as never } }), /unknown field/);
});

test('template form uses exact cover grouping, labels, order, requirements and plain-text guidance', () => {
  const configurable: PdfTemplate = { ...template, coverSections: [
    { title: 'Release', fields: [{ key: 'product', label: 'Product release', required: true, help: 'Use the released product name.', placeholder: 'Product 2.1' }, { key: 'documentId', label: 'Specification number', required: false }] }
  ], pageFields: [{ key: 'title', label: 'Specification title' }] };
  const copy = validatePdfTemplate(configurable), form = pdfTemplateForm(copy);
  assert.deepEqual(form.sections, configurable.coverSections); assert.deepEqual(form.pageFields, configurable.pageFields);
  assert.equal(form.sections[0].fields[0].required, true);
  assert.throws(() => selectPdfTemplate({ customTemplate: copy }), /Product release is required/);
  assert.throws(() => selectPdfTemplate({ customTemplate: copy, metadata: { product: '   ' } }), /Product release is required/);
  assert.ok(selectPdfTemplate({ customTemplate: copy }, false), 'Form inspection may request an unfilled required value.');
  const result = selectPdfTemplate({ customTemplate: copy, metadata: { product: 'Release 2.1' } })!;
  validatePdfRenderInput(result.bytes, result.digest);
  const altered = jsonBytes({ kind: 'omr-pdf-render-input/1', template: copy, metadata: {} });
  assert.throws(() => validatePdfRenderInput(altered, digest(altered)), /Product release is required/);
  assert.ok(selectPdfTemplate({ customTemplate: copy, includeCover: false }), 'Cover-only requirements do not block a coverless export.');
  assert.ok(selectPdfTemplate({ customTemplate: { ...copy, defaults: { product: 'Default release' } } }));
  assert.throws(() => selectPdfTemplate({ customTemplate: { ...copy, defaults: { product: 'Default release' } }, metadata: { product: '' } }), /required/);
});

test('form contract rejects duplicates, unsupported controls and unbounded guidance', () => {
  const field = { key: 'project' as const, label: 'Project' };
  const grouped = { ...template, coverSections: [{ title: 'Project', fields: [field] }] };
  for (const extra of [{ required: 'yes' }, { help: 'x'.repeat(241) }, { placeholder: 'x'.repeat(161) }, { help: '\u202eHidden' }, { inputType: 'script' }]) {
    assert.throws(() => validatePdfTemplate({ ...grouped, coverSections: [{ title: 'Project', fields: [{ ...field, ...extra }] }] }), /PDF template/);
  }
  assert.throws(() => validatePdfTemplate({ ...grouped, pageFields: [field] }), /duplicate/);
  assert.throws(() => validatePdfTemplate({ ...template, pageFields: [field] }), /duplicate/, 'Legacy cover rows also reserve their input keys.');
  assert.throws(() => validatePdfTemplate({ ...grouped, pageFields: [{ key: 'product', label: 'Ignored page value' }] }), /invalid/);
  assert.deepEqual(pdfTemplateForm({ ...grouped, pageFields: [] }).pageFields, []);
  const fallback = pdfTemplateForm(template);
  assert.deepEqual(fallback.sections[0].fields.map(f => f.key), ['project', 'documentId', 'version', 'date', 'status', 'classification']);
  assert.deepEqual(fallback.pageFields.map(f => f.key), ['title', 'division', 'confidentiality', 'templateCode']);
  assert.equal(new Set([...pdfTemplateForm().sections.flatMap(s => s.fields), ...pdfTemplateForm().pageFields].map(f => f.key)).size, 15);
});
