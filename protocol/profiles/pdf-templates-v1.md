# Optional PDF presentation profile v1

Status: implementation/development profile; not a new core protocol version.

Presentation is an export concern. Implementations MUST NOT rewrite an immutable
manifest, revision, policy or source blob to select an export template. Corporate
presets and editable cover metadata are client features, not review event types
or evidence of identity, participation, approval or signature.

## Exact rendering inputs

A non-default audit exporter using this profile MUST:

1. Validate the presentation against the bounded `omr-pdf-template/1` contract
   described in [the client guide](../../docs/PDF-TEMPLATES.md).
2. Serialize `{kind: "omr-pdf-render-input/1", template, metadata}` as UTF-8
   without a BOM using two-space JSON indentation and a final newline. Object
   fields use the displayed order. Template fields are ordered `schemaVersion`,
   `id`, `version`, `label`, `distribution`, `cover`, `css`, optional `logoSvg`,
   optional `defaults`, optional `coverSections`, optional `pageFields`. Section
   fields are ordered `title`, `fields`, optional `showEmpty`; each field is
   `key`, `label`, optional `required`, optional `help`, optional `placeholder`.
   Absent optional properties MUST NOT be added to legacy receipts.
   Metadata (including defaults) is ordered `title`, `project`, `product`,
   `projectId`, `paNumber`, `productFamily`, `author`, `documentId`, `version`, `date`,
   `status`, `division`, `classification`, `confidentiality`, `templateCode`;
   empty values are omitted and nonempty values trimmed. Values are single-line,
   at most 160 characters (400 for confidentiality). All objects reject unknown
   fields. The receipt is limited to 98,304 bytes.
3. Publish those exact bytes as an ordinary content-addressed JSON blob and
   include its file evidence in the audit inventory's sorted, unique
   `resources`. This is a **render-only input**, not an amendment to the
   revision's reviewed resource list. Existing frozen resources MUST remain.
4. Append exactly one semicolon-separated renderer `pdfEngine` token
   `omr-pdf-template-v1=sha256:<64 lowercase hex digits>` identifying that blob.
   Preserve the engine version, layout profile, fonts and other renderer fields.
5. Bind the same receipt fingerprint in the PDF keywords as
   `omr-pdf-template/1 sha256:<digest>`. Bind the final PDF, inventory and
   `export.created` event using the existing exact-byte publication rules.

The receipt MUST be published before an event that refers to it. A verifier
recognizing the profile MUST reject absent/duplicate/inconsistent receipt
evidence, changed bytes, unsupported receipt shape or noncanonical encoding.
Edition restrictions govern template selection, not reading another edition's
archive: a public verifier may verify an enterprise receipt without gaining that
preset as a selectable/renderable feature. No receipt is executed as CSS/HTML.

The existing v0.5/v0.6 wire schemas are unchanged. Older readers can verify the
extra resource's exact bytes but do not thereby claim template-profile
conformance. Unknown renderer profiles must not be treated as proof of
independently reproduced page layout. This profile is not PDF/A certification,
a digital signature or a reproducible-build guarantee.

## Declarative export form

`coverSections` SHOULD drive the client's cover-metadata form, preserving
section/field labels and order rather than maintaining a second hard-coded form.
Optional `pageFields` declares editable title/header/footer metadata controls,
with no duplicate keys across either list. Clients MUST treat all guidance and
labels as inert text, enforce the documented bounds, and MUST NOT execute
template-supplied HTML, scripts or validation code. Supported metadata keys and
their meanings remain fixed by this presentation profile.

When the cover is enabled, exporters MUST reject a missing or whitespace-only
value for a declared `required: true` field before publication. A placeholder
or `showEmpty` marker is not a value. Defaults may satisfy a requirement unless
explicitly cleared. These checks apply to UI and programmatic exports alike.
They are presentation requirements, not approval rules or evidence of identity.
Cancelled form drafts MUST NOT publish review events or change shared state.
Only the selected form's submitted fields should be persisted as user choices;
hidden drafts from another template MUST NOT leak into the export. Template
defaults remain explicit, receipt-bound rendering inputs.

## Modes and defaults

### Optional document list

The per-export boolean `includeDocumentList` is separate from the template
definition. It controls only an index/table-of-contents projection and MUST NOT
omit frozen documents, resources, findings or review evidence from the selected
export mode. Existing source links and PDF destinations MUST remain usable when
the list is disabled. A clean index uses document/slide titles and page numbers,
not generated review identities or participation data.

New archive renderers using the option MUST record exactly one
`omr-document-list-v1=included` or `omr-document-list-v1=omitted` token in the
semicolon-separated `renderer.pdfEngine`, and the same token in PDF keywords.
The existing inventory and export event bind this descriptor without changing
the immutable revision or core wire schema. Unsupported values or duplicate
declarations for this profile MUST be rejected. The template receipt itself remains a template and
metadata input; the index choice is not silently inserted into that JSON shape.

For compatibility, absence of the token in an earlier review archive means
the list was included. The initial clean-document default is no list. Clean
private recovery records MAY add a boolean `includeDocumentList`, with absence
meaning the earlier no-list layout. UI recovery keys and direct export retries
MUST distinguish changed choices. A saved archive's renderer descriptor is the
source for that archive's recorded list setting.

Human-readable participant summaries MAY be table-only. Omitting duplicate
invitation/completion details or a visible verification-cutoff label MUST NOT
remove underlying events or the inventory's `verifiedAt` timestamp. Approval
and completion remain distinct; presentation wording does not rename protocol
registers or event types.

Default without an explicitly requested document cover MUST retain the
established layout/profile, without a new render-input blob or renderer token.
An opt-in Default document cover is a separate presentation input, bound as
`DefaultDocumentCover` in the render receipt; it never silently alters a pending
legacy Default export. Native PDF findings and nested reply relationships MUST
survive template layout changes. Completion/stance data MUST derive from the
captured review events, never editable template metadata. Descriptive document
status MUST remain distinguishable from review approval.

A clean document projection MUST NOT contain review-only metadata, comments,
review attachments or a falsely asserted audit event. It may contain user-entered
document metadata and presentation branding. Its private recovery record and PDF
may bind a presentation fingerprint, but it is not an audit inventory.

Recovery MUST bind review, revision, actor, output mode and exact presentation
inputs. A writer MUST NOT resume an operation using changed template/metadata
and then silently publish the earlier PDF. Template changes are new export
operations; they do not mutate an earlier archive or its receipt.

## A4 orientation and UNC display

The per-export `orientation` option is independent of the template and applies
to both export modes. `auto` (also the legacy default) permits A4 landscape for
wide tables; `portrait` keeps every page A4 portrait, wrapping cells within the
available width. If content cannot be laid out legibly, fail rather than publish
a clipped PDF. Portrait exports record `omr-pdf-orientation-v1=portrait` in PDF
keywords and, for review archives, in the semicolon-separated
`renderer.pdfEngine`. Clean private recovery records may store `orientation`;
absence means `auto`. A retry with a different orientation is a new export.

A UNC destination is an external reference, not an archive destination.
Renderers may expose the full path as selectable text, but must not turn it
into an active file/network action or fetch the share during export. This is a
presentation rule: it does not add a resource or alter a frozen revision.

## Native discussion projection

`omr-review-annotations-v2` in `renderer.pdfEngine` identifies archives whose
native annotation bodies show the current user-written discussion for the
selected revision. Nested replies retain their PDF reply relationships. Earlier
wording, source anchors and lifecycle and decision events remain exact evidence
in the original review files bound by the inventory; they are not serialized
into comment bodies. Existing archives and exact-byte retries remain unchanged.

`omr-review-annotations-v3` adds one current native PDF Review state per
annotated finding (or per page of a multi-page finding). It uses a separate,
bodyless Text annotation whose `IRT` references the finding on the same page.
For Acrobat interoperability, its annotation flags are Hidden, Print, NoZoom
and NoRotate (30). Hidden takes precedence over Print, so the state record
does not create another visible or printed note. NoView alone does not
register the state on the parent in Acrobat.
The state is attributed to the participant and time of the relevant event;
the parent subject retains the more precise Open Markdown Review state.
Accepted maps to Accepted, rejected to Rejected, and won't-fix/duplicate to
Cancelled. A closed discussion maps to Completed unless a more specific
disposition applies or implementation remains pending. Applied suggestions
map to Completed. A challenged implementation maps to None, as does a reopened
discussion without a decision. Conflicted findings get no native override. These states are
a point-in-time PDF projection, not review events or an import mechanism.
