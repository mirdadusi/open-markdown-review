import registry from '../../release/pdf-templates.json';
import { digest, jsonBytes, parseJson } from './bytes';
import { ProtocolError } from './types';
import { PdfExportMode, PdfOrientation, pdfDocumentList, pdfOrientation } from './pdfProfiles';

/** Export presentation profile, deliberately outside the review event vocabulary. */
export interface PdfTemplate {
  schemaVersion: 'omr-pdf-template/1'; id: string; version: string; label: string;
  distribution: 'all' | 'enterprise-only'; cover: boolean; css: string; logoSvg?: string;
  defaults?: PdfMetadata; coverSections?: PdfCoverSection[]; pageFields?: PdfTemplateField[];
}
export const PDF_METADATA_FIELDS = ['title', 'project', 'product', 'projectId', 'paNumber', 'productFamily', 'author', 'documentId', 'version', 'date', 'status', 'division', 'classification', 'confidentiality', 'templateCode'] as const;
export type PdfMetadata = Partial<Record<typeof PDF_METADATA_FIELDS[number], string>>;
export interface PdfTemplateField { key: typeof PDF_METADATA_FIELDS[number]; label: string; required?: boolean; help?: string; placeholder?: string }
export interface PdfCoverSection { title: string; fields: PdfTemplateField[]; showEmpty?: boolean }
export interface PdfTemplateOptions { templateId?: string; customTemplate?: PdfTemplate; metadata?: PdfMetadata; includeCover?: boolean; includeDocumentList?: boolean; orientation?: PdfOrientation }
export interface PdfTemplateStyle {
  bodySize: number; lineHeight: number; textColor: string; headingColor: string; linkColor: string;
  borderColor: string; tableHeader: string; tableStripe: string; tableSize: number;
  h1Size: number; h2Size: number; h3Size: number; left: number; right: number; top: number; bottom: number; coverTop: number; headingRule: number; tablePaddingX: number; tablePaddingY: number;
}
export interface SelectedPdfTemplate {
  template: PdfTemplate; metadata: PdfMetadata; style: PdfTemplateStyle; digest: string; bytes: Uint8Array;
}
const fail = (message: string): never => { throw new ProtocolError('invalid', `PDF template: ${message}`); };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('expected an object.');
  return value as Record<string, unknown>;
};
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('unknown field (only documented fields are supported).');
}
const defaultStyle: PdfTemplateStyle = { bodySize: 10, lineHeight: 1.12, textColor: '#172b42', headingColor: '#172b42', linkColor: '#2458a6', borderColor: '#cbd7e4', tableHeader: '#eaf0f7', tableStripe: '#f8fafc', tableSize: 9.2, h1Size: 20, h2Size: 18, h3Size: 16, left: 45, right: 45, top: 60, bottom: 65, coverTop: 60, headingRule: 0, tablePaddingX: 4, tablePaddingY: 4 };
const colorTokens = { 'text-color': 'textColor', 'heading-color': 'headingColor', 'link-color': 'linkColor', 'border-color': 'borderColor', 'table-header': 'tableHeader', 'table-stripe': 'tableStripe' } as const;
const sizeTokens = { 'body-size': 'bodySize', 'table-size': 'tableSize', 'h1-size': 'h1Size', 'h2-size': 'h2Size', 'h3-size': 'h3Size' } as const;
const marginTokens = { 'margin-left': 'left', 'margin-right': 'right', 'margin-top': 'top', 'margin-bottom': 'bottom', 'cover-top': 'coverTop' } as const;
/** No CSS is ever evaluated or inserted into the DOM. This is a small token grammar. */
export function pdfTemplateStyle(css: string): PdfTemplateStyle {
  if (typeof css !== 'string' || css.length > 8192) return fail('CSS must be at most 8192 characters.');
  const match = /^\s*:root\s*\{([^{}]*)\}\s*$/.exec(css);
  if (!match) return fail('use one :root token block; selectors, imports, URLs and fonts are not supported.');
  const style = { ...defaultStyle }, seen = new Set<string>();
  const declarations = match[1].split(';');
  for (const declaration of declarations) {
    if (!declaration.trim()) continue;
    const token = /^\s*--([a-z0-9-]+)\s*:\s*([^:;]+?)\s*$/.exec(declaration);
    if (!token || seen.has(token[1])) return fail('invalid or duplicate CSS token.');
    const [, name, value] = token; seen.add(name);
    if (Object.hasOwn(colorTokens, name)) {
      if (!/^#[a-fA-F0-9]{6}$/.test(value)) return fail(`${name} requires a six-digit hex color.`);
      style[colorTokens[name as keyof typeof colorTokens]] = value.toLowerCase();
    } else if (Object.hasOwn(sizeTokens, name)) {
      const size = /^(\d+(?:\.\d+)?)pt$/.exec(value), number = Number(size?.[1]);
      if (!size || number < 8 || number > 24) return fail(`${name} must be 8–24pt.`);
      style[sizeTokens[name as keyof typeof sizeTokens]] = number;
    } else if (Object.hasOwn(marginTokens, name)) {
      const margin = /^(\d+(?:\.\d+)?)mm$/.exec(value), number = Number(margin?.[1]);
      // Page furniture has its own reserved band; margins cannot overlap it.
      const minimum = name === 'margin-top' || name === 'margin-bottom' ? 22 : 10;
      if (!margin || number < minimum || number > 35) return fail(`${name} must be ${minimum}–35mm.`);
      style[marginTokens[name as keyof typeof marginTokens]] = number * 72 / 25.4;
    } else if (name === 'heading-rule' || name === 'table-padding-x' || name === 'table-padding-y') {
      const token = /^(\d+(?:\.\d+)?)pt$/.exec(value), number = Number(token?.[1]), max = name === 'heading-rule' ? 1.5 : 8;
      if (!token || number < (name === 'heading-rule' ? 0 : 2) || number > max) return fail(`${name} is outside its supported point range.`);
      style[name === 'heading-rule' ? 'headingRule' : name === 'table-padding-x' ? 'tablePaddingX' : 'tablePaddingY'] = number;
    } else if (name === 'line-height') {
      if (!/^(?:1(?:\.\d+)?|2(?:\.0+)?)$/.test(value)) return fail('line-height must be 1–2.');
      style.lineHeight = Number(value);
    } else return fail(`unsupported CSS token --${name}.`);
  }
  if (!seen.has('cover-top')) style.coverTop = style.top;
  return style;
}
export function validatePdfTemplate(value: unknown, enforceDistribution = true): PdfTemplate {
  const item = object(value);
  keys(item, ['schemaVersion', 'id', 'version', 'label', 'distribution', 'cover', 'css', 'logoSvg', 'defaults', 'coverSections', 'pageFields']);
  if (item.schemaVersion !== 'omr-pdf-template/1' || typeof item.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.id) || item.id === 'Default'
    || typeof item.version !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(item.version)
    || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 80 || /[\x00-\x1f\x7f]/.test(item.label)
    || !['all', 'enterprise-only'].includes(String(item.distribution)) || typeof item.cover !== 'boolean') return fail('invalid identity, version, edition or cover flag.');
  if (enforceDistribution && item.distribution === 'enterprise-only' && registry.edition !== 'enterprise') return fail('this template is restricted to the enterprise distribution.');
  pdfTemplateStyle(item.css as string);
  if (item.logoSvg !== undefined && (typeof item.logoSvg !== 'string' || item.logoSvg.length > 65536 || !item.logoSvg.trim().startsWith('<svg'))) return fail('logo must be a bounded, self-contained SVG. It is sanitized before rendering.');
  const defaults = item.defaults === undefined ? undefined : validateMetadata(item.defaults);
  let coverSections: PdfCoverSection[] | undefined;
  if (item.coverSections !== undefined) {
    if (!Array.isArray(item.coverSections) || item.coverSections.length < 1 || item.coverSections.length > 4) return fail('coverSections must contain 1–4 sections.');
    const used = new Set<string>();
    coverSections = item.coverSections.map(value => {
      const section = object(value); keys(section, ['title', 'fields', 'showEmpty']);
      if (typeof section.title !== 'string' || !section.title.trim() || section.title.length > 80 || /[\x00-\x1f\x7f]/.test(section.title) || section.showEmpty !== undefined && typeof section.showEmpty !== 'boolean'
        || !Array.isArray(section.fields) || !section.fields.length || section.fields.length > 12) return fail('invalid cover section title or fields.');
      const fields = section.fields.map(value => {
        const field = validateTemplateField(value);
        if (used.has(field.key)) return fail('invalid or duplicate cover metadata field.');
        used.add(field.key); return field;
      });
      return { title: section.title, fields, ...(section.showEmpty === undefined ? {} : { showEmpty: section.showEmpty }) };
    });
  }
  let pageFields: PdfTemplateField[] | undefined;
  if (item.pageFields !== undefined) {
    if (!Array.isArray(item.pageFields) || item.pageFields.length > 8) return fail('pageFields must contain at most 8 fields.');
    const used = new Set((coverSections ?? legacyPdfCoverSections()).flatMap(section => section.fields.map(field => field.key)));
    pageFields = item.pageFields.map(value => {
      const field = validateTemplateField(value);
      if (!PAGE_METADATA_KEYS.includes(field.key) || used.has(field.key)) return fail('invalid or duplicate page metadata field.');
      used.add(field.key); return field;
    });
  }
  // Copy known fields in stable order. Never retain caller-owned mutable objects.
  return { schemaVersion: 'omr-pdf-template/1', id: item.id, version: item.version, label: item.label, distribution: item.distribution as PdfTemplate['distribution'], cover: item.cover, css: item.css as string, ...(item.logoSvg === undefined ? {} : { logoSvg: item.logoSvg as string }), ...(defaults ? { defaults } : {}), ...(coverSections ? { coverSections } : {}), ...(pageFields ? { pageFields } : {}) };
}
const PAGE_METADATA_KEYS: PdfTemplateField['key'][] = ['title', 'project', 'version', 'date', 'division', 'classification', 'confidentiality', 'templateCode'];
function validateTemplateField(value: unknown): PdfTemplateField {
  const field = object(value); keys(field, ['key', 'label', 'required', 'help', 'placeholder']);
  const text = (value: unknown, max: number) => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value);
  if (!PDF_METADATA_FIELDS.includes(field.key as PdfTemplateField['key']) || !text(field.label, 80)
    || field.required !== undefined && typeof field.required !== 'boolean'
    || field.help !== undefined && !text(field.help, 240) || field.placeholder !== undefined && !text(field.placeholder, 160)) return fail('invalid metadata field label, requirement or guidance.');
  return { key: field.key as PdfTemplateField['key'], label: field.label as string, ...(field.required === undefined ? {} : { required: field.required as boolean }), ...(field.help === undefined ? {} : { help: field.help as string }), ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder as string }) };
}

function legacyPdfCoverSections(): PdfCoverSection[] {
  return [{ title: 'Document details', fields: [
    { key: 'project', label: 'Project / Product' }, { key: 'documentId', label: 'Document ID' }, { key: 'version', label: 'Version' },
    { key: 'date', label: 'Date' }, { key: 'status', label: 'Document status' }, { key: 'classification', label: 'Classification' }
  ] }];
}
/** One definition drives both cover tables and their export form. Old templates retain their layout. */
export function pdfTemplateForm(template?: PdfTemplate): { sections: PdfCoverSection[]; pageFields: PdfTemplateField[] } {
  if (!template) template = defaultPdfCoverTemplate();
  const sections = template.coverSections ?? legacyPdfCoverSections();
  const used = new Set(sections.flatMap(section => section.fields.map(field => field.key)));
  const pageFields = template.pageFields ?? ([
    { key: 'title', label: 'Document title', placeholder: 'Leave blank to use the document/review title' },
    { key: 'project', label: 'Project name / version' }, { key: 'version', label: 'Document version' }, { key: 'date', label: 'Document date' },
    { key: 'division', label: 'Division / organization' }, { key: 'classification', label: 'Classification' },
    { key: 'confidentiality', label: 'Confidentiality note' }, { key: 'templateCode', label: 'Template code' }
  ] satisfies PdfTemplateField[]).filter(field => !used.has(field.key));
  return { sections, pageFields };
}
function defaultPdfCoverTemplate(): PdfTemplate {
  return { schemaVersion: 'omr-pdf-template/1', id: 'DefaultDocumentCover', version: '1.0.0', label: 'Default', distribution: 'all', cover: true,
    css: ':root { --margin-top: 22mm; --margin-bottom: 22mm; }', coverSections: [
      { title: 'Project / Product', fields: [{ key: 'project', label: 'Project name / version' }, { key: 'product', label: 'Product name / version' }, { key: 'projectId', label: 'Project ID' }, { key: 'paNumber', label: 'PA number' }, { key: 'productFamily', label: 'Product family' }] },
      { title: 'Document', fields: [{ key: 'author', label: 'Author' }, { key: 'documentId', label: 'Document ID' }, { key: 'version', label: 'Document version' }, { key: 'date', label: 'Document date' }, { key: 'status', label: 'Document status' }, { key: 'classification', label: 'Classification' }] }
    ] };
}
function assertRequiredMetadata(template: PdfTemplate, metadata: PdfMetadata) {
  if (!template.cover) return;
  const form = pdfTemplateForm(template);
  for (const field of [...form.sections.flatMap(section => section.fields), ...form.pageFields]) if (field.required && !metadata[field.key]) fail(`${field.label} is required by ${template.label}.`);
}
export function parsePdfTemplate(bytes: Uint8Array): PdfTemplate { return validatePdfTemplate(parseJson(bytes, 98304)); }
export function pdfTemplatePresets(): PdfTemplate[] { return registry.presets.map(value => validatePdfTemplate(value)); }
function validateMetadata(value: unknown): PdfMetadata {
  const input = object(value); keys(input, PDF_METADATA_FIELDS);
  const metadata: PdfMetadata = {};
  for (const name of PDF_METADATA_FIELDS) if (input[name] !== undefined) {
    const value = input[name];
    if (typeof value !== 'string' || value.length > (name === 'confidentiality' ? 400 : 160) || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value)) return fail(`invalid ${name}; use a short, single-line value.`);
    if (value.trim()) metadata[name] = value.trim();
  }
  return metadata;
}
export function selectPdfTemplate(options: PdfTemplateOptions = {}, checkRequired = true): SelectedPdfTemplate | undefined {
  keys(object(options), ['templateId', 'customTemplate', 'metadata', 'includeCover', 'includeDocumentList', 'orientation']);
  pdfDocumentList(options); pdfOrientation(options.orientation);
  if (options.includeCover !== undefined && typeof options.includeCover !== 'boolean') return fail('includeCover must be true or false.');
  let metadata = validateMetadata(options.metadata ?? {});
  if (options.templateId !== undefined && typeof options.templateId !== 'string') return fail('invalid template selection.');
  if ((!options.templateId || options.templateId === 'Default') && !options.customTemplate) {
    if (options.includeCover) return selectPdfTemplate({ customTemplate: defaultPdfCoverTemplate(), metadata }, checkRequired);
    if (Object.keys(metadata).length) return fail('Default keeps the existing layout and does not accept cover metadata.');
    return;
  }
  if (options.customTemplate && options.templateId) return fail('choose a preset or an imported template, not both.');
  let template = options.customTemplate ? validatePdfTemplate(options.customTemplate) : pdfTemplatePresets().find(preset => preset.id === options.templateId);
  if (!template) return fail('selected template is unavailable in this distribution.');
  if (options.includeCover !== undefined) template = { ...template, cover: options.includeCover };
  metadata = validateMetadata({ ...template.defaults, ...options.metadata });
  if (checkRequired) assertRequiredMetadata(template, metadata);
  const bytes = jsonBytes({ kind: 'omr-pdf-render-input/1', template, metadata });
  return { template, metadata, style: pdfTemplateStyle(template.css), digest: digest(bytes), bytes };
}
export const pdfTemplateFingerprint = (options?: PdfTemplateOptions): string => selectPdfTemplate(options)?.digest ?? 'Default';
export function pdfExportFingerprint(options: PdfTemplateOptions = {}, mode: PdfExportMode = 'review'): string {
  const template = pdfTemplateFingerprint(options), includeDocumentList = pdfDocumentList(options, mode);
  const orientation = pdfOrientation(options.orientation);
  if (orientation !== 'auto') return digest(jsonBytes({ template, includeDocumentList, orientation }));
  return includeDocumentList === (mode === 'review') ? template : digest(jsonBytes({ template, includeDocumentList }));
}
/** Reading an export from another edition does not grant permission to render its preset. */
export function validatePdfRenderInput(bytes: Uint8Array, expectedDigest: string) {
  const input = object(parseJson(bytes, 98304)); keys(input, ['kind', 'template', 'metadata']);
  if (input.kind !== 'omr-pdf-render-input/1') return fail('unsupported render-input receipt.');
  const template = validatePdfTemplate(input.template, false), metadata = validateMetadata(input.metadata);
  assertRequiredMetadata(template, metadata);
  if (digest(bytes) !== expectedDigest || digest(jsonBytes({ kind: input.kind, template, metadata })) !== expectedDigest) return fail('render-input receipt is not exact canonical presentation data.');
}
/** Recovery must never publish a plan rendered using different presentation inputs. */
export function assertPdfTemplateRecovery(recorded: string | undefined, selected: SelectedPdfTemplate | undefined) {
  if ((recorded ?? 'Default') !== (selected?.digest ?? 'Default')) fail('recovery belongs to different template/metadata. Resume it with the original options or start a new export.');
}
