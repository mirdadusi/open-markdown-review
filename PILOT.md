# Limited pilot plan

## Recommended group

- 8–20 participants
- 2–4 real technical-document reviews
- Normal local-disk storage as the baseline path
- At least one mounted SMB/NFS/NAS or mapped network-drive review and one Git-backed review
- Optional OneDrive/SharePoint/Syncthing comparison; no cloud provider is required
- Documents containing Mermaid, local and remote images, explicit attachments, and wide tables

## Entry criteria

- Install the packaged VSIX on supported VS Code versions.
- Confirm workspace members have the same synchronized folder and appropriate access control.
- Nominate one review owner responsible for creating revisions.
- Keep the original source repository or folder backup; the protocol is not a source-control replacement.

## Scenarios

1. Two reviewers create comments within one synchronization interval.
2. A reply arrives before its root comment and becomes valid after synchronization completes.
3. A remote image is captured, then becomes unavailable; the frozen revision must remain readable.
4. A local image changes after revision creation; the rendered review and PDF must retain the earlier bytes.
5. A Mermaid syntax error blocks PDF export and provides a useful diagnostic.
6. A Markdown table is commented at cell level and rendered legibly in PDF.
7. A `review:attach` PDF or text file is available offline from the rendered review.
8. A source file changes; source comment creation is blocked until a new revision is created.
9. A PDF is exported on a second machine and its document/resource/event inventory is complete.
10. A deliberately corrupted blob is detected before review presentation.
11. A reviewer replies to a comment and the owner records accepted, rejected, won't-fix, and duplicate decisions with reasons.
12. A reviewer proposes replace, delete, insert-before, and insert-after edits on exact strings; the rendered diff shows deletions/replacements as strikeout.
13. Accepted suggestions can be applied to unchanged source, recording before/after hashes; rejected or conflicting suggestions cannot be applied.
14. Simultaneous accept/reject decisions synchronize as an explicit conflict and are not silently resolved.
15. A revision rejection and its reason appear in the audit PDF alongside any approval assertions.
16. A non-technical user opens visual setup, selects one complete folder plus individual Markdown files elsewhere, chooses the start document, and confirms only those files appear in the revision.
17. The user reopens setup, changes the selection, and creates a new revision without altering the earlier revision or its threads.
18. The user creates `.architecture-review` inside Git and `safety-approval` on a mounted shared drive for the same Markdown workspace, switches the active review in the Activity Bar, and confirms actions never cross packages.
19. The user connects an existing review package from a normal local folder and from a mapped/mounted shared drive without OneDrive or SharePoint.
20. A review package is committed and checked out on another machine; `.gitattributes` prevents exact-byte digest changes.
21. Commented text is visibly highlighted in the rendered review; clicking it focuses the correct discussion, including its replies, and clicking the discussion location returns to the exact content.
22. The matching source Markdown shows a comment gutter marker and highlighted range; its hover action opens the same discussion, while an unavailable sender source still leaves rendered navigation usable.
23. A second reviewer writes a comment to an active package outside the workspace; the first client's sidebar and open rendered review update without manual refresh.
24. A mounted drive omits a filesystem notification; polling detects the new event within the configured interval.
25. A partial event or revision arrives before its dependencies; the client retains the last valid view, reports delayed synchronization, and shows the completed review after retry.
26. Several events arrive in one synchronization burst; the client folds them deterministically without overlapping refresh failures or lost events.
27. A live update preserves the selected document, main and sidebar scroll positions, and focused discussion.
28. A synchronized provider temporarily removes or rewrites a previously validated event; the client retains the last valid state and reports synchronization delay instead of silently deleting audit history.

## Exit criteria

- No lost or overwritten events.
- All required images and attachments remain available offline.
- Mermaid, images, and tables are readable in both client and PDF.
- Every comment, reply, decision, suggested edit, approval, and rejection identifies the exact revision.
- Exact-string suggestions are visibly diffed, individually decided, and never applied without explicit acceptance.
- Participants can understand and change the reviewed document set without editing JSON, globs, or VS Code settings.
- Participants can create, connect, identify, and switch multiple reviews without confusing which package receives an action.
- Participants can see where every comment belongs and move reliably between highlighted content, its replies, and the original source selection.
- Participants see shared comments and replies within the configured synchronization interval without reloading, including for review packages outside the workspace.
- Delayed or incomplete synchronization never replaces the last valid review with partial state.
- Custom review folder names work inside repositories and on ordinary local/shared drives.
- Export digests verify and event inventories are complete.
- No active Markdown, SVG, Mermaid, or attachment content executes.
- Participants can initialize, create a revision, comment, reply, decide, suggest edits, apply accepted edits, approve/reject, and export without developer assistance.

## Feedback to collect

- Time to complete each task
- Confusing labels or missing progress feedback
- Anchor accuracy after edits
- Table and diagram readability
- PDF usefulness to auditors and non-VS-Code users
- Sync-provider conflict files or delays
- Maximum observed document, image, and attachment sizes
