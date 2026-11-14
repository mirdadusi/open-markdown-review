# PDF presentation templates

Available in 0.7.0. The public client ships only the generic **Default**
template. You can optionally import your own tokens or a JSON template. No
existing review must be recreated or migrated to use these controls.

For a practical walkthrough, start with [Create a PDF export template](CREATE-PDF-TEMPLATE.md)
and the [complete neutral example](../examples/pdf-template.json). This page is
the format, security-limit and audit reference.

In the rendered review, choose **Export PDF…**. One confirmation dialog opens in
VS Code, the portable HTML toolbox and the Go/legacy Node browser clients. Choose
the **Snapshot to export**, template and PDF type. The unique latest snapshot is
the default even when you are reading an older one; competing branch heads
require an explicit choice. Counts show the chosen snapshot's scope, and export
does not switch your document view. See [comments and export snapshots](COMMENTS-AND-EXPORT-SNAPSHOTS.md).
Enable **Include a document cover** to enter the
selected template's fields, using its table groups, labels and order. Default
uses **Project / Product** and **Document** tables. Header/footer labels are
under an optional details section, expanded automatically if it contains a
required field. Then press **Export PDF** to start. **Cancel**
or Escape discards the draft and does not publish anything. Advanced CSS/JSON
imports are available in a collapsed section, not required for ordinary exports.
The VS Code export command opens this same dialog. Open the resulting PDF to inspect pagination; the
responsive Markdown view is not a PDF page preview.

**Include document list (table of contents)** adds or removes the separate
clickable index, independently of the template and cover. All frozen documents
and their content links remain exported either way. The initial default is on
for a review archive and off for a clean document; an explicitly confirmed
choice is remembered privately. This is a per-export choice, not a property
inside a template JSON file. The programmatic export option is the boolean
`includeDocumentList`.

**Default** remains selected initially with its document cover off, using the
established document styling. Its optional cover is an explicit presentation
choice, not a silent change to existing exports. Presets can enable their cover
by default. Switching templates preserves explicitly entered values (including
deliberately cleared fields) by metadata key. Untouched defaults follow the
selected template, not the previous one. Fields absent from the selected form
are not submitted, persisted or copied into that export's metadata. Their
unconfirmed drafts remain available if you switch back within the dialog.
Required fields are marked, explained and focused if missing, before any PDF or
event is published. All Default fields remain optional; templates may declare
requirements for their cover. The cover can be disabled again.
Switching templates never changes the Markdown, manifest, revision, comments,
reviewer progress, lifecycle or approval policy. Settings are private browser
preferences per review, backed by the private client journal (with browser
storage for compatibility), not shared configuration. Reviewers on other computers
choose their own presentation; exporting does not change their settings.

The native PDF comments pane shows the selected snapshot's discussion: current
comment text, nested replies and suggested edits. Authors and dates use native
PDF fields. Source excerpts, event IDs and serialized workflow events are not
inserted into comment bodies. Earlier wording and workflow history remain in the
immutable event files identified by the audit appendix and detached inventory.
Compatible PDF readers can show native finding statuses such as Accepted,
Rejected, Cancelled and Completed. The annotation subject retains the precise
review status, including open/closed and implementation pending, even where
the PDF state model has no equivalent. In Acrobat, review status is
author-specific: check the comment's review history for the archived
participant's status. Changing a status in the PDF never syncs it back.
**Reviewer completion and participation** contains the status table only, with
**Review decision** as its approval/rejection column. Invitation details,
completion/reopen notes and participant event IDs are not repeated below that
table. The underlying events and audit appendix/inventory remain intact.
Verification timing stays in the machine-readable inventory, not a visible
verification-cutoff field. Reviewer colors are unchanged.
The clean PDF has no review identity, participants, comments, audit pages,
attachments or export event. Optional document metadata that you explicitly
enter is included in both modes. A document status label is descriptive, not a
review approval. Empty fields are omitted; titles fall back to the review title
for an archive and the root document title for a clean export.

## Custom styling

Import a UTF-8 `.css` token file or a self-contained `.json` template (maximum
96 KiB). This is an explicit PDF presentation API, **not general browser CSS**.
Only one `:root` block of the following custom properties is accepted:

| Tokens | Supported values |
| --- | --- |
| `--text-color`, `--heading-color`, `--link-color`, `--border-color`, `--table-header`, `--table-stripe` | Six-digit `#rrggbb` |
| `--body-size`, `--table-size`, `--h1-size`, `--h2-size`, `--h3-size` | 8–24pt |
| `--line-height` | 1–2, unitless |
| `--margin-left`, `--margin-right` | 10–35mm |
| `--margin-top`, `--margin-bottom` | 22–35mm; room for page furniture |
| `--cover-top` | 10–35mm; independent first-page top position |
| `--heading-rule` | 0–1.5pt; line below source level-one headings |
| `--table-padding-x`, `--table-padding-y` | 2–8pt; column widths account for padding |

For example:

```css
:root {
  --body-size: 10pt;
  --heading-color: #204060;
  --table-header: #e7eef5;
  --margin-left: 18mm;
  --margin-right: 18mm;
}
```

A CSS import uses a neutral layout without an added cover. To enable the cover
and optional self-contained SVG logo, use the JSON form:

```json
{
  "schemaVersion": "omr-pdf-template/1",
  "id": "NeutralSpec",
  "version": "1.0.0",
  "label": "Neutral specification",
  "distribution": "all",
  "cover": true,
  "css": ":root { --body-size: 10pt; --heading-color: #204060; }"
}
```

JSON templates may additionally declare `defaults` (document metadata only) and
`coverSections`: 1–4 ordered objects with `title`, `fields` and optional
`showEmpty`. Each section has up to 12 fields of the form
`{"key":"project","label":"Project name / version"}`. A metadata key may occur
only once across sections. Titles/labels are limited to 80 characters. Grouped
covers use separate titled key/value tables and a title rule; `showEmpty: true`
labels missing values **Not provided**, never invented identifiers. Defaults are
overridden by entered metadata; an explicitly empty field clears its default.
Additional descriptive fields are product, project ID, PA number, product family
and document author. None represents a review signature or approval.

### Template-driven export form

`coverSections` is the single definition for both PDF cover tables and the
dialog's fieldsets. Field order, section titles and field labels are used
verbatim as plain text, never as HTML. Each field may additionally declare:

```json
{
  "key": "documentId",
  "label": "Specification number",
  "required": true,
  "help": "Use the assigned document identifier.",
  "placeholder": "DOC-123"
}
```

`required` is an optional boolean (default false). `help` is a nonempty
single-line string up to 240 characters; `placeholder` is up to 160. Placeholders
are hints, not values. Required whitespace-only values fail in the dialog and
the export API/CLI alike. `showEmpty` only controls optional blank PDF rows; it
does not satisfy a requirement. Requirements apply when the cover is enabled.
No required fields are invented by the client.

An optional ordered `pageFields` array defines editable title/header/footer
labels that are **not** additional cover-table rows. It accepts up to eight of
`title`, `project`, `version`, `date`, `division`, `classification`,
`confidentiality`, `templateCode`, using the same field contract. Keys must be
unique across both `coverSections` and `pageFields`. The title control, if
declared here, is placed above the tables; other controls are in **Page header
and footer labels** in the declared order. `pageFields: []` omits these extra
controls. This selects editable controls, not a different page-furniture engine:
each key keeps its defined title/header/footer meaning.

For older templates omitting `pageFields`, the form offers the existing page
labels, excluding keys already present in the cover tables. Templates omitting
`coverSections` retain the legacy single metadata table and matching form
fields. Default's neutral grouped cover is defined once in shared code. Custom
field names, arbitrary input widgets, scripts and executable validation are not
supported. The same form model is used in VS Code, direct HTML and both
companions; it does not require new server endpoints or protocol events.

The programmatic `includeCover` option explicitly enables the neutral grouped
cover for Default, or overrides a selected template's cover flag. Effective
presentation bytes, not just the checkbox value, bind recovery and audit receipts.
Default without a cover still rejects cover metadata rather than silently losing it.

Template IDs are case-sensitive, start with a letter, and contain up to 64
letters, digits, underscores or hyphens. `Default` is reserved. Unknown fields,
duplicate JSON keys/tokens, invalid ranges, additional selectors, CSS imports,
URLs, expressions, scripts and custom fonts are rejected, not silently ignored.
An optional `logoSvg` is an inline SVG string (up to 64 KiB); the normal static
SVG sanitizer and image decoder run before any PDF publication. External image
references and active SVG are not allowed. Imported CSS is never applied to the
review UI. Fonts are the existing embedded Roboto and Noto fallbacks on every
platform; templates cannot introduce an OS font or network dependency.

Both orientations remain A4. **Automatic (A4)** retains landscape document pages
for wide source tables. Select **A4 portrait** in either export mode to keep all
pages vertical, with table cells wrapped to the available width. Windows UNC
references are printed as selectable external network paths, not internal PDF
destinations. The exporter does not access the share. An approved HTTPS reference
can be used when a clickable link is required.
When the label is the same path (with or without the final folder separator),
the PDF prints the exact destination once, including its original separator.

Column widths are recalculated for template margins and font size, headers
repeat, images retain proportions and native comments follow final layout.
Headings below level three use decreasing sizes bounded by the body size.
Overly dense/unrenderable source content fails before publication rather than
creating a knowingly clipped PDF. Page headers/footers abbreviate long labels;
full document metadata is retained on a configured cover and in the audit
render-input receipt. A cover is not a signature page or approval record.

## Integrity and recovery

Templated audit exports record the exact template, CSS, embedded logo and
metadata in a content-addressed render-input receipt, separate from reviewed
revision resources. Its digest is bound in both PDF metadata and the existing
renderer descriptor. The font-set and renderer versions remain recorded too.
See the [optional export profile](../protocol/profiles/pdf-templates-v1.md).

Clean exports remain non-audited document projections. Their private recovery
record and PDF metadata bind the template fingerprint; they do not publish a
review inventory or embed hidden review evidence.

Retries must use the original template and metadata. A changed selection uses a
different private UI recovery key; direct attempts to reuse an operation ID with
different presentation inputs fail. Default retains compatibility with pending
pre-template export plans. Neither changing a template nor cancelling its dialog
publishes a review event.

The document-list choice also separates private recovery keys. New review
inventories and PDF keywords record `omr-document-list-v1=included` or
`omr-document-list-v1=omitted`. An earlier archive without that marker has its
original included list. Clean recovery records bind the choice privately;
earlier clean records without a setting mean no list. A retry with a changed
choice fails rather than publishing the earlier PDF under new options.

## Development checks

```sh
npm run test:pdf-templates
OMR_PDF_TEMPLATE_HTTP=true node --test out/test/pdfTemplate.browser.integration.js
# After building a matching native development companion:
OMR_GO_COMPANION=/absolute/path/to/StartReview node --test out/test/pdfTemplate.browser.integration.js
# Isolated VS Code webview (does not install in your normal profile):
node scripts/test-extension.mjs pdf-templates
```

The tests exercise actual PDF generation, links, Unicode, images, wide tables,
native comments/replies, clean-mode privacy, template recovery and client UI
preferences, template-defined labels/order, required fields, safe plain-text
guidance, defaults/clear/switch behavior, hidden-field exclusion and cancellation.
Samples are written to `output/pdf/templates-*.pdf` and
`output/pdf/template-driven-configuration.pdf`. Template
development does not qualify newly embedded Go binaries for a release; normal
three-platform packaging and target-platform qualification still apply.
