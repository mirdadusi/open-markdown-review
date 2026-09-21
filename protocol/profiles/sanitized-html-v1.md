# Sanitized Markdown HTML profile v1

Status: normative optional rendering profile for Open Markdown Review 0.5. The key words MUST, MUST NOT, SHOULD and MAY express conformance requirements.

This profile supports structural HTML commonly produced by document-conversion tools while keeping the frozen Markdown and append-only review package as the only authority. It does not permit review-supplied executable code, CSS, live images or a second HTML document model.

## Activation and compatibility

A package using this profile MUST advertise and require `sanitized-html-v1` in immutable `manifest.capabilities` and `manifest.requiredCapabilities`. Every admitted revision in that package MUST set:

```json
{ "renderer": { "markdownProfile": "commonmark-gfm+sanitized-html-v1" } }
```

The capability and renderer profile are a bidirectional invariant: declaring only one is invalid. A participant writer that does not implement this profile MUST refuse participation and approval; it MAY expose exact frozen bytes in a clearly labeled inspection-only view. A `commonmark-gfm` revision retains the prior behavior in which raw HTML is rendered as literal text. An immutable manifest cannot adopt this profile later, so a legacy package needing HTML semantics requires a new review.

The sanitizer operates after CommonMark/GFM tokenization with raw-HTML token recognition enabled. Authoring inspection, VS Code, the portable browser client and audit export MUST use the same profile implementation. HTML comments and unsupported syntax remain in the frozen Markdown bytes but do not become active DOM.

## Allowed elements

Only these lower-cased element names are active:

```text
a abbr b blockquote br caption code col colgroup dd del details div dl dt
em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre
s small span strike strong sub summary sup table tbody td tfoot th thead tr
u ul
```

Names are matched ASCII-case-insensitively. HTML comments are omitted from the visual rendering. Every other tag, including `script`, `style`, `iframe`, `object`, `embed`, `form`, `input`, `button`, `video`, `audio`, `svg`, `math`, `link`, `meta` and `base`, MUST be escaped and displayed as inert literal text. Unsupported-tag names MUST be recorded as revision diagnostics. The text between unsupported opening and closing tags remains inert reviewable text.

Implementations MUST reconstruct allowed tags from parsed fields and MUST NOT copy a source tag or attribute string into the DOM. Source `class`, `style`, `on*`, `srcset`, `target`, `rel`, ARIA, `data-*` and all attributes not listed below are discarded. Attribute character references are decoded before validation.

| Element | Preserved source attributes | Rule |
| --- | --- | --- |
| All allowed elements | `id`, `title` | `id` is 1–128 ASCII letters, digits, `_`, `.`, `:`, or `-` and is emitted only as namespaced client bookmark metadata, never as a source-controlled global DOM ID. `title` is at most 512 characters. Values are HTML-escaped on output. |
| `a` | `href` plus common attributes | See reference rules below. The client supplies safe `rel`/`target`; source values are ignored. |
| `img` | `src`, `alt`, `width`, `height` | `src` binds only to a verified frozen image. Dimensions are decimal integers from 1 through 10,000. |
| `td`, `th` | `colspan`, `rowspan` | Decimal integers from 1 through 100. |
| `ol` | `start` | Decimal integer from 1 through 100,000. |
| `details` | Boolean `open` | Presence is preserved; its source value is ignored. |

The tokenizer recognizes comments, quoted/unquoted attributes and `>` only outside quotes. It considers at most 64 attributes per tag. An unterminated tag is text. Content inside rejected HTML raw-text elements (`script`, `style`, `textarea`, `xmp`, `iframe`, `noembed`, `noframes`, and `plaintext`) is one inert text region: tag-looking strings inside it cannot discover resources or become active allowed elements. Source text and attribute values use HTML character-reference decoding; reversible maps retain offsets into the exact original UTF-16 source. Malformed nesting is interpreted by the standard HTML parser after sanitization and MUST never enable a rejected tag or attribute.

## Images, attachments and references

An allowed `<img src="REFERENCE">` is semantically identical to a Markdown image for capture and audit:

- its resource ID is `resource_` plus the first 24 hexadecimal characters of SHA-256 over `document + NUL + decoded REFERENCE`;
- authoring MUST capture and verify the referenced image before publishing the revision;
- clients MUST load only the content-addressed revision resource and MUST NOT fetch `src` during review or export;
- a missing or mismatched image resource invalidates the revision; and
- `srcset` and every network or script-capable image attribute are ignored.

An allowed `<a href="REFERENCE" title="review:attach">` is an explicit attachment and follows the ordinary frozen-attachment rules. Other absolute `http`, `https`, `mailto` and `file` references are recorded in `externalReferences` using the decoded original reference for semantic-ID derivation and the existing sanitized metadata form. Recording does not archive the destination. Only `https` and `mailto` are actionable in a participant UI; recorded `http` and `file` references are blocked. Protocol-relative and every other scheme, including `javascript` and `data`, are also blocked and remain inspectable only in the exact frozen source. Relative document/fragment references may navigate only within the pinned revision and never obtain direct filesystem access.

The frozen Markdown can itself contain credentials or secrets even when descriptor metadata is redacted. Creation MUST disclose detected secret-bearing references before publication; sanitization is not secret removal.

## Semantic targets and source mapping

Raw and Markdown tables share one zero-based table ordinal in source-token order. A raw table ID uses the existing `table_` derivation over `document + NUL + ordinal`. Rows follow `<tr>` source order; a cell coordinate is the zero-based index of its `<td>` or `<th>` element in that row. `rowspan` and `colspan` affect visual layout but do not expand semantic coordinates. Nested tables receive their own ordinal and context.

A raw table or cell anchor uses the exact source range from its opening `<table>` through the matching closing `</table>` (or the end of its raw fragment when unclosed), plus its semantic table/cell target. An image anchor covers the exact `<img>` tag. Visible text within allowed or escaped HTML is mapped back through decoded character references to exact frozen-source offsets. Safe source `id` values may be used for in-revision heading/bookmark navigation through client-owned metadata, but cannot collide with or clobber toolbox DOM IDs and are not review authority.

Comments, replies, decisions, suggestions, approvals and lifecycle rules do not change under this profile. Suggested edits still require an exact editable source range; a client MUST refuse an ambiguous mapping rather than attach or apply it elsewhere.

## PDF and audit requirements

The audited PDF MUST consume the same sanitized DOM and frozen resources used by the participant view. It MUST preserve readable raw tables, including `rowspan` and `colspan`, and include their anchored findings in the challenge map and full finding history. HTML comments and discarded attributes need not be printed, because the exact frozen Markdown blob and digest remain in the package inventory. The export renderer records `omr-sanitized-html-v1` (plus any independently versioned SVG sanitizer) in `renderer.sanitizerVersion`.

No network request, raw source HTML execution or profile-specific mutable file is permitted during review or export. The profile changes only deterministic rendering/resource discovery; the manifest, revisions, blobs, independent event files and exports remain the single source of truth.

## Minimum conformance corpus

A conforming implementation tests the same package in its native client and portable browser client with mixed Markdown/raw tables, merged cells, inline and block tags, HTML comments, numeric and named entities, local/data/HTTPS images, attachments, internal links and external schemes. It also tests malformed/unknown tags, `script`, `style`, event handlers, `javascript:` URLs, dangerous image attributes, oversized spans/dimensions, missing resources, exact text/table/cell/image anchors, highlights/navigation and offline audited PDF output. The test MUST prove that rejected markup is inert, not merely visually hidden.
