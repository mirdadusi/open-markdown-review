# Open Markdown Review 0.4

Open Markdown Review is a serverless, local-first review system for technical Markdown. Each review is a self-contained folder. Its default name is `.review`, but it can be named `.architecture-review`, `safety-approval`, or anything else and stored inside the source repository or anywhere on a normal local disk, mounted SMB/NFS/NAS share, mapped network drive, Syncthing folder, removable disk, or cloud-synchronized folder. No OneDrive, SharePoint, or hosted service is required.

Client 0.4.4 is a limited-pilot client, not merely a schema demonstration. Its VS Code extension has a dedicated Review icon in the Activity Bar, manages multiple review packages per Markdown workspace, provides a visual setup flow, selective document scope, an immutable rendered review, GFM tables, Mermaid diagrams, local and external images, explicit Markdown attachments, visibly anchored threaded comments, live local-first synchronization, comment decisions, suggested edits, approval or rejection, and auditable client-side PDF export.

## What the client does

- Adds a dedicated Markdown Review icon and sidebar to VS Code.
- Creates, connects, lists, and switches between multiple independent reviews for one Markdown workspace; all actions target the visibly active review.
- Opens a visual setup panel that lists Markdown by folder with search, folder/file checkboxes, selected count, start-document choice, and review-package location.
- Stores a review in a freely named package folder inside Git or on any ordinary local/shared drive.
- Initializes a portable review without a server or database.
- Watches the exact active review package—even outside the workspace—and normally shows synchronized comments and replies within seconds.
- Uses filesystem notifications plus a lightweight polling fallback, serialized refreshes, and bounded retry for partially synchronized files.
- Creates an immutable revision containing only the selected Markdown documents.
- Freezes embedded local, data-URI, and HTTPS images into SHA-256-addressed blobs.
- Freezes explicitly attached Markdown links into the same blob store.
- Records ordinary external links without silently archiving entire websites.
- Renders multiple documents, GFM tables, Mermaid, frozen images, and safe Markdown in a review panel.
- Adds comments from source selections or rendered text, images, diagrams, tables, and table cells.
- Highlights commented text and annotated images, diagrams, tables, and cells in the rendered review; clicking the highlight focuses its discussion, and clicking the discussion returns to the anchored content.
- Decorates commented ranges in an open source Markdown editor with a gutter marker and hover link to the rendered discussion.
- Lists, displays replies to, navigates to, and resolves threads.
- Accepts, rejects, marks won't-fix, or marks duplicate individual comments with an auditable reason.
- Proposes exact-string insert, replace, and delete edits without silently changing Markdown; replacements and deletions are shown as strikeout/insertion diffs.
- Accepts or rejects each suggested edit and applies only accepted, conflict-free edits with before/after source hashes.
- Records approval or rejection against an exact revision.
- Exports a polished PDF containing reviewed documents, comments, replies, decisions, suggested edits, revision decisions, digests, renderer versions, and an event inventory.
- Records the PDF digest in an immutable `export.created` event.

Existing events and blobs are never modified. Concurrent participants create independently named files and reconstruct state from their union.

## Review workflow

```mermaid
flowchart LR
    A[Edit Markdown] --> B[Create immutable revision]
    B --> C[Rendered review]
    C --> D[Comments and suggested edits]
    D --> F[Decisions and approval or rejection]
    F --> E[Client-side audit PDF]
    B <-->|file synchronization| S[SharePoint / SMB / Syncthing / Git]
```

1. Open the Markdown Review icon in the left Activity Bar and choose **Create New Review** or **Connect Existing Review**.
2. For a new review, select or create its package folder. Leave the default `<workspace>/.review` for Git storage, or choose any local or mounted shared-drive folder and any folder name.
3. Select complete folders or individual Markdown files, choose the start document, and click **Initialize and create revision**.
4. If the workspace has several reviews, click one under **Reviews** to make it active.
5. Open **Markdown Review: Open Rendered Review**.
6. Select rendered text or click an image, Mermaid diagram, table, or cell, then choose **Comment**.
7. Click the highlighted content to focus its discussion; click the discussion location to return to the content, or choose **Open source** to select it in Markdown.
8. Select an exact string and choose **Suggest edit** to insert, replace, or delete text.
9. Reply to comments, decide them, and accept or reject suggested edits.
10. Apply an accepted suggestion explicitly if desired, then create a new immutable revision of the changed source.
11. Approve or reject the reviewed revision and choose **Export audit PDF**. Generation occurs locally inside the extension.

To change the document set later, run **Markdown Review: Review Setup and Documents**. The panel starts with the current revision selected. Saving creates a new revision with the new scope; previous revisions and their review history remain immutable.

If Markdown or an image changes, create a new revision. Source-editor comments are blocked when the active file no longer matches the frozen revision; reviewers can always use the immutable rendered view.

## Storage and Git

The selected folder is the review package itself:

```text
<any-review-folder>/
  manifest.json
  events/
  revisions/
  blobs/sha256/
  exports/
  .gitattributes
```

For a Git-backed review, keep the package inside the repository and commit the complete folder, for example `git add .review`. The generated package-local `.gitattributes` disables line-ending conversion below the package because revision and blob digests cover exact bytes. Do not ignore `events`, `revisions`, `blobs`, or audited `exports`.

For disk/shared-drive operation, select or create a folder on any filesystem visible to VS Code. A plain local directory or mounted SMB/NFS/NAS share works directly; SharePoint and OneDrive are only optional synchronization choices. The extension remembers external package locations for the current workspace. If a synchronized drive is temporarily unavailable, its registration is retained and becomes usable again after the drive returns and the view is refreshed.

### Live synchronization

With live synchronization enabled (the default), the active package is watched directly even when it is outside the opened workspace. The rendered review, sidebar, source highlights, decisions, and counters update after another participant's immutable event file reaches the local filesystem. A polling fallback runs every 3 seconds while the rendered review is visible and every 15 seconds in the background; both intervals are configurable under **Open Markdown Review › Live Sync**.

Synchronization is intentionally eventual rather than server-mediated. Local disk is usually immediate; SMB, NFS, Syncthing, OneDrive, or SharePoint adds provider/network latency. The client keeps the last validated review visible, quarantines incomplete or out-of-order files, detects the disappearance or rewrite of previously validated events during the session, retries with bounded backoff, and shows a visible **Live**, **Waiting**, or **Delayed** status. A manual **Refresh** remains available. Git-backed reviews update only after the new files are fetched/merged into the local checkout; this client does not automatically pull or push Git.

The rendered client marks newly synchronized discussions, reports new comments without stealing focus, and preserves the current document, scroll positions, and focused thread when it rebuilds annotations. Existing events are never rewritten as part of synchronization.

One source workspace can have several review packages—for example `.architecture-review` in Git and `safety-approval` on a shared drive. The sidebar marks one review as active. Commands never combine their event logs.

To read a review received from someone else, choose **Connect Existing Review** and select either the package folder containing `manifest.json` or a parent folder containing one or more review packages. The client discovers packages and asks which one to open when needed. If no workspace is open, the extension can open the selected package as the VS Code folder. Frozen documents, images, Mermaid, tables, comments, replies, decisions, approvals/rejections, attachments, and PDF export remain available without the sender's original source checkout. Source editing and applying suggestions naturally require the matching source workspace.

## Images, Mermaid, tables, and attachments

Embedded images use ordinary Markdown:

```markdown
![Context diagram](images/context.png)
![Externally hosted evidence](https://example.org/evidence.png)
```

Both are captured into `<review-package>/blobs/sha256/` before the revision is published. Revision creation fails closed if a required image is missing, too large, insecure, or invalid.

Mermaid uses normal fenced blocks and is rendered locally with a pinned engine version:

````markdown
```mermaid
flowchart LR
    Author --> Revision --> Reviewer
```
````

GFM tables render with horizontal scrolling in the client and bounded page layout in the PDF.

Ordinary links are audit-listed but not downloaded. Add the standard Markdown title `review:attach` when the referenced bytes are evidence that must travel with the review:

```markdown
[Local evidence](evidence/decision.pdf "review:attach")
[Remote evidence](https://example.org/decision.pdf "review:attach")
```

Attached links are frozen, hashed, and opened from the local blob in the rendered client. Active HTML, script, and executable attachment media types are rejected.

## Install the packaged extension

In VS Code, run **Extensions: Install from VSIX…** and select the supplied `open-markdown-review-0.4.4.vsix`.

To build it yourself, use Node.js 22 or newer and VS Code 1.90 or newer:

```sh
npm install
npm test
npx --yes @vscode/vsce package --allow-missing-repository --no-rewrite-relative-links
```

For development, open this folder in VS Code and press `F5`. The Extension Development Host opens the complete workspace in `protocol/examples`.

## Project layout

```text
protocol/
  schemas/                    JSON Schema 2020-12 definitions
  fixtures/v0.4/              current portable-path conformance fixture
  examples/                   complete legacy compatibility fixture
  README.md                   normative protocol behavior
  IMPLEMENTER-CHECKLIST.md    implementation and test requirements
media/                        bundled review UI
src/protocol/                 types, validation, snapshots, storage, state fold
src/renderedView.ts           secure rendered-review webview
src/setupView.ts              visual review/document setup panel
src/reviewsView.ts            multiple-review registry and Activity Bar list
src/pdfExport.ts              local PDF and audit-event generation
src/extension.ts              commands, identity, status, and lifecycle
test/                         conformance, capture, merge, security, and PDF tests
output/pdf/                   visually verified sample audit report
```

## Verification

`npm test` currently covers:

- runtime validation and all three JSON Schemas;
- deterministic revision-scoped event folding;
- visual-scope pattern expansion, selection validation, and selective snapshot capture;
- deterministic comment/suggestion decision conflicts and out-of-order event arrival;
- out-of-order synchronization;
- resilient quote anchors;
- rendered and source-editor comment highlighting, discussion cards with replies, and bidirectional anchor navigation;
- Mermaid, image, table, link, and attachment discovery;
- local and remote content capture with secret redaction;
- fail-closed missing-image behavior;
- atomic event collision handling;
- custom-named package storage and isolation between multiple reviews of one workspace;
- PDF content, resource, Mermaid, comment, suggested-edit, approval/rejection, and digest generation.

The sample PDF is also rendered to PNG with Poppler and visually inspected for clipping, overlap, page numbering, diagrams, tables, and audit-layout quality.

## Pilot limits

- Actor IDs are self-asserted. The shared folder's access control is the authority for this pilot.
- Events are hashed for export but are not cryptographically signed.
- Raw HTML is disabled. Mermaid runs with strict security and a restrictive webview content-security policy.
- Embedded images and `review:attach` links are frozen; ordinary linked web pages remain external references.
- Protocol 0.4 keeps all decisions monotonic and does not edit or delete historical events. Conflicting decisions are surfaced rather than silently overwritten.
- Very large or unusually wide tables should be included in pilot test cases before broad deployment.

See [PILOT.md](PILOT.md) for the test plan, [SECURITY.md](SECURITY.md) for the threat model, and [protocol/README.md](protocol/README.md) for normative rules.

## License

Open Markdown Review is dual-licensed. You may use it under either:

- the standard [MIT License](LICENSE); or
- [M.I.R.D.A. philosophy](PHILOSOPHY.md).

The package metadata expresses this choice as `MIT`.
