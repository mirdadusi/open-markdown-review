# Editing comments and choosing a PDF snapshot

Available in 0.7.0 in VS Code and browser clients.

## Correcting your wording

For a package declaring `comment-edits-v1`, your own open comment or reply has
**Edit my comment…**. Change the prefilled wording and save. The current text
updates, with **Edited · view history** exposing the original and every edit.
The anchor, finding decision and implementation record do not change. Use a
new finding for a different concern, rather than changing an accepted concern's
meaning without discussion.

You cannot edit someone else's comment, including as the initiator. Closed
discussions and finished participation stay locked; implemented findings must
be explicitly reopened before editing. If two edits arrive together, both are
shown. The author uses **Reconcile my edits…** to save the intended wording.
An interrupted or stale save retains its draft rather than overwriting a peer.

Newly created packages declare this required capability so old clients cannot
silently ignore edits. **Existing packages and manifests are not rewritten.**
Where editing was not declared, **Add correction…** saves a normal reply linked
to your original comment; the original text stays visible. This is intentionally
not labelled an edit. Existing shared HTML/companions do not upgrade merely
because the VS Code extension is updated.

## Exporting the intended snapshot

**Export PDF… → Snapshot to export** lists all verified snapshots with friendly
labels, counts and branch/latest markers. The default is the unique latest head,
even if you are reading an older snapshot. If there are competing heads, choose
explicitly; a later timestamp cannot decide which branch is authoritative.

Select an older snapshot to archive the findings attached to its exact reviewed
text. The dialog displays its document, comment and reply counts. **Review
archive** shows the current wording of comments and nested replies in the native
PDF comments pane, with participant progress and an audit appendix in the PDF.
Earlier wording and workflow events remain in the original event files identified
by the archive inventory. **Clean document** exports its frozen
documents without review comments or review metadata. The document-list and
template controls remain independent choices.

An all-snapshot findings panel does not make old anchors valid on new bytes.
Selecting the latest snapshot with zero findings intentionally exports no comment
annotations for older snapshots. Choose their original snapshot when those
findings are needed in the PDF.

Opening/cancelling this dialog writes no review event. Confirming binds the
export to the chosen snapshot and does not switch the document you are reading.
Later publications cannot redirect a pending export or retry. On the next dialog
opening, latest is the default again; prior template/type choices stay private
preferences. The result message names the snapshot that was exported.
