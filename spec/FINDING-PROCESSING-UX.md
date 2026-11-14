# Creator finding-processing UX

Status: development implementation, 2 November 2026; not a published release.
Applies to the shared client in both distributions. The recommended design is
**Guided workbench**; an editor-first alternative is included in the design
preview. Both use the same underlying publication and finding events.

## Outcome and scope

### Independent filters and bounded publication work

- Decision and discussion are separate filters, available to participants as well
  as the initiator. No decision means an empty decision register, including a
  closed discussion; a conflict must not masquerade as undecided or accepted.
- Filters combine with document/snapshot scope, workflow and search. Show all
  findings clears them; locating a highlight must not leave its card filtered out.
- The publish confirmation must paint a busy state before host I/O, show phase,
  file counts and elapsed time, reject duplicate submission and ignore progress
  for other request IDs. Do not imply safe cancellation after publication starts.
- Reuse only request-local, native-verified authority for draft validation and
  post-publication refresh; no authoring authority is cached across requests or
  accepted from participant RPC. Keep a fresh final authority/head/decision check.
- Recheck all saved Markdown and local resources at the publication boundary
  with at most four parallel workers. Drain sibling workers on failure. Preserve
  digest verification, immutable publication, exact retries and partial outcomes.
- These are local presentation/orchestration rules, not new protocol events,
  schema fields, authentication claims or cross-file transaction guarantees.

An initiator should be able to accept a finding, edit working Markdown, publish
its fix and record which finding it addresses to finish processing, without
memorizing a Command Palette command or manually switching revision selectors.

This is a client UX and orchestration change, not a core-protocol migration.
The authoritative records remain the existing immutable revision descriptors,
blobs and independent events. Opening a client does not edit source, publish a
revision, upgrade executable clients or otherwise change a live review.

The discovery gaps addressed by this workflow are:

- The createRevision command has no direct button or context-menu entry.
  Its indirect toolbar entry is named Review Setup and Documents.
- Accepted findings can be closed while still requiring a change, without a
  sufficiently clear explanation that discussion closure is independent.
- Record published fix is hidden when no descendant revision exists.
- Publication and inspection can move the selected revision away from the
  original finding, making the next step hard to find.

## 1. Entry points

### Review toolbar and sidebar

Provide a visibly labeled **Publish updated documents...** action in:

- The native VS Code review toolbar.
- The Active Review tree, as a labeled child action rather than an icon alone.
- The selected review's context menu, under authoring actions.

Keep the existing Command Palette command as a compatible entry point.
The context-menu action MUST bind its explicit review argument; right-clicking
review B must not publish into active review A. Show the review title and
source-to-destination relationship in the confirmation.

Do not confuse this action with the existing operation that copies/shares an
entire review package to another location. A revision is published **into the
same review**; sharing/copying a package is a different action and menu group.

The guided publish-and-record path is initiator-only because recording a fix
requires that role. Existing independent authoring flows retain their current
rules; this design does not invent a new core permission on revision events.

### Accepted finding

Always show a short **Next action** area. For a local initiator:

- **Edit source** opens the bound working file and the original quoted position.
- **Publish and record fix...** opens the guided publication confirmation once a
  saved relevant change is available.
- **Record an already published fix...** is an alternative when a valid
  descendant snapshot already contains the outcome.

Do not silently hide the relevant action. If unavailable, provide an inline
reason and a usable remedy, such as Choose source folder or Save source first.
Essential guidance cannot exist only in a hover tooltip.

### Browser participation

Go and legacy Node companions remain participant transports, not authoring
servers. A browser initiator sees **Continue in VS Code** for source editing
and publication, with a concise explanation. It does not request private
authoring paths, launch a server-side editor or expose a publication RPC.
After a valid revision is published elsewhere, the browser initiator can use
the existing Record published fix capability.

A normal reviewer can inspect the outcome, not invoke creator
decision/source/publication controls. Roles remain self-asserted under the
existing identity profile; UI labels must not imply OS/Entra authentication.

## 2. Terminology and status

Show two clearly separated states:

- **Discussion: Open / Closed** — whether replies and decisions are available.
- **Change: Needs decision / Change required / Implemented /
  Reopened · change required / No change planned / Conflict**.

Map the change labels to the current fold, without adding persisted statuses:

| Existing workflow result | Display label | Initiator's next action |
| --- | --- | --- |
| needs-decision | Needs decision | Decide |
| accepted-not-implemented | Change required | Edit source, then publish and record |
| implemented | Implemented; processing finished | Inspect or explicitly reopen |
| verified (historical optional verdict) | Implemented | Inspect or explicitly reopen |
| challenged | Reopened · change required | Inspect feedback, edit, publish another fix |
| disposed | No change planned | Explain decision; close discussion if appropriate |
| conflict | Conflict | Inspect and reconcile the causal heads |

**Source changed, not published** is private working-copy information, not a
shared implementation status. An editor save must never mark a finding fixed.
Do not label a private draft, a successful capture alone, or a failed record
as Implemented or Verified.

Rename **Close thread** to **Close discussion**. For an accepted finding without
recorded implementation, explain at confirmation:
**This closes the conversation. The accepted change still needs to be
published and recorded.**

Keep closure explicit and independent. Publishing, accepting, verifying or
challenging must not silently close or reopen a discussion. Existing closed
findings stay closed; creator implementation controls remain usable. Reply
and Decide remain locked until an explicit reopen.

## 3. Recommended flow: Guided workbench

1. **Decide.** Accept the concern using the existing decision event. Retain the
   selected finding and show Change required plus the next action.
2. **Edit source.** Open the local working file beside the finding. If no source
   is linked, inspect the already-open native workspace roots and offer a
   single verified match automatically or an explicit folder selection when needed;
   retain the binding privately. A separate menu command is not a prerequisite.
   Never edit the frozen review blob.
3. **Prepare publication.** Compare the selected working documents with the
   chosen parent snapshot. Distinguish unsaved editors, saved changes, unchanged
   files and missing/ambiguous resources. A folder timestamp is not a diff.
4. **Confirm.** Show changed-file count, document/resource diff, review title,
   source location (native host only), parent snapshot and selected findings.
   Preserve existing document scope and policy by default.
5. **Publish.** After explicit confirmation, call the shared authoring service
   to publish one complete immutable descendant revision.
6. **Record.** Revalidate each selected accepted finding and append its existing
   thread.addressed event with the admitted target revision/document digests.
7. **Continue.** Return to the original finding in place, showing
   **Finding from [original snapshot] — fix published in [new snapshot]**.
   Offer Inspect published fix and show Implemented — Processing finished.

The final action is labeled **Publish revision and record selected fixes**.
Its summary makes clear that this is a sequence of durable operations, not
one transaction over all files/events. The user explicitly selects the findings
addressed by this publication; initially select only the initiating finding.

Do not automatically mark every accepted finding in the changed file fixed.
One revision may address multiple explicitly selected findings, each with its
own summary and implementation record. Show per-finding results and remaining
work when a batch only partially succeeds.

### Private workspace-source discovery

Source discovery MUST start from an explicit user action and target the selected
review, independently of which review becomes active. Opening a review/workspace
MUST NOT bind source. **Edit source** MUST remain visible to a native initiator
before linking. Its first use, publication preparation and advanced revision
creation MAY reuse and remember exactly one verified workspace match without an
extra picker. Saved edits remain valid. An existing binding MUST NOT be silently
replaced. These actions do not automatically edit source or publish evidence.

Multiple matches require an explicit choice, even when one is byte-exact and
another contains saved edits. A truncated discovery, unreadable/locked competing
root or changed workspace-root set MUST prevent automatic reuse. Missing paths
can conclusively disqualify a candidate; an access/I/O error is not proof of a
non-match. A missing match opens the normal native folder picker.

**Link Local Source Workspace…** remains an optional explicit override. A single
verified root then offers **Use current workspace** (or **Use this workspace
folder** in a multi-root window). **Choose another folder…** and cancellation
remain available. Publication retains its separate required diff/confirmation.

Verify every exact review-relative Markdown path across current revision heads.
Do not search an entire repository, remap basenames or claim semantic resolution
from a digest match. An active native Markdown file inside a workspace MAY suggest
a nested root by an exact relative-path suffix; all reviewed paths MUST then be
verified there. Skip virtual providers; use only filesystem paths accessible to
the active extension host. Refuse internal links/junctions, unreadable/nonregular
files and any source path inside the frozen review package.

Bound discovery to 64 candidate roots, share one immutable review snapshot per
pass, deduplicate canonical roots and bound parallel I/O. A truncated discovery
MUST require explicit selection. The operation MUST support cancellation and
revalidate source bytes/root identity, review identity/heads/scope and connection
before saving. Unrelated peer comments alone MUST NOT invalidate it. A stale
dialog MUST NOT restore a forgotten/reconnected review or overwrite another link.
Cancellation, failed verification and discovery MUST NOT mutate shared evidence,
source, participants or completion state. Native paths remain private to VS Code;
this adds no protocol event, schema requirement or participant RPC.

### Confirmation content

Preparation MUST give immediate, visible feedback before awaiting host I/O,
including stage updates and cancellation. The loading state MUST remain attached
to the originating review/request; stale progress and cancellation for another
actor/root MUST NOT affect it. Cancellation and failed preparation MUST publish
no review evidence. The native host may reuse fresh verification within a single
request, but MUST NOT replace publication-boundary checks with a stale global
cache. Render additional diffs/resources lazily and omit redundant unchanged
document text from the private preview. Complete frozen capture remains required.

Once an implementation is recorded, processing is finished. Normal actions are
Inspect published fix and initiator-only Reopen finding with a required reason.
No verification action is required or offered as the normal next step. Explicit
reopening names that implementation with a challenged verdict, and reopens its
discussion with a separate event when needed. The exact two-event intent is
retained across partial failure/retry. This management action does not reopen
the initiator's own participation. Reopened implementations regain the edit/replace
path. Legacy verdicts/conflicts remain readable and reconcilable. UI request progress/cancel is native-only,
not an additional event family or a permission exposed by participant hosts.

Keep the normal path short:

- Review title, source/destination and parent snapshot.
- Changed documents with a readable before/after view.
- Selected unfinished finding(s), their original document, and optional implementation note.
- A short notice: **Completion and approvals are revision-specific. Previous
  reviewer records are preserved; they are not carried over as approval of
  this new snapshot.**
- Cancel, Back to editing, and the explicit publish-and-record action.

Scope changes, extra resource roots, policy changes and branch/merge selection
belong in an Advanced area. Do not repeatedly ask a user to recreate existing
review setup for an ordinary document correction.

For a single unambiguous head, present that parent read-only with an Advanced
escape. Multiple heads require an explicit parent/merge choice; never guess
using publication time. Source buffers must be saved explicitly or the user
must explicitly choose the shown saved disk bytes.

## 4. Preserve the finding's context

The existing-revision picker uses human-readable snapshot numbers, publication
time, delta counts and recorded-finding context. Exact IDs remain available in a
collapsed audit section and stay the stored event values. Multiple candidates
require explicit selection, not a timestamp-based implementation default. A
selected snapshot has a read-only rendered/source preview that leaves the main
reader pin, draft and shared state untouched. Recorded-finding details use causal
heads and label historical/reopened/conflicted records; do not pick current wording
by wall-clock time. Build list/details from verified metadata without body reads;
load document bodies only for explicit preview and page long implementation lists.
These are reference-client presentation choices, not new protocol event semantics.

Retain an immutable operation context:

    reviewId, manifest digest, initiator actorId
    originRevisionId, threadId, original document/digest
    observed decision and addressing heads
    selected parent revision IDs
    target revision and target document digest once published
    authoring operation ID and per-finding record operation IDs

Friendly snapshot labels may use a timestamp and shortened ID. Prototype labels
such as R2 and R3 are illustrative only, not new authoritative revision numbers.

The discussion pane defaults to all review snapshots, with origin labels,
per-snapshot finding counts and an explicit displayed-snapshot-only filter.
Show all findings clears filters; snapshot selection is remembered privately.
Each finding action remains bound to its origin revision and original anchor.
Inspecting the fix changes an explicitly labeled comparison/document pane,
not the authority or anchor of that original comment. Do not copy comments into
the new revision or highlight an old range on changed text without a valid map.

Keep the original finding visible after native publication instead of making
the user switch back to an older revision. Refresh the revision catalog in
place. A separate **Review this snapshot** action may deliberately change the
participant's main revision context; handle unsaved drafts explicitly.

The inspector offers Rendered (default) and escaped Source views of exact frozen
original and implementation documents, including tables, Mermaid and images.
It supports changed, added and removed documents. Loading/errors remain visible,
closing or changing views cancels stale rendering, and internal links stay within
the compared frozen scopes. It does not switch the main snapshot or record events.

An unrelated revision does not erase the implementation or old verification.
Recording a newer implementation finishes processing again without a verdict;
the existing optional verification scope/history remains tied to its exact event.

## 5. Failure and concurrency behavior

| Situation | Required UI behavior |
| --- | --- |
| Source not linked | Edit source discovers a verified open workspace; ask only when needed, retain the finding |
| Source unchanged | Do not offer normal publish-and-record as proof of a text correction |
| Unsaved source | Show affected files; explicitly save or confirm displayed disk bytes |
| Source changes after diff confirmation | Refresh the diff and require confirmation again |
| Parent branches conflict | Require explicit branch/merge selection; never pick newest by clock |
| Accepted decision changes or conflicts | Keep draft; explain changed decision before any implementation record |
| Source saved but capture fails | Source changed, not published; retry authoring, not the edit |
| Revision published but record fails | Revision published; fix record pending; retry only the record |
| Record acknowledged uncertainly | Retry exact bytes/operation ID; never duplicate the edit or publication |
| Some selected records succeed | List per-finding outcomes; retry only pending records |
| Client delivery incomplete after publication | Identify the admitted revision separately; resume delivery using its original operation, never publish another revision to hide the failure |
| User changes review, identity or revision mid-flow | Preserve original context; require explicit handling, never retarget a pending action |
| New comments arrive | Refresh the queue; never silently add them to selected fixes |
| Verification challenged | More work needed; preserve discussion closure until explicitly reopened |

An advanced **Record an already published outcome...** flow may explain an
accepted concern without a same-file text change, where the existing protocol
allows the exact descendant snapshot. Require an explicit rationale and show
that the document bytes are unchanged. Do not invent a changed source digest.

A comment anchor is the origin of a concern, not a bound on implementation
scope. The guided path starts from the existing complete document scope. It allows
whole-document rewrites, changes in other reviewed documents/resources and
multiple explicitly selected finding records. Newly referenced Markdown requires
explicit scope confirmation (unchecked by default), including transitive
dependencies. Missing files are not silently removed. Check local document links
against the confirmed scope; block missing, unsafe, case-mismatched or excluded
targets before publication. External/attachment references stay external/captured
resources, never implied source-code grants. Read-only graph discovery is bounded
and cancellable, performs no network fetch and does not auto-include a repository.

The comparison names Added / Modified / Removed / Unchanged paths. Removal is
only from the new snapshot; original evidence and findings remain immutable.
Findings whose anchor document is removed are excluded from implementation
selection, with an explicit count/explanation. Do not invent a replacement anchor.
Recheck scope/source/parent bindings after the selection and again at publication.
Partial retries keep the original captured scope and bytes even if source changes.
Unreferenced additions, root/policy changes and trusted presentation-profile
capture retain the visible Advanced setup path.

If an admitted revision's pending records cannot proceed because a decision
changed, the initiator may explicitly retain that revision and retire the local
retry intent with a native confirmation and recorded private reason. This does
not delete shared evidence, mark a finding implemented, or erase the original
recovery record. The outcome can then be reconciled manually against the exact
published snapshot.

Selection, drafts, expanded groups, source binding and retry journals stay
private. They are not another shared task database. Storage synchronization
remains eventual; UI state describes the locally verified observed records.

## 6. Protocol mapping and host boundaries

| User action | Existing authority / write |
| --- | --- |
| Accept concern | thread.decided |
| Close/reopen discussion | thread.resolved / thread.reopened |
| Edit working file | Native local editor; no review-state write |
| Publish updated documents | Shared authorReview service and revision.created |
| Record published fix | thread.addressed with accepted heads and exact descendant evidence |
| Reopen implemented finding (initiator) | thread.verification.recorded, challenged; explicit thread.reopened when closed |
| Reopen my review | review.reopened for the correct origin revision |

No new core event, manifest mutation, mutable comments file or server is needed.
Use the existing predecessor, role, membership, content-digest and receipt
validation on every write. A displayed source diff is guidance, not proof that a
concern has been semantically addressed; the summary is an explicit creator
assertion, not proof of independent verification or approval.

Blank implementation notes produce a neutral summary naming the exact published
snapshot and document. Keep the existing nonblank wire summary; never imply a
reviewer verified the change. Completed findings belong in a collapsed read-only
group, not in the default selection list. Explicitly reopened findings are eligible
again. Group unfinished findings by document, preserve selections while filtering,
and replay the exact original intent during recovery, including omitted notes and
already saved records. Closing an open implemented discussion remains an initiator
lifecycle action; it must not replace addressing evidence or challenge the fix.

Native authoring RPCs must be explicitly capability-gated and exposed only by
the trusted VS Code host. Do not infer authoring capability from the existence
of a generic RPC bridge: Go/Node participant clients also have one.

Do not modify existing shared HTML, launchers, sources, participants or export
artifacts merely to show the new UI. Client/package upgrades remain separate,
explicitly authorized operations.

## 7. Delivery packages

1. **Discoverability and copy:** visible toolbar/tree/context-menu action,
   correct target argument binding, Close discussion wording, no hidden next
   step. Preserve Command Palette compatibility.
2. **Finding action model:** derive next actions from admitted states, local
   host capabilities and source inspection; no persisted duplicate status.
3. **Guided publication:** short diff/selection confirmation, bounded batch,
   stable origin context, exact operation recovery and partial-success UI.
4. **Inspection in context:** rendered/source comparison beside the
   discussion, processing finished on implementation, explicit reasoned rework.
5. **Qualification and documentation:** normal use, failures, concurrency,
   accessibility and both host capability sets.

## 8. Required acceptance coverage

- Native initiator can enter publication from toolbar, Active Review and either
  active or inactive review context menu; wrong-review publication is impossible.
- Accepting or closing alone never marks a change implemented.
- A closed accepted finding can be edited/published/recorded without reopening
  its conversation; reply/decision actions stay locked.
- Missing binding and unsaved/unchanged source have visible remedies.
- Only changed, saved and confirmed bytes enter a new revision.
- One source publication can address multiple explicitly selected findings.
- Publication does not automatically change selected findings or inherited
  reviewer completion/approval.
- Successful publish/record returns to the original finding with exact target
  revision/digest linkage; inspection does not retarget comments.
- Revision-success/record-failure retry never creates another revision.
- Partial batch and lost-ack retries preserve exactly-once logical operations
  and disclose incomplete steps.
- New decisions/comments, source edits, branch heads, reviewer/review changes
  during a draft are handled without silent retargeting.
- A browser initiator can record an existing valid published outcome but cannot
  edit source or invoke authoring endpoints.
- A normal reviewer cannot invoke creator controls through forged messages.
- Implementation finishes processing without a verification event.
- Initiator rework can reopen an implemented finding without reopening their
  own participation; ordinary feedback retains its completion lock.
- Review-wide actions/replies preserve original revision/digest while the main
  document remains on another snapshot; old anchors never mark new bytes.
- Verified/challenged history and discussion lifecycle remain independent.
- Existing packages lacking thread-addressing-v1 remain readable and do not
  silently acquire new capabilities.
- Both distributions share behavior; public fixtures contain no private project
  data or corporate preset/runner details.
- Keyboard operation, focus return, persistent progress/error messages and
  readable states work at narrow and full VS Code widths. Color is not the only
  status indicator.
- End-to-end execution covers native VS Code authoring, browser participation,
  Go/legacy Node participant transport and exported discussion/history. Windows
  and Linux execute in CI for a release; Mac execution is local. No SMB
  qualification claim is made.
