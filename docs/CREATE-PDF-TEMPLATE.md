# Create a PDF export template

This guide is for template authors. It applies to 0.7.0 in VS Code and in the
browser toolbox, including the Go companion. Older clients may not support
these fields.
No application build is needed to **import** a template into a supporting client.

A template is a small UTF-8 JSON file, not an HTML page or a Word template. It
defines PDF styling, optional cover tables, and the fields shown in **Export
PDF...**. One `coverSections` definition drives both the form and the PDF tables.
The Markdown, frozen revision, comments and reviewer state remain unchanged.

For all accepted properties and styling limits, see the
[template reference](PDF-TEMPLATES.md). For exact export evidence, see the
[optional presentation profile](../protocol/profiles/pdf-templates-v1.md).

## 1. Start with the neutral example

Download or copy [the complete starter template](../examples/pdf-template.json).
Open it in a text editor, such as VS Code, and save your copy as
`my-spec-template.json` using UTF-8. Keep the `.json` extension; use ordinary
JSON without comments, trailing commas or duplicate property names.

Change these properties first:

- `id`: your stable template identifier, for example `TeamSpec`. Start with a
  letter; use at most 64 letters, digits, underscores or hyphens. `Default` is
  reserved. This is a template ID, not a review or reviewer ID.
- `label`: a short, recognizable name shown in the template selector.
- `version`: a three-part numeric version, such as `1.0.0`. Increment it when
  changing a distributed template. Version suffixes are not supported.
- `distribution`: keep `"all"` for a template usable in both editions.
  `"enterprise-only"` is rejected by the public client; it is a distribution
  restriction, not authentication or a license grant.
- `cover`: `true` initially enables the document cover. The exporter can turn
  it off in the dialog; it is not an enforced document-approval policy.
- `css`: retain the starter's token styling initially.

The starter requires a **Specification number**. For a first test, enter
`DOC-123` in the export dialog. This value is an example, not an identifier
assigned by the application.

## 2. Define the cover tables and form

Each item in `coverSections` becomes a titled PDF table and a dialog group.
Sections and their fields appear in the declared order. For example:

```json
{
  "title": "Document",
  "showEmpty": true,
  "fields": [
    {
      "key": "documentId",
      "label": "Specification number",
      "required": true,
      "help": "Use the assigned document identifier.",
      "placeholder": "DOC-123"
    },
    {
      "key": "author",
      "label": "Prepared by"
    }
  ]
}
```

This is a **section fragment** to place inside the complete template's
`coverSections` array, not a standalone template file.

Use `label` to change wording and move fields to change ordering; keep `key`
unchanged. Keys have fixed meanings. You cannot introduce arbitrary new keys,
input widgets, formulas or scripts. Section titles and labels are plain text,
not HTML. There may be 1-4 sections with 1-12 fields each, subject to the finite
key list below. A key may occur only once across all sections and `pageFields`.

All fields are optional unless their definition says `"required": true`.
A required blank or whitespace-only value blocks export while the cover is
enabled. A placeholder is only a hint: it does not fill the field. `showEmpty`
makes optional missing table values appear as **Not provided**; omitting it
omits those blank rows. It never satisfies a requirement.

Labels and section titles are limited to 80 characters. Optional `help` is
nonempty, single-line text up to 240 characters; `placeholder` is up to 160.

### Available metadata keys

| Key | Meaning and output use |
| --- | --- |
| `title` | Document title on the cover, in page labels and PDF title metadata |
| `project` | Project name/version; also used by the page header |
| `product` | Product name/version in a configured cover-table row |
| `projectId` | Project identifier in a configured cover-table row |
| `paNumber` | PA number in a configured cover-table row |
| `productFamily` | Product family in a configured cover-table row |
| `author` | Document author in a configured cover-table row; not reviewer identity |
| `documentId` | Document number/identifier in a configured cover-table row |
| `version` | Document version; also used by the page header |
| `date` | Descriptive document date; also used by the page header |
| `status` | Descriptive document status in a configured cover-table row |
| `division` | Organization/division above the cover title and in the page header |
| `classification` | Classification in a configured row and the page footer |
| `confidentiality` | Note on the cover and in the page footer |
| `templateCode` | Template identifier/code in the page footer |

Values are single-line text up to 160 characters, except `confidentiality`,
which allows 400. Nonempty values are trimmed. The date is descriptive text,
not an automatically verified date or a date-picker control. Use a consistent
format, such as `YYYY-MM-DD`.

Document author, status, classification and version do not establish reviewer
identity, completion, approval or a signature. Do not put reviewer progress or
approval records in a template; those come from actual review evidence.

## 3. Choose title, header and footer controls

Use `pageFields` for editable title/header/footer values that should **not**
be extra cover-table rows:

```json
[
  { "key": "title", "label": "Document title" },
  { "key": "division", "label": "Organization" },
  { "key": "confidentiality", "label": "Confidentiality note" }
]
```

This is the value of the complete template's `pageFields` property.

Supported keys here are `title`, `project`, `version`, `date`, `division`,
`classification`, `confidentiality` and `templateCode`. Do not repeat a key
already in a cover section: its value is reused by the page labels regardless
of which group contains its input.

The title control is placed above the cover-table groups. Other page controls
appear in **Page header and footer labels**, in the declared order. That section
opens automatically if it contains a required field. These controls support the
same `required`, `help` and `placeholder` properties as table fields.

Use `"pageFields": []` to omit the extra page controls. Omitting the property
instead keeps the legacy page controls, excluding keys already in cover tables.
Templates without `coverSections` retain the legacy single metadata table.

This does not provide arbitrary header/footer layout editing. Each supported
key retains its defined output location, and long page labels are abbreviated.

## 4. Add defaults and adjust styling

Optional `defaults` supplies initial metadata values, for example:

```json
{
  "title": "Feature specification",
  "status": "Draft"
}
```

This is the value of a `defaults` property. Declare editable fields for values
you expect users to change. Defaults are still rendering inputs even if you
omit their controls. Avoid embedding personal details, real project data or
secrets in a reusable template.

Explicit user input overrides defaults; an explicitly cleared field stays
cleared. Untouched defaults follow the selected template. Defaults may satisfy
required fields, so do not provide an example default where you need the user
to supply an actual identifier. Confirmed choices are private per client and
review. Old stored choices without edit tracking are preserved for compatibility.

The `css` property is a string containing one `:root` block of supported PDF
tokens, not general CSS. For example:

```css
:root {
  --body-size: 10pt;
  --heading-color: #204060;
  --table-header: #e7eef5;
  --margin-left: 18mm;
  --margin-right: 18mm;
}
```

Put this block inside the JSON `css` string, escaping line breaks as `\n`, or
keep it on one line like the starter. Use the
[token reference](PDF-TEMPLATES.md#custom-styling) for names, units and ranges.
Ordinary selectors, `@import`, URLs, custom fonts and executable CSS are
unsupported. The client uses its embedded Roboto/Noto fonts, A4 pages and existing
wide-table pagination. Changing a template does not change the Markdown viewer.

For a style-only template, a UTF-8 `.css` file containing just that token block
can also be imported. JSON is needed to define custom form groups, labels,
requirements, defaults or an embedded logo.

### Optional logo

The JSON property `logoSvg` accepts an inline, self-contained SVG string up to
64 KiB, starting with `<svg`. It does not accept a filename, a relative path,
an XML declaration before the root element or a URL. For example:

```json
{
  "logoSvg": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"120\" height=\"24\" viewBox=\"0 0 120 24\"><rect width=\"120\" height=\"24\" fill=\"#204060\"/></svg>"
}
```

This is a property fragment, not a standalone template. Use only artwork you
have permission to redistribute. Active content and external references are
rejected. Import validation checks the template structure; SVG sanitization and
image decoding also run during export. Successful import alone is not a complete
PDF qualification.

## 5. Import and verify it

Use a disposable review containing representative documents, not an ongoing
production review, while designing the template.

1. In a template-enabled client, open the rendered review and select **Export
   PDF...**.
2. Expand **Advanced: import a custom template** and choose your JSON file.
   Its label appears as **Imported: ...** in the template selector.
3. Check the table groups, field labels, order, guidance and default values.
   Choose **Include document list (table of contents)** separately: this affects
   only the index pages, not which documents are exported. Its initial default
   is on for an archive and off for a clean document. Do not put
   `includeDocumentList` in the template JSON; it is a user export option.
   Complete the required fields. Leave a required field blank once to confirm
   that export stays in the dialog and focuses the missing value.
4. Try switching templates and back, clearing a default, and cancelling the
   dialog. Cancel must not publish an export or save the new choices.
5. Export both a **Clean document** and a **Review archive**. The latter records
   its normal audit event, so do this in your disposable review.
6. Open the actual PDFs. Check the cover, headers/footers, page numbers, Unicode,
   images, Mermaid, links and wide tables. In the archive, open the PDF reader's
   Comments panel and check a comment with a reply. A clean document must not
   contain generated review information or review comments.

PDFs are saved in the review folder's `exports/` directory; the browser also
offers a download. The responsive Markdown view is not a paginated PDF preview.
The whole template file must fit within 96 KiB, including CSS and any inline SVG.

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| No template dialog or import control | The installed client/toolbox may predate this development feature. Updating an extension does not automatically replace an existing review's toolbox. |
| Invalid JSON / duplicate property | Remove comments, trailing commas or repeated property names; save as UTF-8. |
| Unknown field or invalid metadata key | Use the supported keys and exact capitalization; customize `label`, not `key`. |
| Duplicate cover/page field | Put the key in exactly one group; its value is reused where the layout needs it. |
| Unsupported CSS token / range | Use only documented tokens with the stated units and bounds. |
| Required field still missing | Supply an actual non-whitespace value. A placeholder and **Not provided** do not count. |
| SVG rejected when exporting | Remove active/external content and use a bounded, standalone inline SVG. |
| Header text shortened | Page labels have bounded widths. Use concise values; put full descriptive data in a cover-table field when needed. |
| Style differs from a web/Word template | This is a token-based adapter to the shared PDF engine, not a browser stylesheet or Office template renderer. |

## 6. Share and maintain the template

Share the JSON file separately, or version it in your team's normal Git
repository. Other exporters import their own copy. Importing a file does not
install a permanent organization-wide preset, invite reviewers or change the
review's manifest, policy, immutable documents or prior exports. The dialog
retains one imported-template choice at a time; importing another replaces that
choice. Confirmed presentation preferences are remembered privately per review
on that client.

A review archive binds the exact effective template and metadata in its
render-input receipt, so later changes to your JSON cannot restyle that existing
PDF. A clean export is a document projection, not an audit archive. See
[integrity and recovery](PDF-TEMPLATES.md#integrity-and-recovery) for details.
Keep the stable `id`, increment `version` for changes, and retain old template
files when reproducibility or organizational traceability matters.

Bundled presets are maintained separately in the edition's
`release/pdf-templates.json` and require a rebuilt, qualified client. Importing
a JSON file is the normal user workflow and requires no changes to that
registry. Do not edit generated review HTML or immutable review files to
register a template.
