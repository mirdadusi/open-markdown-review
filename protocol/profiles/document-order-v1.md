# Frozen document presentation order

`omr-document-order-v1` is a presentation profile, not a new required protocol
capability. Canonical inventory order is for validation/hashing; it is not a
chapter sequence. Do not reorder or rewrite immutable manifests, revisions,
events or anchors to change how a reader presents documents.

For a fixed revision, all shared reader controls and both PDF modes use:

1. The root document first.
2. Relative in-scope Markdown links in the frozen root document as author hints.
   Take the first occurrence; ignore fragments when matching paths. Ignore
   code fences, attachment-only links, malformed paths, external URLs, paths
   escaping the package root and links outside the frozen document set.
   Safe HTML anchor references can supply the same hints.
3. A leading numeric chapter from the link's label, otherwise the filename.
   Compare numeric components numerically across directories (1 before 3,
   3.2 before 3.10); compare an optional letter suffix after the numeric parts.
   Root-link order breaks ties, followed by deterministic natural path order.
4. If any linked document has no chapter key, use the root's explicit link
   sequence first. Remaining unlinked documents use numeric chapter order and
   then natural path order. No document is dropped or duplicated.

Natural ordering compares numeric runs as integer strings (leading zeroes do
not change their value); other characters and final ties use code-unit order,
independent of OS locale. A shorter equal chapter prefix precedes its children.

This is a deterministic presentation derived only from frozen inputs. It never
discovers files or fetches links. Slide decks retain their explicit slide order;
their frozen-source file list can use this profile independently. Authors should
use chapter-prefixed filenames or an unnumbered root index for a clear sequence.

Compute the order lazily and cache it per immutable revision. Polling, write
authorization and native validation must not trigger a body read for presentation
ordering. PDF generation uses the already-verified audit bytes, not workspace
files. Review archives identify the profile in `renderer.pdfEngine`; clean
documents identify it only in PDF presentation metadata. Previously planned
exports retry their original bytes; they are not silently rendered again.

This does not assign cross-document heading numbers, prove semantic chapter
structure or change finding membership, revision selection or reviewer progress.
