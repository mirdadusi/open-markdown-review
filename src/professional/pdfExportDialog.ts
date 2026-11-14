import { PdfExportMode, pdfExportMode, pdfDocumentList, pdfOrientation } from './pdfProfiles';
import { decode } from './bytes';
import { defaultPdfRevision, PdfRevisionChoice } from './exportRevisions';
import { PdfMetadata, PdfTemplate, PdfTemplateField, PdfTemplateOptions, parsePdfTemplate, pdfTemplateForm, pdfTemplatePresets, selectPdfTemplate } from './pdfTemplate';

export interface PdfExportConfiguration { mode: PdfExportMode; options: PdfTemplateOptions; editedFields?: PdfTemplateField['key'][]; revisionId: string }
interface DialogRequest extends Omit<PdfExportConfiguration, 'revisionId'> { reviewTitle: string; revisions: PdfRevisionChoice[] }
const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const value = document.getElementById(id); if (!value) throw new Error(`Missing export dialog element ${id}`); return value as T;
};

/** Shared, transactional UI: draft edits have no effect until Export is confirmed. */
export class PdfExportDialog {
  private resolve?: (value: PdfExportConfiguration | undefined) => void;
  private imported?: PdfTemplate;
  private draft: PdfMetadata = {};
  private inputs: HTMLInputElement[] = [];
  private documentListEdited = false;
  private generation = 0;
  private requestId = 0;
  private sourceButton?: HTMLElement;
  private request?: DialogRequest;
  private importing = false;
  private dialog = element<HTMLDialogElement>('pdf-template-dialog');
  constructor() {
    element('pdf-revision').addEventListener('change', () => { this.scope(); this.submit.disabled = this.importing || !this.selectedRevision(); });
    element('pdf-template-select').addEventListener('change', () => { this.generation++; this.importing = false; this.submit.disabled = !this.selectedRevision(); this.fields(true); });
    element('pdf-cover').addEventListener('change', () => this.fields());
    element('export-mode').addEventListener('change', () => {
      if (!this.documentListEdited) this.documentList.checked = pdfDocumentList({}, pdfExportMode(element<HTMLSelectElement>('export-mode').value));
      this.description();
    });
    element('pdf-document-list').addEventListener('change', () => { this.documentListEdited = true; });
    element('pdf-template-file').addEventListener('change', () => { void this.importFile(); });
    element('pdf-template-cancel').addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => this.finish());
    element('pdf-template-form').addEventListener('submit', event => {
      event.preventDefault(); if (this.submit.disabled) return;
      const missing = this.inputs.find(input => !input.disabled && input.required && !input.value.trim());
      if (missing) {
        this.error(new Error(`${missing.dataset.label} is required by this template.`));
        missing.setAttribute('aria-invalid', 'true'); missing.focus(); return;
      }
      try {
        const revision = this.selectedRevision(); if (!revision) throw new Error('Choose a verified snapshot to export. Competing branch heads have no single latest snapshot.');
        const id = this.selection.value, includeCover = this.cover.checked, metadata = includeCover ? this.metadata() : {};
        if (id === '__imported' && !this.imported) throw new Error('Choose a valid template file.');
        const options: PdfTemplateOptions = id === 'Default' ? includeCover ? { includeCover, metadata } : {}
          : id === '__imported' ? { customTemplate: this.imported, includeCover, metadata } : { templateId: id, includeCover, metadata };
        const mode = pdfExportMode(element<HTMLSelectElement>('export-mode').value);
        if (this.documentListEdited || this.documentList.checked !== pdfDocumentList({}, mode)) options.includeDocumentList = this.documentList.checked;
        const orientation = pdfOrientation(element<HTMLSelectElement>('pdf-orientation').value);
        if (orientation !== 'auto') options.orientation = orientation;
        selectPdfTemplate(options);
        const editedFields = includeCover ? this.inputs.map(input => input.dataset.key as PdfTemplateField['key']).filter(key => Object.hasOwn(this.draft, key)) : [];
        const value = { mode, options, editedFields, revisionId: revision.id };
        this.submit.disabled = true; this.finish(value); this.dialog.close();
      } catch (error) { this.error(error); }
    });
  }
  get open(): boolean { return this.dialog.open; }
  private get selection() { return element<HTMLSelectElement>('pdf-template-select'); }
  private get cover() { return element<HTMLInputElement>('pdf-cover'); }
  private get documentList() { return element<HTMLInputElement>('pdf-document-list'); }
  private get submit() { return element<HTMLButtonElement>('pdf-export-confirm'); }
  private selectedRevision() { return this.request?.revisions.find(r => r.id === element<HTMLSelectElement>('pdf-revision').value); }
  private scope() {
    const revision = this.selectedRevision();
    element('pdf-export-scope').textContent = revision
      ? `${this.request!.reviewTitle} · ${revision.label} · All ${revision.documents} document(s). ${revision.comments} comment(s), ${revision.replies} reply/replies on this snapshot. Saved in this review’s exports folder.`
      : `${this.request?.reviewTitle ?? ''} · Choose a snapshot. Multiple branch heads must be selected explicitly.`;
    element('pdf-revision-help').textContent = revision
      ? `Only this snapshot’s documents and findings are exported; findings on other snapshots are not moved onto changed text. Snapshot ID: ${revision.id}. Your displayed document will not change.`
      : 'There is no unique latest snapshot. Choose a branch head or an older snapshot; timestamps do not resolve branches.';
  }
  show(request: DialogRequest): Promise<PdfExportConfiguration | undefined> {
    if (this.resolve || this.dialog.open) return Promise.resolve(undefined);
    this.requestId++; this.generation++; this.sourceButton = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.request = { ...request, revisions: request.revisions.map(r => ({ ...r })) };
    this.importing = false;
    const revisions = element<HTMLSelectElement>('pdf-revision'), latest = defaultPdfRevision(request.revisions);
    revisions.replaceChildren(); if (!latest) revisions.add(new Option('Choose a snapshot…', ''));
    for (const choice of request.revisions) revisions.add(new Option(`${choice.label}${choice.head ? latest ? ' · latest' : ' · branch head' : ''}`, choice.id));
    revisions.value = latest ?? ''; this.scope();
    this.imported = request.options.customTemplate;
    this.draft = Object.fromEntries(Object.entries(request.options.metadata ?? {}).filter(([key]) => !request.editedFields || request.editedFields.includes(key as PdfTemplateField['key'])));
    this.selection.replaceChildren();
    for (const choice of [{ id: 'Default', label: 'Default' }, ...pdfTemplatePresets(), ...(this.imported ? [{ id: '__imported', label: `Imported: ${this.imported.label}` }] : [])]) this.selection.add(new Option(choice.label, choice.id));
    this.selection.value = request.options.customTemplate ? '__imported' : request.options.templateId ?? 'Default';
    // A required field may still need to be supplied: opening a form is not an export.
    const selected = selectPdfTemplate(request.options, false);
    this.cover.checked = selected?.template.cover ?? false;
    element<HTMLSelectElement>('export-mode').value = request.mode;
    this.documentListEdited = request.options.includeDocumentList !== undefined;
    this.documentList.checked = pdfDocumentList(request.options, request.mode);
    element<HTMLSelectElement>('pdf-orientation').value = pdfOrientation(request.options.orientation);
    element('pdf-template-error').textContent = ''; this.submit.disabled = !latest;
    element<HTMLDetailsElement>('pdf-template-import').open = !!this.imported;
    this.fields();
    const promise = new Promise<PdfExportConfiguration | undefined>(resolve => { this.resolve = resolve; });
    this.dialog.showModal(); this.selection.focus(); return promise;
  }
  private finish(value?: PdfExportConfiguration) {
    const resolve = this.resolve; this.resolve = undefined; this.generation++;
    resolve?.(value); this.sourceButton?.focus();
  }
  private metadata(): PdfMetadata {
    const metadata: PdfMetadata = {};
    // Only fields from the selected template are submitted; other drafts stay private.
    for (const input of this.inputs) metadata[input.dataset.key as PdfTemplateField['key']] = input.value;
    return metadata;
  }
  private chosen(): PdfTemplate | undefined {
    return this.selection.value === '__imported' ? this.imported : pdfTemplatePresets().find(preset => preset.id === this.selection.value);
  }
  private input(field: PdfTemplateField, template?: PdfTemplate): HTMLLabelElement {
    const label = document.createElement('label'), caption = document.createElement('span');
    caption.textContent = field.label;
    if (field.required) { const required = document.createElement('span'); required.className = 'pdf-required'; required.textContent = ' (required)'; caption.append(required); }
    const input = document.createElement('input'); input.id = `pdf-meta-${field.key}`; input.dataset.key = field.key; input.dataset.label = field.label;
    input.maxLength = field.key === 'confidentiality' ? 400 : 160; input.required = field.required ?? false;
    input.disabled = !this.cover.checked; input.autocomplete = 'off'; input.placeholder = field.placeholder ?? '';
    input.value = this.draft[field.key] ?? template?.defaults?.[field.key] ?? '';
    label.htmlFor = input.id; label.append(caption, input);
    if (field.help) {
      const help = document.createElement('small'); help.id = `${input.id}-help`; help.className = 'pdf-help'; help.textContent = field.help;
      input.setAttribute('aria-describedby', help.id); label.append(help);
    }
    input.addEventListener('input', () => { this.draft[field.key] = input.value; input.removeAttribute('aria-invalid'); element('pdf-template-error').textContent = ''; });
    this.inputs.push(input); return label;
  }
  private fields(templateChanged = false) {
    const selected = this.chosen();
    if (templateChanged) this.cover.checked = selected?.cover ?? false;
    this.inputs = [];
    const form = pdfTemplateForm(selected);
    const title = element('pdf-title-fields'), sections = element('pdf-template-sections'), pageFields = element('pdf-page-fields');
    title.replaceChildren(); sections.replaceChildren(); pageFields.replaceChildren();
    // Title is page furniture, not an invented row in a template's cover table.
    for (const field of form.pageFields) if (field.key === 'title') title.append(this.input(field, selected));
    title.hidden = !title.childElementCount;
    for (const section of form.sections) {
      const group = document.createElement('fieldset'), legend = document.createElement('legend'), grid = document.createElement('div');
      legend.textContent = section.title; grid.className = 'pdf-metadata-grid';
      for (const field of section.fields) grid.append(this.input(field, selected));
      group.append(legend, grid); sections.append(group);
    }
    for (const field of form.pageFields) if (field.key !== 'title') pageFields.append(this.input(field, selected));
    const pageLabels = element<HTMLDetailsElement>('pdf-page-labels');
    pageLabels.hidden = !pageFields.childElementCount;
    pageLabels.open = form.pageFields.some(field => field.key !== 'title' && field.required);
    element('pdf-template-metadata').hidden = !this.cover.checked;
    element('pdf-cover-off').hidden = this.cover.checked;
    element('pdf-template-error').textContent = '';
    const required = this.inputs.some(input => input.required);
    element('pdf-fields-help').textContent = `Descriptive labels, not review approvals. ${required ? 'Complete the fields marked required.' : 'All fields are optional.'} Blank optional rows ${form.sections.some(section => section.showEmpty) ? 'may appear as “Not provided”, as defined by the template' : 'are omitted from the cover'}.`;
    element('pdf-template-summary').textContent = selected
      ? `${selected.label} ${selected.version}${selected.distribution === 'enterprise-only' ? ' · Enterprise template' : ''}. The fields below follow this template. Styling applies to the PDF only.`
      : 'Default uses the existing PDF style. Add a document cover below if you need Project / Product and Document tables.';
    this.description();
  }
  private description() {
    element('pdf-export-description').textContent = element<HTMLSelectElement>('export-mode').value === 'clean'
      ? 'Frozen documents only. No review comments, reviewer progress or audit appendix. Any cover labels you enter are included.'
      : 'Frozen documents with native PDF comments and replies, reviewer progress and audit evidence. Open the PDF reader’s Comments panel to view discussions.';
  }
  private error(error: unknown) {
    element('pdf-template-error').textContent = error instanceof Error ? error.message : String(error);
    element('pdf-template-error').focus(); this.submit.disabled = false;
  }
  private async importFile() {
    const input = element<HTMLInputElement>('pdf-template-file'), file = input.files?.[0]; input.value = '';
    if (!file) return;
    const generation = ++this.generation, request = this.requestId;
    this.importing = true;
    this.submit.disabled = true; element('pdf-template-error').textContent = 'Reading template…';
    try {
      if (file.size > 98304) throw new Error('Template file exceeds 96 KiB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (generation !== this.generation || request !== this.requestId || !this.dialog.open) return;
      const imported: PdfTemplate = file.name.toLowerCase().endsWith('.css')
        ? { schemaVersion: 'omr-pdf-template/1', id: 'CustomStyle', version: '1.0.0', label: 'Custom style', distribution: 'all', cover: false, css: decode(bytes) }
        : parsePdfTemplate(bytes);
      // Validate shape, edition and style, but let the form request missing required metadata.
      selectPdfTemplate({ customTemplate: imported }, false); this.imported = imported;
      this.selection.querySelector('option[value="__imported"]')?.remove(); this.selection.add(new Option(`Imported: ${imported.label}`, '__imported')); this.selection.value = '__imported'; this.fields(true);
      element('pdf-template-error').textContent = '';
    } catch (error) { if (generation === this.generation && request === this.requestId && this.dialog.open) this.error(error); }
    finally { if (generation === this.generation && request === this.requestId) { this.importing = false; this.submit.disabled = !this.selectedRevision(); } }
  }
}
