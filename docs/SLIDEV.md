# Review a Slidev deck

Slidev is an optional review profile, not part of the core Markdown/event standard. Both the browser toolbox and VS Code show the same frozen slides and exact source from one review package.

## Author prerequisites

Use a trusted Slidev project with Node 22+ and project-local `@slidev/cli@52.19.1`, the deck's theme, and `playwright-chromium@1.62.1`. Install these yourself; the extension never silently installs packages or runs a received deck. Only authors need this runtime. A typical project setup is:

```sh
npm install --save-dev @slidev/cli@52.19.1 @slidev/theme-default@0.25.0 playwright-chromium@1.62.1
```

Slidev can execute themes, components and configuration with your permissions. Its dependency graph includes currently unpatched `image-size` advisories in PPTX export; OMR calls only PNG export. Do not use the pinned example runtime for PPTX export. See the [scope and dependency note](../spec/SLIDEV-PROFILE-V1.md#qualification-and-exclusions).

## VS Code

1. Open the trusted deck workspace and choose **Markdown Review: Create New Review**.
2. Choose the review folder/name and set the deck entry, usually `slides.md`, as the root document.
3. Choose **Slidev presentation**. The root deck and its `src:` imports define presentation scope; other checked documents are not added as independent slides.
4. Choose whether speaker notes may be shared. Excluding them removes trailing note comments from the shared Markdown.
5. Confirm **Run trusted Slidev capture**. Review the frozen pages before distributing the folder.

Later revisions retain the same profile and require explicit parents. If an earlier review used plain Markdown, create a new review to adopt the Slidev profile; its immutable manifest cannot be silently changed.

## CLI

From a built checkout, use the same authoring service without VS Code:

```sh
node dist/cli.js review create \
  --source /path/to/trusted-deck \
  --store /path/to/shared/deck-review \
  --root-document slides.md --include slides.md \
  --profile slidev-v1 --notes exclude --trust-slidev-project \
  --actor-id author --operation-id deck-review-001
```

Use quoted Windows disk/UNC paths as appropriate. `--browser-executable` may specify a locally installed Chromium-compatible browser for capture. `--dry-run` resolves local imports and validates syntax without running Slidev, fetching images or writing output. `--resume` requires the original operation ID and matching parameters. A source change requires a new operation. For a new revision, use `revision create` with one or more `--parent REVISION_ID` values and the same profile parameters.

## Reviewer workflow

Open `OpenMarkdownReview.html` in VS Code or double-click it in supported Edge/Chrome and grant the same folder when asked. No source workspace or Slidev installation is needed.

- Select a slide in the left list or use Previous/Next.
- Click the slide and choose **Comment** for a visual concern about that particular occurrence.
- Select words in **Reviewed source** for a precise source comment, replacement, insertion or strikeout suggestion.
- Use the normal toolbox for replies, decisions, resolution/reopening and review approval/rejection.
- Click a highlighted target to open its discussion. **Locate** on a discussion switches to the relevant slide or source.
- **Export audit PDF** includes every slide/source/discussion, not just the current slide or filtered comments.

Repeated imports share source wording comments but have separate visual targets. Frozen PNGs are static evidence: playing video, testing interactions, selecting arbitrary pixel rectangles or reviewing animation timing is outside v1. Note exclusion is not a secret scanner. Automatic source application refuses redacted snapshots that do not match the original source digest; make those edits manually and capture a new revision.

## Development checks

```sh
npm ci
npm test
npx playwright install chromium
node scripts/install-slidev-fixture.mjs
node --test out/test/browser.integration.js
node scripts/test-extension.mjs
```

The fixture installer uses a separately locked runtime under `examples/slidev`, audits it with narrow, time-bounded PPTX-only exceptions, and does not change the main application's audit. Linux and Windows CI execute the real capture and browser scenarios. Native browser permissions and SMB qualification are separate; SMB testing remains skipped by decision.

Protocol details: [profile transport](../protocol/profiles/README.md), [Slidev v1 specification](../spec/SLIDEV-PROFILE-V1.md), [schema](../protocol/profiles/slidev/v1.schema.json), [example deck](../examples/slidev/slides.md).
