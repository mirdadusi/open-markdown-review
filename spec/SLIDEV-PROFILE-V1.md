# Slidev static review profile v1

Status: implemented by application 0.5.1; limited-test release, not complete professional-pilot qualification. Profile URI: `urn:open-markdown-review:profile:slidev:1`. Schema URI: `urn:open-markdown-review:profile:slidev:1:schema`.

## Three layers and one authority

1. **Core protocol:** unchanged framework-neutral Markdown/resource snapshots, anchors, append-only events, verification and audit inventories.
2. **Optional profile:** the independently versioned [schema](../protocol/profiles/slidev/v1.schema.json) and the rules in this document, carried through [presentation profile transport v1](../protocol/profiles/README.md).
3. **Client adapter:** shared Slidev navigation/source mapping/export implementation in both the VS Code webview and generated HTML toolbox. VS Code and CLI call the same authoring service. A browser participant cannot create or rebuild a deck.

Only the review package is shared authority. Profile metadata, source and rendered PNGs live once as immutable blobs; references can share the same blob. HTML contains the generic client, not a duplicated deck or private comment database. Neither viewing nor commenting starts a server or runs a Slidev project.

## Supported author input and capture

- The selected root document is the single deck entry. `src:` imports add their Markdown files automatically, including nested imports and explicit `#2,5-7` selections. Imports MUST resolve within the granted source folder; URLs, absolute paths, symlinks, cycles, exclusions of required imports and more than 16 nested levels are rejected. At most 100 documents and 200 expanded slides are accepted.
- Slidev parser and author-side renderer are pinned to **52.19.1**. Both accept LF/CRLF; lone-CR sources are rejected. YAML is parsed without custom tags, duplicate keys or aliases. Code fences and HTML comments do not split slides. Import numbers are one-based and ranges are inclusive. Repeated imports retain one frozen source document.
- Disabled/hidden slides, declared addons and custom preparsers are rejected because the v1 adapter cannot prove their transformed source mapping. This is a bounded static-review profile, not a promise to accept every Slidev project. Import-site layout/frontmatter overrides can affect the captured image; source locations continue to refer to the imported original Markdown, not synthesized merged text.
- Creation explicitly requires trust to execute installed author-project code. VS Code additionally requires a trusted workspace and a modal confirmation. CLI uses `--trust-slidev-project`. No automatic installation, dependency upgrade or project execution occurs when opening someone else's review. Slidev's author-side exporter briefly runs its own local build server; it is not a review server and is not needed by participants.
- Capture requests PNG output for all slides, without separate click-step pages. Exact output numbering/count and image dimensions are checked. Markdown bytes are checked before and after rendering; changed source stops publication. Publication uses the existing private recovery journal and publishes the revision event only after all blobs/descriptors.
- The source and frozen page pixels are the reviewed pair, captured by an explicitly trusted author. PNG hashes prove the reviewed image bytes, not that a trusted renderer honestly produced them from a particular source. The build environment, themes, arbitrary dynamic component dependencies and transient remote responses are not retained as a reproducible project.
- Standard Markdown image references, static frontmatter `image`/`background`/`backgroundImage`, discoverable static image attributes and CSS image URLs are captured as normal resources. Leading `/` image paths resolve under the source project's `public/` folder. Ordinary attachments use `review:attach`. Dynamic expressions and executable component code are not interpreted by the participant client. Dynamic/remote rendering is captured visually, not replayed or guaranteed identical to a separately fetched attachment; authors MUST inspect output before sharing.

## Descriptor and identity rules

`profile`, `entryDocument`, `parserVersion`, `rendererVersion`, `notes`, `capture`, `slides` and `limitations` are required. Unknown properties are rejected. `capture` is `slidev-png-static`; all profile data is JSON, never script or HTML to execute.

Each expanded slide records:

| Field | Meaning |
| --- | --- |
| `number` | Contiguous one-based expanded deck order |
| `document`, `documentDigest` | Exact retained source document and digest |
| `sourceIndex` | Zero-based slide index within that original document |
| `occurrence` | Zero-based import-site indices from root through the final source slide |
| `id` | `stableId('slide', document + NUL + occurrence.join('/'))`, using the existing SHA-256-based stable-ID function |
| `range` | Half-open UTF-16 offsets for the source slide, including its frontmatter/notes when present |
| `contentRange` | Half-open source-body offsets, excluding frontmatter and trailing speaker notes |
| `noteRange` | Optional half-open original trailing-note range; retained for redaction auditing |
| `previewResourceId` | Existing PNG image resource, owned by the same document |

All offsets MUST be in bounds and on Unicode scalar boundaries; content/note ranges MUST lie inside the slide range. Slide IDs and preview resource IDs MUST be unique per expanded deck. The preview's original reference MUST be `PROFILE_URI:preview:SLIDE_ID`. A resource ID is generated using the standard `stableId('resource', document + NUL + originalReference)` function.

Slide identity is scoped by revision and import occurrence. Inserting/removing slides may change later identities in a new revision; threads are never silently migrated. Repeated imports have different image IDs but share source coordinates. The profile MUST NOT claim stable cross-revision pixel, DOM-node or word coordinates.

## Notes and suggestions

Authors explicitly choose **include** or **exclude**. Included trailing speaker-note comments remain in frozen Markdown and audit PDFs. Excluded trailing comments are replaced with spaces except for line breaks before publication; UTF-16 positions and line numbering are preserved. Original note text stays out of the shared snapshot. The profile retains note ranges, not the removed text.

This is not a general secret scanner: other comments, frontmatter, external resources and component-rendered content may still contain private information. A source check and preview inspection are required before sharing. Redacted snapshots intentionally have a different digest from the original file. Automatic suggested-edit application therefore refuses to write an original source that does not exactly match the reviewed digest; apply those changes manually and create a new revision. Do not weaken that safety check.

## Participant workflow and event mapping

- Both clients display an ordered slide list, previous/next controls, frozen PNG preview, a selectable exact-source pane, source-file navigation and capture/notes disclosures.
- Clicking a slide selects the existing image semantic target. A comment's source quote is a short exact portion of that slide, while its image resource ID identifies the full visual occurrence. Whole-slide selection does not promise a rectangle or word-level image anchor.
- Source selections use the same range/quote anchors as ordinary Markdown, including insertion/replacement/strikeout suggestions. Source comments are visible in every occurrence of the same source; visual comments appear only on their specific slide occurrence.
- Clicking an annotation reveals its discussion. Locating a comment switches to its slide/source. Replies, accept/reject decisions, resolution/reopening, revision approval/rejection/withdrawal and concurrent event synchronization use unchanged core events and rules.
- Approvals verify the complete revision, including the schema, profile and every slide image, independent of the currently displayed slide or discussion filter. Unsupported profiles do not allow participation or assertions.

## Audit exports

The shared client-side PDF exporter includes the scope/limitations, every frozen slide in order, included notes, visual comments/replies, all frozen source documents, complete discussion/decisions/suggestions and the exact event/file inventory. Each slide is labeled with its number, identity, source range and frozen image digest. Existing Markdown Mermaid source SVG evidence remains in the audit inventory; the captured PNG is the Slidev visual evidence.

All schemas, descriptors and PNGs are ordinary inventory resources. PDF creation does not change the source, re-run Slidev or fetch external images. Its `export.created` event and recovery semantics are unchanged. An export is evidence of the observed local event set, not a signature or proof that disconnected reviewers have synchronized.

## Qualification and exclusions

Automated tests cover parsing/CRLF/Unicode, fenced separators, notes redaction, repeated/ranged imports, containment/cycles, schema/digest/ownership failures, missing evidence, unsupported capabilities, CLI consent/dry-run, shared rendering/source selections and real Slidev-to-browser-to-PDF flow. The real fixture includes theme layout, Mermaid, a table, image references and styled component markup; it asserts no participant HTTP requests.

Animations, interactive component behavior, video, intermediate click states, rectangular pixel selections, custom preparsers/addons, reproducible dependency closure and automatic rebasing are not covered by v1. Windows executes the same tests in CI. Native browser folder-permission qualification remains a separate open gate. SMB testing remains excluded by the user's prior decision.

The isolated author fixture's upstream PowerPoint-only `image-size` advisories are explicitly tracked in [audit-exceptions.json](../examples/slidev/audit-exceptions.json). That fixture is not shipped; the main application audit has no exception. Never use the fixture for PPTX export. This limitation is not a reason to suppress unrelated audit failures.
