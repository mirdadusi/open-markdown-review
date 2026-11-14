# Processing accepted review findings

A comment anchor identifies a concern; it does not restrict the implementation
to highlighted text. The initiator can rewrite a whole document, change other
documents and resources, and explicitly select which findings were addressed.

## Guided workflow in VS Code

Use **Decision → No decision** to find comments without a decision, independently
of **Discussion → Open / Closed**. These filters combine with the selected
documents, snapshots, work queue and search. A closed discussion is not necessarily
accepted or implemented. Conflicting decisions have their own filter; they do not
count as undecided. Suggested edits use the same decision/discussion filters.
**Show all findings** clears the filters. Opening a document highlight also clears
filters that could hide its comment. Filtering never writes review events.

1. Open **Creator workbench**, accept the finding, and choose **Edit source**.
   VS Code reuses one verified open workspace automatically, or asks you to choose
   when the source is ambiguous or missing. No separate linking step is required.
   Never edit frozen review blobs.
2. Edit and save the necessary files, including complete documents when needed.
3. Choose **Publish and record fix...** on the finding. Alternatively use
   **Publish updated documents...** in the toolbar, Active Review tree or the
   selected review's context menu. Context-menu publication targets that exact
   review, not another active review.
4. When a fix links to new Markdown or an existing source is missing, confirm
   the document scope first. New files start unchecked; **Include all available
   referenced files** is an explicit shortcut. Missing files are never silently
   removed. Resolve missing/unsafe/out-of-scope local Markdown links before
   continuing. Then inspect the privately captured **Added / Modified / Removed**
   documents, resources, destination and parents. The approval policy is retained.
   Multiple heads require an explicit parent choice.
5. Select only unfinished findings this revision addresses. Implementation notes
   are optional. Initially only the initiating finding is selected. Selecting none
   publishes a document-only revision.
6. Confirm **Publish revision and record selected fixes**. One immutable revision
   is published, followed by independent finding events. This is a sequence of
   durable operations, not a transaction across all shared files.
   The dialog and VS Code notification show verification, source/resource counts,
   captured-file publication and finding-record progress, with elapsed time in
   the dialog. Keep the window open. Publication is not cancellable once started;
   a failure retains the exact retry intent, which must not be replaced by a new
   publication. Routine polling pauses during native publication and resumes
   afterward; the final authority check still observes concurrent review changes.
7. The finding shows **Implemented — Processing finished**. No verification
   step is required. **Inspect published fix** compares the frozen original and
   implementation in **Rendered** or **Source** view, including other documents,
   tables, Mermaid and captured images. Inspection never changes review state.
   The initiator can explicitly **Reopen finding…** with a reason if more work
   is needed.

Editing/saving, acceptance, discussion closure and verification remain separate.
A closed accepted finding can be processed without reopening its conversation;
Reply and Decide stay locked. **Close discussion...** warns when implementation
is still pending. Existing optional verification remains attributed to its
actual actor, not presented as independent verification when done by the
initiator. Reopening a finding does not reopen the initiator's participation.

New revisions have independent participant progress. Prior comments, approvals
and completion records remain intact; they are not carried forward as approval
of changed document bytes.

## Linking an already-open workspace

Choose **Edit source**, **Publish updated documents…** or **Publish and record
fix…** directly. If no source is already remembered, the extension checks native
folders open in this VS Code extension host, including host-native WSL/SSH paths
(not virtual/Git providers). One unambiguous, fully verified match is reused and
remembered privately without a picker. This does not edit or publish anything;
publication still requires its normal diff and explicit confirmation. Merely
opening a review or workspace does not link anything.

An existing remembered source is kept, not silently replaced with another copy.
Use **Link Local Source Workspace…** from the review's context menu only to change
or explicitly inspect the source location. That override always asks you to confirm.

- One complete match: source actions reuse it automatically. The explicit
  override offers **Use current workspace**, with the checked path and document
  counts (or **Use this workspace folder** in a multi-root window).
- Multiple matches: choose the intended folder explicitly. An unchanged copy
  does not take precedence over a copy containing saved edits.
- No complete match: choose the source folder in the folder picker. You can
  always choose another folder instead of an offered match, or cancel. An
  unreadable/locked competing root or a truncated discovery prevents automatic
  reuse, even if another folder matched successfully.

Paths are relative to the review's source root, not matched by basename. For a
review containing `planning.md`, source `docs/planning.md` needs `docs` as its
root. Opening that Markdown file in an already-open workspace can suggest this
nested root; every other reviewed path is still checked. There is no recursive
repository search. Discovery checks at most 64 candidate roots, with bounded I/O
and canonical aliases checked only once per pass. Reaching that bound requires
an explicit selection rather than treating the search as exhaustive.

Saved edits are normal; they are not proof a finding is implemented. Missing,
unreadable, internally linked/junction or nonregular source paths cannot establish a match.
Frozen review-package files cannot be used as editable source. All current
revision-head paths are checked. Source files, review heads and the connection
are checked again before the private link is saved; if they change during
selection, retry. New peer comments alone do not invalidate the link.
Automatic reuse also rechecks that the open workspace-root set did not change.

Linking and cancellation write no review events, documents or completion state.
The absolute source path is stored only in local VS Code state. Existing HTML
and Go clients do not need upgrading for this native authoring convenience.

## Comparison feedback and finding actions

Preparing a comparison opens an immediate progress dialog at the point of action,
with native phase updates, elapsed time and **Cancel preparation**. Cancellation
stops at the next safe I/O boundary and never publishes a revision or finding
record. A preparation error stays visible until dismissed. Duplicate clicks do
not enqueue another capture.

Only the first changed document is rendered initially; expanding another loads
its bounded comparison. Unchanged documents show their matching digests, without
reading or transporting duplicate text just for the preview. Complete immutable
source/resource capture and publication-time verification are retained.

Normal actions follow the finding's current change state:

| Change state | Primary actions | Secondary actions |
| --- | --- | --- |
| Change required | Edit source; publish and record fix | Record an existing fix when available |
| Implemented (including previously verified) | Inspect published fix; Reopen finding (initiator) | Open working source |
| Reopened · change required | Edit and prepare a replacement; inspect feedback | Record an existing replacement |

Secondary actions are under **More actions**. Closing/reopening a discussion is
independent of implementing/verifying its fix. Existing role/completion locks
still apply. Existing verification conflicts retain a reconciliation action; history is
not deleted or silently rewritten.

The optimization uses fresh request-local verification, not a persistent cache
of mutable review state. In the completed-fix synthetic fixture (20 additional
comments), the bound-source preparation path went from 9 to 3 full review scans
and from 357 to 122 shared-review reads. With an injected 2 ms per shared read,
one local run changed from 436.8 to 343.0 ms. These are development measurements,
not Windows, SMB or OneDrive performance guarantees. First-time source discovery,
resource capture and slow storage can still add time; progress remains visible.

Progress/cancellation messages belong only to the native VS Code request. They
are not shared protocol events, new permissions, or participant-companion RPCs.

## Scope and advanced authoring

The guided path starts with the parent's complete existing scope, not just the
anchored file. It detects local Markdown references, including transitive links,
and offers explicit inclusion of newly referenced files. Unrelated workspace
Markdown is not added. It shows added/modified/removed/unchanged documents and exact hashes. Long source
previews are explicitly shortened to 64 KiB per side: inspect full source in the
native editor before confirming. Edits after preparation require a fresh diff.
Remote resources remain exactly the captured bytes, not live remote content.

If the anchor document is unchanged but another document addresses the concern,
an implementation note can explain this. The record references the exact original document
within the complete descendant snapshot. A diff cannot prove semantic resolution;
this remains an explicit creator assertion, not an independent verification.

The picker groups unfinished findings by document and supports searching by
document, quote, comment or author. Selected findings stay visible during search.
Already implemented findings are collapsed, read-only and loaded on demand; they
are not selected again. Use **Reopen finding…** before recording a replacement fix.
Retrying a partial publication preserves the exact confirmed selection and notes,
including saved records hidden in the completed group.

If the implementation note is empty, the client supplies a factual summary naming
the published snapshot and document. The protocol's nonblank `thread.addressed.summary`
requirement is unchanged; no rationale or independent verification is invented.

**Discussion: open · Change: Implemented** is valid. The initiator can use
**Close discussion…**, with an optional resolution note, without reopening the
finding, changing its recorded fix or adding a verification step.

## Findings across snapshots

The comments panel defaults to **All review snapshots**. Each finding names its
original snapshot and offers **Open original context** to show the exact reviewed
text. Replies and other actions stay on that original snapshot even while the
main document displays a newer one. Older anchors are not highlighted on newer
bytes. **Displayed snapshot only** is an optional filter; **Show all findings**
clears filters when comments seem missing. The snapshot selector shows friendly
names and finding counts. Selection is remembered privately where browser storage
is available; it does not modify shared review state. Reviewer progress and
approval remain specific to the displayed snapshot.

**Change scope / advanced setup...** exposes document selection and policy changes.
It remains available for unreferenced additions, root changes and approval-policy
changes. The guided scope confirmation keeps the root document and current policy.
The current guided text-change capture supports Markdown reviews. Slidev capture
retains its existing explicit trusted-project setup; participants never execute
the presentation project. Advanced setup publishes independently: record its
revision using **Record published fix...** on the original finding afterwards.

### Reuse an existing published fix

For another accepted finding concerning the same implemented change, choose
**More actions → Record published fix…** in VS Code. Participant browsers show
the initiator's recording action directly when it is available.

The picker shows **Snapshot N**, publication date/time, changed-document counts,
existing recorded-fix counts and latest/branch-head labels, not opaque IDs.
Selecting a snapshot shows its publisher, Added/Modified/Removed paths, resource
and policy changes, and the findings/implementation notes already linked to it.
Historical or reopened implementations are labelled accordingly; causal heads,
not timestamps, determine the current implementation wording.

Use **Preview selected snapshot…** to compare its frozen rendered/source documents
with the original finding snapshot before recording anything. Closing the preview
returns to the same selection and optional implementation note. Neither selection,
preview nor Cancel writes events or switches the main reader's snapshot.
When several eligible snapshots exist, select one explicitly; no latest/oldest
default silently chooses the implementation. A single eligible snapshot can be
preselected, with its details visible. **Record fix** saves the exact selected ID
as one independent finding event; it does not publish another revision.

Full IDs remain under **Audit identifier**. Snapshot numbers/date labels are
derived presentation and can change as older publications arrive; the stored
revision ID is the authority. Candidates remain published descendants containing
the original anchor document. Same-snapshot, ancestor and unrelated-branch targets
are not made eligible by this UI. The original finding must be accepted, and only
the initiator can record its implementation. Discussion closure stays independent.

### Fixes implemented in a new Markdown file

Create the file in the linked source workspace and use relative forward-slash
links from existing documents. Choose **Publish and record fix…**, explicitly
include the referenced new file (and its Markdown dependencies), inspect its
**Added** preview and the **Modified** referring documents, then confirm selected
findings. The complete new scope, captured images/attachments and rendered Mermaid
belong to one frozen revision. Its documents appear in both PDF modes and in
participant clients, without upgrading clients or editing old snapshots.

Local document links must point into the selected scope. External HTTP/HTTPS,
file/network and attachment references are not followed as source Markdown.
Discovery is bounded to 200 existing/referenced paths and 10,000 local links;
the published scope still has the protocol limit of 100 Markdown documents.
No external requests or repository-wide auto-inclusion are performed by discovery.
Exact filename/case matters for portability. Saved source, links and revision
heads are checked again after scope selection and before final publication.

Removing a document means excluding it from the new snapshot, not deleting it
from source or review history. Findings anchored there remain on their original
snapshot and cannot be marked implemented by a `thread.addressed` record that
requires that original document in the descendant snapshot. The comparison
explicitly reports these excluded findings; no completion/approval is fabricated.
For a normal new-file fix, retain the original document even if its quoted text
is unchanged. Its new relative link and the added document are published together.

Development verification: `npm run test:finding-workflow` includes readable
snapshot metadata, safe/lazy details, exact older-snapshot selection, read-only
preview/cancellation and reuse without extra publication, as well as scope parsing,
explicit additions/removals, stale selection and unsafe-link rejection, exact
partial retry, browser participation and both PDF modes, plus the native VS Code
scope-confirmation workflow. Native companion qualification runs the browser
scenario against the actual platform executable.

## Recovery

Preparation writes private capture/recovery data only. Cancel before publication
to change source and prepare again. Publication never upgrades existing shared
HTML or companions; executable-client updates remain separate explicit actions.

If a revision is published but recording a finding fails, use **Retry pending
records**. The original target and exact event intents are reused, even after a
client restart on that device. A retry neither creates another revision nor
captures later source edits. Lost acknowledgements are recognized by exact bytes.
Other findings in changed files are never automatically marked implemented.

If a changed/conflicting decision blocks recovery, **Keep revision; manage pending
findings manually...** requires native confirmation and a reason. It only retires
the private retry intent. Published evidence, comments and recovery history stay;
no pending finding is falsely marked implemented. Reconcile the decision and
record the exact published outcome manually.

## Browser, Go and legacy Node clients

All share the clearer discussion/change states, rendered/source comparison and
explicit reopening. A browser initiator can record an already published fix, but cannot
edit private source or publish revisions. The UI explains the VS Code handoff.
Participant RPC explicitly rejects native authoring methods. Identity remains
self-asserted, not authenticated by an OS login.

Until explicitly upgraded, existing shared clients keep their current UI and
unchanged authoritative comments. No server, new event family, manifest mutation
or mutable shared task database is introduced.

## Development verification

Run `npm run test:finding-workflow` for focused service/browser tests and the
isolated real VS Code workflow. For the same browser assertions against a newly
built Go candidate, set `OMR_PROCESS_COMPANION` to that executable and run
`node --test out/test/findingPublication.browser.integration.js`.

Run `npm run test:source-workspace` for source-discovery, confirmation, cancellation
and race tests plus the real isolated VS Code Quick Pick/editor integration.

Mac native execution is local. Windows/Linux execution remains a CI qualification
requirement, not a claim inferred from cross-compilation. No SMB qualification is
claimed. This development feature does not itself install/publish a release or
modify an ongoing review.
