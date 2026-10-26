# Shared reading and identity UX — product 0.6.5

## Standard boundary

Protocol 0.6.0 remains unchanged. Frozen documents/resources, source anchors,
append-only events, roster membership, self-asserted identities and explicit
completion are normative protocol data. A viewport, reading history, display
mode, loading state and onboarding text are disposable client preferences,
not additional review evidence. All clients use the existing source of truth.

## Navigation and continuous reading

- Back, Previous/Next, the document counter and the continuous-reading checkbox
  share the existing sticky action bar beside Export PDF; there is no additional
  document header. The compact counter exposes the document path through its
  tooltip and accessible name. Controls wrap within the toolbar on narrow views;
  checkbox help remains available to assistive technology and through a tooltip.
- Explicit document selection, including selecting the same document, and plain
  in-scope Markdown links start at the document boundary below the action bar.
  Fragment links instead show the heading/bookmark; finding links show the
  anchored passage with context. Missing fragments produce a visible notice.
- Back restores the document-relative position captured before an explicit
  jump. History is bounded to 50 entries and reset on review/revision changes.
- Continuous reading is on by default for ordinary Markdown, can be disabled
  privately, and follows the sidebar order: root first, then frozen inventory
  order. It loads adjacent documents lazily in both directions. Slidev remains
  paged; no slide ordering semantics are changed.
- At most three documents are mounted, with at most one adjacent load in flight.
  Eviction and prepend preserve the active passage's viewport position. Each
  mounted document has its own source text, rendering map and annotation scope.
  Cross-document selections cannot create a finding. A selection or open draft
  pauses automatic mounting/eviction. Async navigation aborts stale rendering.
- Failed adjacent reads show their error and an explicit retry; no document is
  silently skipped. The next document can also be opened through a button or the
  sidebar. Cache/DOM state is neither an alternate document copy nor evidence.
- Background event refresh updates annotations/discussions without navigating,
  resetting the viewport or changing the pinned revision. Reading a document
  does not approve it, finish it or publish any event.

## Participant guidance

Before feedback, a rostered review asks for the address used in the invitation.
An address outside the effective roster gets a factual inline message and
`aria-invalid`; the participant can correct it without losing a draft. A valid
input shows “Reviewing as …”. The field label and help distinguish invited email
from an open-review ID and an initiator ID. Identity remains self-asserted: this
is not an email-verification mechanism, login, operating-system identity or
permission grant. No reviewer is selected automatically from the shared roster.
Reading remains available without an identity; existing creator permissions,
completion locks and invitation admission rules are unchanged.

## Verification

The browser E2E suite exercises document/heading navigation, same-document reset,
position restoration, forward/reverse continuous traversal with bounded DOM,
relative links from nested documents, exact selection anchoring, roster guidance
and non-jumping peer updates. It also checks the shared, compact reading controls
beside PDF export, accessible labels/help, Previous/Next navigation and wrapping
at desktop and narrow viewport widths. It covers the VS Code-style bridge and direct
browser-directory transport; native companion suites execute the same toolbox.
