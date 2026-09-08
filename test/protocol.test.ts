import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { locateQuote } from "../src/protocol/anchor";
import { mapWithConcurrency } from "../src/protocol/concurrency";
import { detectEventRegression, retryDelay, reviewPackageFingerprint, semanticEventFingerprint, SerializedCoalescingRunner, SYNC_RETRY_DELAYS_MS } from "../src/liveSync";
import { discoverReviewPackages } from "../src/protocol/discovery";
import { documentsForPatterns, validateDocumentSelection } from "../src/protocol/scope";
import { exportAuditPdf } from "../src/pdfExport";
import { ReviewCache } from "../src/reviewCache";
import { installPortableBrowserClient, PORTABLE_BROWSER_FILENAME } from "../src/portableBrowser";
import { createSnapshot, inspectMarkdown, tableIdFor } from "../src/protocol/snapshot";
import {
  appendEvent,
  initializeReview,
  loadEvents,
  loadManifest,
  loadRevision,
  sha256,
  verifyRevisionContent,
} from "../src/protocol/store";
import { buildReviewState } from "../src/protocol/state";
import {
  ActorRef,
  CommentCreatedEvent,
  CommentRepliedEvent,
  EVENT_SCHEMA_VERSION,
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  ReviewApprovedEvent,
  ReviewEvent,
  ReviewManifest,
  ReviewRejectedEvent,
  ReviewRevision,
  RevisionCreatedEvent,
  SuggestionAcceptedEvent,
  SuggestionAppliedEvent,
  SuggestionCreatedEvent,
  SuggestionRejectedEvent,
  ThreadDecidedEvent,
  ThreadResolvedEvent,
} from "../src/protocol/types";
import { validateEvent, validateEventAgainstRevision, validateEventCapabilities, validateEventGraph, validateManifest, validatePublishedRevision, validateRevision } from "../src/protocol/validation";

const actor: ActorRef = { id: "reviewer", displayName: "Reviewer" };
const digest = `sha256:${"a".repeat(64)}` as const;

function manifest(reviewId = "review_test"): ReviewManifest {
  return {
    protocol: PROTOCOL_ID,
    protocolVersion: PROTOCOL_VERSION,
    reviewId,
    title: "Test review",
    createdAt: "2026-08-13T10:00:00.000Z",
    createdBy: actor,
    documents: ["**/*.md"],
    eventDirectory: "events",
    revisionDirectory: "revisions",
    blobDirectory: "blobs/sha256",
    exportDirectory: "exports",
    capabilities: ["quote-anchor-v1", "range-anchor-v1", "semantic-anchor-v1", "content-addressed-resources-v1", "audit-export-v1", "thread-decision-v1", "suggested-edit-v1", "review-rejection-v1"],
  };
}

function revisionCreated(reviewId = "review_test"): RevisionCreatedEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: "evt_revision",
    type: "revision.created",
    reviewId,
    revisionId: "revision_1",
    occurredAt: "2026-08-13T10:00:30.000Z",
    actor,
    revisionPath: "revisions/revision_1.json",
    revisionDigest: digest,
  };
}

function created(reviewId = "review_test"): CommentCreatedEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: "evt_created",
    type: "comment.created",
    reviewId,
    revisionId: "revision_1",
    occurredAt: "2026-08-13T10:01:00.000Z",
    actor,
    threadId: "thread_1",
    commentId: "comment_1",
    anchor: {
      document: "architecture.md",
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 12 } },
      quote: { exact: "global state", prefix: "owns the ", suffix: "." },
      documentDigest: digest,
      target: { kind: "text" },
    },
    body: { format: "markdown", text: "Who owns this?" },
  };
}

function replied(reviewId = "review_test"): CommentRepliedEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: "evt_replied",
    type: "comment.replied",
    reviewId,
    revisionId: "revision_1",
    occurredAt: "2026-08-13T10:02:00.000Z",
    actor,
    threadId: "thread_1",
    commentId: "comment_2",
    inReplyTo: "comment_1",
    body: { format: "markdown", text: "The runtime." },
  };
}

function resolved(reviewId = "review_test"): ThreadResolvedEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: "evt_resolved",
    type: "thread.resolved",
    reviewId,
    revisionId: "revision_1",
    occurredAt: "2026-08-13T10:03:00.000Z",
    actor,
    threadId: "thread_1",
  };
}

function approved(reviewId = "review_test"): ReviewApprovedEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: "evt_approved",
    type: "review.approved",
    reviewId,
    revisionId: "revision_1",
    occurredAt: "2026-08-13T10:04:00.000Z",
    actor,
    note: "Looks good.",
  };
}

function decided(decision: ThreadDecidedEvent["decision"] = "accepted", reviewId = "review_test"): ThreadDecidedEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: `evt_decided_${decision.replace("-", "_")}`,
    type: "thread.decided",
    reviewId,
    revisionId: "revision_1",
    occurredAt: decision === "accepted" ? "2026-08-13T10:03:10.000Z" : "2026-08-13T10:03:20.000Z",
    actor,
    threadId: "thread_1",
    decision,
    reason: "Audited decision.",
  };
}

function suggestionCreated(reviewId = "review_test"): SuggestionCreatedEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: "evt_suggestion_created",
    type: "suggestion.created",
    reviewId,
    revisionId: "revision_1",
    occurredAt: "2026-08-13T10:05:00.000Z",
    actor,
    suggestionId: "suggestion_1",
    anchor: { ...created(reviewId).anchor, quote: { exact: "global state", prefix: "owns the ", suffix: "." } },
    operation: { kind: "replace", replacement: "runtime state" },
    rationale: { format: "markdown", text: "Use the precise ownership term." },
  };
}

function suggestionAccepted(reviewId = "review_test"): SuggestionAcceptedEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: "evt_suggestion_accepted",
    type: "suggestion.accepted",
    reviewId,
    revisionId: "revision_1",
    occurredAt: "2026-08-13T10:06:00.000Z",
    actor,
    suggestionId: "suggestion_1",
  };
}

function suggestionRejected(reviewId = "review_test"): SuggestionRejectedEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: "evt_suggestion_rejected",
    type: "suggestion.rejected",
    reviewId,
    revisionId: "revision_1",
    occurredAt: "2026-08-13T10:06:01.000Z",
    actor: { id: "other-reviewer" },
    suggestionId: "suggestion_1",
    reason: "Keep the existing term.",
  };
}

function suggestionApplied(reviewId = "review_test"): SuggestionAppliedEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: "evt_suggestion_applied",
    type: "suggestion.applied",
    reviewId,
    revisionId: "revision_1",
    occurredAt: "2026-08-13T10:07:00.000Z",
    actor,
    suggestionId: "suggestion_1",
    document: "architecture.md",
    sourceDigestBefore: digest,
    sourceDigestAfter: `sha256:${"b".repeat(64)}`,
  };
}

function reviewRejected(reviewId = "review_test"): ReviewRejectedEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: "evt_review_rejected",
    type: "review.rejected",
    reviewId,
    revisionId: "revision_1",
    occurredAt: "2026-08-13T10:08:00.000Z",
    actor,
    reason: "Required change remains open.",
  };
}

test("checked-in manifest, revision, and events pass runtime and JSON Schema validation", async () => {
  const reviewRoot = path.resolve("protocol/examples/.review");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const manifestSchema = JSON.parse(await readFile("protocol/schemas/manifest.schema.json", "utf8"));
  const revisionSchema = JSON.parse(await readFile("protocol/schemas/revision.schema.json", "utf8"));
  const eventSchema = JSON.parse(await readFile("protocol/schemas/event.schema.json", "utf8"));
  const manifestValue: unknown = JSON.parse(await readFile(path.join(reviewRoot, "manifest.json"), "utf8"));
  assert.equal(validateManifest(manifestValue).ok, true);
  assert.equal(ajv.validate(manifestSchema, manifestValue), true, ajv.errorsText());

  const revisions = (await readdir(path.join(reviewRoot, "revisions"))).filter((name) => name.endsWith(".json"));
  assert.equal(revisions.length, 1);
  const revisionValue: unknown = JSON.parse(await readFile(path.join(reviewRoot, "revisions", revisions[0]), "utf8"));
  assert.equal(validateRevision(revisionValue).ok, true);
  assert.equal(ajv.validate(revisionSchema, revisionValue), true, ajv.errorsText());

  const eventNames = (await readdir(path.join(reviewRoot, "events"))).filter((name) => name.endsWith(".json"));
  assert.ok(eventNames.length >= 5);
  for (const name of eventNames) {
    const value: unknown = JSON.parse(await readFile(path.join(reviewRoot, "events", name), "utf8"));
    assert.equal(validateEvent(value).ok, true, name);
    assert.equal(ajv.validate(eventSchema, value), true, `${name}: ${ajv.errorsText()}`);
  }
});

test("protocol 0.4 portable-path fixture passes cross-file and blob conformance", async () => {
  const reviewRoot = path.resolve("protocol/fixtures/v0.4/review-package");
  const reviewManifest = await loadManifest(reviewRoot);
  assert.ok(reviewManifest);
  assert.equal(reviewManifest.protocolVersion, "0.4.0");
  assert.equal(reviewManifest.eventDirectory, "events");
  const loaded = await loadEvents(reviewRoot, reviewManifest.reviewId);
  assert.deepEqual(loaded.warnings, []);
  assert.equal(validateEventGraph(loaded.events).size, 0);
  const state = buildReviewState(loaded.events);
  const publication = state.revisionEvents.at(-1);
  assert.ok(publication);
  const revision = await loadRevision(reviewRoot, publication.revisionPath, publication.revisionDigest);
  assert.deepEqual(validatePublishedRevision(reviewManifest, publication, revision), []);
  assert.deepEqual(await verifyRevisionContent(reviewRoot, revision), []);
  for (const event of loaded.events) assert.deepEqual(validateEventAgainstRevision(event, revision), [], event.id);
  assert.equal(state.threads.get("thread_fixture_state")?.replies.length, 1);
  assert.equal(state.suggestions.get("suggestion_fixture_wording")?.status, "applied");
});

test("event fold is deterministic, revision-scoped, deduplicated, and monotonic", () => {
  const events: ReviewEvent[] = [approved(), resolved(), replied(), revisionCreated(), created(), replied()];
  const state = buildReviewState(events);
  assert.equal(state.latestRevisionId, "revision_1");
  assert.equal(state.threads.size, 1);
  assert.equal(state.threads.get("thread_1")?.replies.length, 1);
  assert.equal(state.threads.get("thread_1")?.resolved?.id, "evt_resolved");
  assert.equal(state.unresolvedThreads.length, 0);
  assert.equal(state.approvals.length, 1);
  assert.equal(state.danglingEvents.length, 0);
});

test("comment decisions and suggested-edit lifecycle fold deterministically", () => {
  const accepted = buildReviewState([
    suggestionApplied(), suggestionAccepted(), decided(), suggestionCreated(), created(), revisionCreated(), reviewRejected(),
  ]);
  assert.equal(accepted.threads.get("thread_1")?.decision?.decision, "accepted");
  assert.equal(accepted.unresolvedThreads.length, 0);
  assert.equal(accepted.suggestions.get("suggestion_1")?.status, "applied");
  assert.equal(accepted.openSuggestions.length, 0);
  assert.equal(accepted.rejections.length, 1);

  const conflicted = buildReviewState([
    suggestionRejected(), decided("rejected"), suggestionApplied(), suggestionAccepted(), suggestionCreated(), decided(), created(), revisionCreated(),
  ]);
  assert.equal(conflicted.threads.get("thread_1")?.decisionConflicts.length, 1);
  assert.equal(conflicted.unresolvedThreads.length, 1);
  assert.equal(conflicted.suggestions.get("suggestion_1")?.status, "conflicted");
  assert.equal(conflicted.suggestions.get("suggestion_1")?.decisionConflicts.length, 1);
  assert.equal(conflicted.openSuggestions.length, 1);
});

test("suggestion decisions arriving before their root remain dangling", () => {
  const incomplete = buildReviewState([revisionCreated(), suggestionAccepted(), suggestionApplied()]);
  assert.equal(incomplete.danglingEvents.length, 2);
  const complete = buildReviewState([suggestionApplied(), suggestionAccepted(), revisionCreated(), suggestionCreated()]);
  assert.equal(complete.danglingEvents.length, 0);
  assert.equal(complete.suggestions.get("suggestion_1")?.status, "applied");
});

test("out-of-order thread events remain dangling until their root syncs", () => {
  const incomplete = buildReviewState([revisionCreated(), replied(), resolved()]);
  assert.equal(incomplete.danglingEvents.length, 2);
  const complete = buildReviewState([replied(), revisionCreated(), created(), resolved()]);
  assert.equal(complete.danglingEvents.length, 0);
});

test("competing root objects are quarantined instead of resolved by arrival order", () => {
  const competingComment: CommentCreatedEvent = { ...created(), id: "evt_created_competing", commentId: "comment_competing" };
  const competingSuggestion: SuggestionCreatedEvent = { ...suggestionCreated(), id: "evt_suggestion_competing", anchor: { ...suggestionCreated().anchor } };
  const state = buildReviewState([revisionCreated(), created(), competingComment, suggestionCreated(), competingSuggestion]);
  assert.equal(state.threads.has("thread_1"), false);
  assert.equal(state.suggestions.has("suggestion_1"), false);
  assert.deepEqual(new Set(state.danglingEvents.map((event) => event.id)), new Set([
    "evt_created", "evt_created_competing", "evt_suggestion_created", "evt_suggestion_competing",
  ]));
  const graph = validateEventGraph([revisionCreated(), created(), competingComment, suggestionCreated(), competingSuggestion]);
  assert.match(graph.get("evt_created")?.join(";") ?? "", /competing root/);
  assert.match(graph.get("evt_suggestion_created")?.join(";") ?? "", /competing root/);
});

test("event graph rejects cross-thread replies and invalid detached export inventories", () => {
  const crossThread = { ...replied(), inReplyTo: "comment_elsewhere" };
  const otherRoot = { ...created(), id: "evt_other_root", threadId: "thread_other", commentId: "comment_elsewhere" };
  const invalidExport: ReviewEvent = {
    schemaVersion: EVENT_SCHEMA_VERSION, id: "evt_export", type: "export.created", reviewId: "review_test", revisionId: "revision_1",
    occurredAt: "2026-08-13T10:09:00.000Z", actor, exportId: "export_1", format: "application/pdf", exportPath: "exports/a.pdf",
    exportDigest: digest, includedEventIds: ["evt_export", "missing"], renderer: { client: "open-markdown-review-vscode", clientVersion: "test", pdfEngine: "test", mermaidVersion: "test" }, renderedDiagramDigests: {},
  };
  const graph = validateEventGraph([revisionCreated(), created(), otherRoot, crossThread, invalidExport]);
  assert.match(graph.get(crossThread.id)?.join(";") ?? "", /inReplyTo/);
  assert.match(graph.get(invalidExport.id)?.join(";") ?? "", /own detached|missing or ambiguous/);
});

test("audit export metadata is client-neutral", async () => {
  const browserExport: ReviewEvent = {
    schemaVersion: EVENT_SCHEMA_VERSION, id: "evt_browser_export", type: "export.created", reviewId: "review_test", revisionId: "revision_1",
    occurredAt: "2026-08-13T10:09:00.000Z", actor, exportId: "export_browser", format: "application/pdf", exportPath: "exports/browser.pdf",
    exportDigest: digest, includedEventIds: [], renderer: { client: "open-markdown-review-browser", clientVersion: "0.1.0", pdfEngine: "PDFKit 0.17.2", mermaidVersion: "11.10.1" }, renderedDiagramDigests: {},
  };
  assert.equal(validateEvent(browserExport).ok, true);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const eventSchema = JSON.parse(await readFile("protocol/schemas/event.schema.json", "utf8"));
  assert.equal(ajv.validate(eventSchema, browserExport), true, ajv.errorsText());
});

test("quote anchors survive inserted text and prefer matching context", () => {
  const document = "First owns the global state.\nSecond owns the global state.\n";
  const found = locateQuote(document, "global state", "Second owns the ", ".", 0);
  assert.ok(found);
  assert.equal(found.start, document.lastIndexOf("global state"));
  assert.equal(found.confidence, "context");
});

test("review scope expands legacy patterns and validates exact visual selections", () => {
  const available = ["README.md", "docs/a.md", "docs/nested/b.md", "other.md"];
  assert.deepEqual(documentsForPatterns(available, ["docs/**/*.md"]), ["docs/a.md", "docs/nested/b.md"]);
  assert.deepEqual(documentsForPatterns(available, ["*.md"]), ["README.md", "other.md"]);
  assert.deepEqual(documentsForPatterns(available, ["docs/a.md", "other.md"]), ["docs/a.md", "other.md"]);
  assert.deepEqual(validateDocumentSelection(available, ["docs/a.md"], "docs/a.md"), []);
  assert.ok(validateDocumentSelection(available, [], "").length > 0);
  assert.ok(validateDocumentSelection(available, ["missing.md"], "missing.md").some((error) => error.includes("unavailable")));
});

test("Markdown inspection finds Mermaid, images, GFM links, and tables without executing HTML", () => {
  const source = "# Test\n\n```mermaid\nflowchart LR\n A-->B\n```\n\n![Local](img.svg)\n\n[Policy](https://example.com/policy)\n\n[Evidence](evidence.pdf \"review:attach\")\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>";
  const result = inspectMarkdown(source, "test.md");
  assert.equal(result.images.length, 1);
  assert.equal(result.attachments.length, 1);
  assert.equal(result.mermaidDiagrams.length, 1);
  assert.equal(result.externalReferences.length, 1);
  assert.equal(result.mermaidDiagrams[0].sourceDigest, sha256("flowchart LR\n A-->B"));
});

test("snapshot freezes local and remote images, redacts secrets, and verifies all blobs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omr-snapshot-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "assets", "local.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="blue"/></svg>');
  await writeFile(path.join(root, "assets", "evidence.txt"), "Frozen audit evidence\n");
  await writeFile(path.join(root, "architecture.md"), "# Architecture\n\n![Local](assets/local.svg)\n\n![Remote](https://cdn.example/remote.svg?token=secret)\n\n[Evidence](assets/evidence.txt \"review:attach\")\n\n[Policy](https://example.com/policy?sig=secret)\n\n```mermaid\nflowchart LR\nA-->B\n```\n");
  const reviewManifest = manifest();
  const reviewRoot = path.join(root, ".architecture-review");
  await initializeReview(reviewRoot, reviewManifest);
  const mockFetch: typeof fetch = async () => new Response('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="10"/>', { status: 200, headers: { "content-type": "image/svg+xml" } });
  const result = await createSnapshot(root, reviewManifest, actor, { rootDocument: "architecture.md", storageRoot: reviewRoot, fetchImplementation: mockFetch });
  assert.equal(result.revision.resources.length, 3);
  assert.equal(result.revision.resources.filter((item) => item.role === "attachment").length, 1);
  assert.equal(result.revision.mermaidDiagrams.length, 1);
  assert.match(result.revision.resources.find((item) => item.sourceKind === "remote")?.originalReference ?? "", /token=REDACTED/);
  assert.match(result.revision.externalReferences[0].uri, /sig=REDACTED/);
  assert.deepEqual(await verifyRevisionContent(reviewRoot, result.revision), []);
  const loaded = await loadRevision(reviewRoot, result.event.revisionPath, result.event.revisionDigest);
  assert.equal(loaded.id, result.revision.id);
});

test("snapshot fails closed when an embedded image cannot be frozen", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omr-snapshot-failure-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "review.md"), "# Review\n\n![Missing](https://cdn.example/missing.png)\n");
  const reviewManifest = manifest();
  const reviewRoot = path.join(root, "review-data");
  await initializeReview(reviewRoot, reviewManifest);
  const mockFetch: typeof fetch = async () => new Response("missing", { status: 404, statusText: "Not Found" });
  await assert.rejects(() => createSnapshot(root, reviewManifest, actor, { rootDocument: "review.md", storageRoot: reviewRoot, fetchImplementation: mockFetch }), /could not be frozen/);
  assert.equal((await loadEvents(reviewRoot)).events.length, 0);
});

test("snapshot freezes only the documents selected in visual review setup", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omr-scope-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "README.md"), "# Not selected\n");
  await writeFile(path.join(root, "docs", "included.md"), "# Included\n");
  await writeFile(path.join(root, "docs", "excluded.md"), "# Excluded\n");
  const reviewManifest = manifest();
  const reviewRoot = path.join(root, ".review-selected");
  await initializeReview(reviewRoot, reviewManifest);
  const snapshot = await createSnapshot(root, reviewManifest, actor, {
    rootDocument: "docs/included.md",
    documentPaths: ["docs/included.md"],
    storageRoot: reviewRoot,
  });
  assert.deepEqual(snapshot.revision.documents.map((item) => item.path), ["docs/included.md"]);
  await assert.rejects(() => createSnapshot(root, reviewManifest, actor, {
    rootDocument: "missing.md",
    documentPaths: ["missing.md"],
    storageRoot: reviewRoot,
  }), /not found/);
});

test("later revisions reuse verified content-addressed blobs and reject corrupted targets", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "omr-blob-reuse-"));
  t.after(async () => rm(sourceRoot, { recursive: true, force: true }));
  await writeFile(path.join(sourceRoot, "review.md"), "# Stable revision content\n");
  const reviewRoot = path.join(sourceRoot, ".review");
  const reviewManifest = manifest();
  await initializeReview(reviewRoot, reviewManifest);
  const first = await createSnapshot(sourceRoot, reviewManifest, actor, { rootDocument: "review.md", documentPaths: ["review.md"], storageRoot: reviewRoot });
  const target = path.resolve(reviewRoot, ...first.revision.documents[0].blobPath.split("/"));
  const before = await stat(target);
  await createSnapshot(sourceRoot, reviewManifest, actor, { rootDocument: "review.md", documentPaths: ["review.md"], storageRoot: reviewRoot });
  const after = await stat(target);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);

  await writeFile(target, "corrupt immutable bytes\n");
  await assert.rejects(
    createSnapshot(sourceRoot, reviewManifest, actor, { rootDocument: "review.md", documentPaths: ["review.md"], storageRoot: reviewRoot }),
    /Blob collision detected/,
  );
});

test("file store creates one immutable file per event and rejects collisions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omr-store-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await initializeReview(root, manifest());
  for (const event of [revisionCreated(), created(), replied(), resolved(), decided(), approved(), suggestionCreated(), suggestionAccepted(), suggestionApplied(), reviewRejected()]) await appendEvent(root, event);
  await assert.rejects(() => appendEvent(root, created()), /already exists/);
  const loaded = await loadEvents(root, "review_test");
  assert.equal((await loadManifest(root))?.reviewId, "review_test");
  assert.equal(loaded.warnings.length, 0);
  assert.equal(loaded.events.length, 10);
});

test("review cache reconciles only new event files and survives client restart", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omr-cache-review-"));
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "omr-cache-local-"));
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(cacheRoot, { recursive: true, force: true }),
  ]));
  const reviewManifest = manifest();
  await initializeReview(root, reviewManifest);
  await appendEvent(root, created());
  const firstClient = new ReviewCache(cacheRoot);
  const first = await firstClient.reconcileEvents(root, reviewManifest);
  assert.equal(first.loadedFileCount, 1);
  assert.equal(first.cachedEventCount, 0);
  await firstClient.save(root, reviewManifest, first.events);

  const restartedClient = new ReviewCache(cacheRoot);
  const warm = await restartedClient.reconcileEvents(root, reviewManifest);
  assert.equal(warm.loadedFileCount, 0);
  assert.equal(warm.cachedEventCount, 1);
  assert.deepEqual(warm.events.map((event) => event.id), [created().id]);

  await appendEvent(root, replied());
  const incremental = await restartedClient.reconcileEvents(root, reviewManifest);
  assert.equal(incremental.loadedFileCount, 1);
  assert.equal(incremental.cachedEventCount, 1);
  assert.deepEqual(new Set(incremental.events.map((event) => event.id)), new Set([created().id, replied().id]));
});

test("review cache reloads watcher-directed rewrites and reports missing immutable events", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omr-cache-regression-review-"));
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "omr-cache-regression-local-"));
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(cacheRoot, { recursive: true, force: true }),
  ]));
  const reviewManifest = manifest();
  await initializeReview(root, reviewManifest);
  await appendEvent(root, created());
  const cache = new ReviewCache(cacheRoot);
  const initial = await cache.reconcileEvents(root, reviewManifest);
  await cache.save(root, reviewManifest, initial.events);

  const rewrittenComment = { ...created(), body: { format: "markdown" as const, text: "Rewritten on shared storage" } };
  await writeFile(path.join(root, "events", `${created().id}.json`), `${JSON.stringify(rewrittenComment)}\n`);
  const rewritten = await cache.reconcileEvents(root, reviewManifest, { reloadEventNames: [`${created().id}.json`] });
  assert.equal(rewritten.loadedFileCount, 1);
  assert.deepEqual(detectEventRegression(initial.events, rewritten.events).rewritten.map((event) => event.id), [created().id]);

  await rm(path.join(root, "events", `${created().id}.json`));
  const missing = await cache.reconcileEvents(root, reviewManifest);
  assert.deepEqual(missing.missingCachedEvents.map((event) => event.id), [created().id]);
});

test("content-addressed cache serves frozen Markdown after the shared blob becomes unavailable", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "omr-cache-content-source-"));
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "omr-cache-content-local-"));
  t.after(async () => Promise.all([
    rm(sourceRoot, { recursive: true, force: true }),
    rm(cacheRoot, { recursive: true, force: true }),
  ]));
  await writeFile(path.join(sourceRoot, "review.md"), "# Cached review\n\nFrozen over a slow share.\n");
  const reviewRoot = path.join(sourceRoot, ".review-cache-content");
  const reviewManifest = manifest();
  await initializeReview(reviewRoot, reviewManifest);
  const snapshot = await createSnapshot(sourceRoot, reviewManifest, actor, {
    rootDocument: "review.md",
    documentPaths: ["review.md"],
    storageRoot: reviewRoot,
  });
  const firstClient = new ReviewCache(cacheRoot);
  const cold = await firstClient.materializeRevision(reviewRoot, snapshot.revision);
  assert.deepEqual(cold.errors, []);
  assert.equal(cold.sharedReads, 1);
  const frozenDocument = snapshot.revision.documents[0];
  await rm(path.resolve(reviewRoot, ...frozenDocument.blobPath.split("/")));

  const restartedClient = new ReviewCache(cacheRoot);
  const warm = await restartedClient.materializeRevision(reviewRoot, snapshot.revision);
  assert.deepEqual(warm.errors, []);
  assert.equal(warm.sharedReads, 0);
  assert.equal(warm.localHits, 1);
  assert.equal(await readFile(warm.paths.get(frozenDocument.digest)!, "utf8"), "# Cached review\n\nFrozen over a slow share.\n");
  const audited = await restartedClient.materializeRevision(reviewRoot, snapshot.revision, { auditShared: true });
  assert.ok(audited.errors.some((error) => error.includes(frozenDocument.blobPath)), "a full audit must not trust local bytes when shared content is missing");
});

test("content cache prunes least-recently-used inactive blobs while protecting the active revision", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "omr-cache-prune-source-"));
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "omr-cache-prune-local-"));
  t.after(async () => Promise.all([
    rm(sourceRoot, { recursive: true, force: true }),
    rm(cacheRoot, { recursive: true, force: true }),
  ]));
  const reviewRoot = path.join(sourceRoot, ".review-cache-prune");
  const reviewManifest = manifest();
  await initializeReview(reviewRoot, reviewManifest);
  await writeFile(path.join(sourceRoot, "review.md"), `# First\n\n${"A".repeat(48)}\n`);
  const first = await createSnapshot(sourceRoot, reviewManifest, actor, { rootDocument: "review.md", documentPaths: ["review.md"], storageRoot: reviewRoot });
  const cache = new ReviewCache(cacheRoot, { maxContentBytes: 80 });
  assert.deepEqual((await cache.materializeRevision(reviewRoot, first.revision)).errors, []);

  await writeFile(path.join(sourceRoot, "review.md"), `# Second\n\n${"B".repeat(48)}\n`);
  const second = await createSnapshot(sourceRoot, reviewManifest, actor, { rootDocument: "review.md", documentPaths: ["review.md"], storageRoot: reviewRoot });
  assert.deepEqual((await cache.materializeRevision(reviewRoot, second.revision)).errors, []);
  const firstDocument = first.revision.documents[0];
  await rm(path.resolve(reviewRoot, ...firstDocument.blobPath.split("/")));

  const restarted = new ReviewCache(cacheRoot, { maxContentBytes: 80 });
  const evicted = await restarted.materializeRevision(reviewRoot, first.revision);
  assert.ok(evicted.errors.some((error) => error.includes(firstDocument.blobPath)));
  const active = await restarted.materializeRevision(reviewRoot, second.revision);
  assert.deepEqual(active.errors, []);
  assert.equal(active.localHits, 1);
});

test("live synchronization fingerprint uses only the immutable event publication frontier", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omr-live-sync-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const reviewManifest = manifest();
  await initializeReview(root, reviewManifest);
  const initial = await reviewPackageFingerprint(root, reviewManifest);
  await writeFile(path.join(root, "local-note.txt"), "not protocol state\n");
  assert.equal(await reviewPackageFingerprint(root, reviewManifest), initial);
  await appendEvent(root, created());
  const afterEvent = await reviewPackageFingerprint(root, reviewManifest);
  assert.notEqual(afterEvent, initial);
  await writeFile(path.join(root, "revisions", "incoming.json"), "{}\n");
  assert.equal(await reviewPackageFingerprint(root, reviewManifest), afterEvent, "an unpublished revision is not visible review state");
  await appendEvent(root, replied());
  assert.notEqual(await reviewPackageFingerprint(root, reviewManifest), afterEvent);
});

test("bounded I/O mapping never exceeds its configured concurrency", async () => {
  let active = 0;
  let maximum = 0;
  const values = await mapWithConcurrency([...Array(16).keys()], 3, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    return value * 2;
  });
  assert.equal(maximum, 3);
  assert.deepEqual(values, [...Array(16).keys()].map((value) => value * 2));
});

test("live synchronization semantic fingerprints are order-independent and retry backoff is bounded", () => {
  const events = [created(), replied()];
  assert.equal(semanticEventFingerprint(events, "revision_1"), semanticEventFingerprint([...events].reverse(), "revision_1"));
  const changed = [{ ...created(), body: { format: "markdown" as const, text: "Changed review comment" } }, replied()];
  assert.notEqual(semanticEventFingerprint(events, "revision_1"), semanticEventFingerprint(changed, "revision_1"));
  assert.deepEqual(SYNC_RETRY_DELAYS_MS.map((_, index) => retryDelay(index)), [...SYNC_RETRY_DELAYS_MS]);
  assert.equal(retryDelay(SYNC_RETRY_DELAYS_MS.length), undefined);
});

test("live synchronization rejects disappearance or rewrite of previously validated events", () => {
  const previous = [created(), replied()];
  const missing = detectEventRegression(previous, [created()]);
  assert.deepEqual(missing.missing.map((event) => event.id), ["evt_replied"]);
  assert.deepEqual(missing.rewritten, []);
  const rewrittenComment = { ...created(), body: { format: "markdown" as const, text: "Rewritten in place" } };
  const rewritten = detectEventRegression(previous, [rewrittenComment, replied()]);
  assert.deepEqual(rewritten.missing, []);
  assert.deepEqual(rewritten.rewritten.map((event) => event.id), ["evt_created"]);
});

test("live synchronization serializes refresh work and coalesces notification bursts", async () => {
  const processed: number[] = [];
  let active = 0;
  let maximumActive = 0;
  let markFirstStarted: (() => void) | undefined;
  let releaseFirst: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const runner = new SerializedCoalescingRunner<number>(async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    processed.push(value);
    if (value === 1) {
      markFirstStarted?.();
      await firstBlocked;
    }
    active -= 1;
  });
  const first = runner.request(1);
  await firstStarted;
  const second = runner.request(2);
  const third = runner.request(3);
  releaseFirst?.();
  await Promise.all([first, second, third]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(processed, [1, 3]);
});

test("custom-named review packages remain independent for multiple reviews of one workspace", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "omr-multiple-"));
  t.after(async () => rm(sourceRoot, { recursive: true, force: true }));
  await writeFile(path.join(sourceRoot, "architecture.md"), "# Architecture\n\nShared source.\n");
  const architectureRoot = path.join(sourceRoot, ".architecture-review");
  const sharedDriveRoot = path.join(sourceRoot, "mounted-share", "safety-approval");
  const architecture = manifest("review_architecture");
  const safety = { ...manifest("review_safety"), title: "Safety approval" };
  await initializeReview(architectureRoot, architecture);
  await initializeReview(sharedDriveRoot, safety);
  await createSnapshot(sourceRoot, architecture, actor, { rootDocument: "architecture.md", storageRoot: architectureRoot });
  await createSnapshot(sourceRoot, safety, actor, { rootDocument: "architecture.md", storageRoot: sharedDriveRoot });
  assert.equal((await loadEvents(architectureRoot, architecture.reviewId)).events.length, 1);
  assert.equal((await loadEvents(sharedDriveRoot, safety.reviewId)).events.length, 1);
  assert.equal((await loadManifest(architectureRoot))?.reviewId, architecture.reviewId);
  assert.equal((await loadManifest(sharedDriveRoot))?.reviewId, safety.reviewId);
  assert.match(await readFile(path.join(architectureRoot, ".gitattributes"), "utf8"), /\*\*\/\* -text/);
  const discovered = await discoverReviewPackages(sourceRoot);
  assert.deepEqual(discovered.map((item) => item.manifest.reviewId).sort(), [architecture.reviewId, safety.reviewId].sort());
});

test("extension bundle includes PDFKit runtime font and color-profile assets", async () => {
  assert.match(await readFile(path.resolve("dist/data/Helvetica.afm"), "utf8"), /FontName Helvetica/);
  assert.ok((await readFile(path.resolve("dist/data/sRGB_IEC61966_2_1.icc"))).byteLength > 1_000);
});

test("portable browser client is generic, self-contained, bounded, and installed without overwriting", async (t) => {
  const artifact = path.resolve("dist/OpenMarkdownReview.html");
  const bytes = await readFile(artifact);
  const html = bytes.toString("utf8");
  assert.match(html, /name="open-markdown-review-portable-client"/);
  assert.match(html, /showDirectoryPicker/);
  assert.match(html, /open-markdown-review-portable/);
  assert.ok(html.includes('omr-professional-local'), 'portable client includes local permission/recovery storage');
  assert.ok(html.includes('Choose review folder'), 'portable client explains the folder grant');
  assert.match(html, /comment\.created/);
  assert.match(html, /review\.approved/);
  assert.match(html, /Mermaid/);
  assert.doesNotMatch(html, /review_test/);
  assert.doesNotMatch(html, /__PORTABLE_(?:CSS|JS)__/);
  assert.equal([...html.matchAll(/<script(?:\s[^>]*)?>/g)].length, 1);
  assert.equal([...html.matchAll(/<\/script>/g)].length, 1);
  assert.ok(/script-src 'sha256-[A-Za-z0-9+/=]+'/.test(html), 'bundle uses a fixed script hash');
  assert.ok(!html.includes("script-src 'unsafe-inline'") && !html.includes("'unsafe-eval'"), 'CSP does not allow dynamic code execution');
  const scriptStart = html.lastIndexOf("<script>") + "<script>".length;
  const scriptEnd = html.lastIndexOf("</script>");
  assert.ok(scriptStart > 0 && scriptEnd > scriptStart);
  assert.doesNotThrow(() => new Function(html.slice(scriptStart, scriptEnd)), "assembled browser bundle must remain syntactically valid");
  // 0.5.1 embeds the optional Slidev parser/schema so source-map verification
  // remains offline. Keep an explicit 7 MiB ceiling (currently about 6.1 MiB).
  assert.ok(bytes.byteLength < 7 * 1024 * 1024, "portable browser artifact should remain practical for a shared folder");

  const reviewRoot = await mkdtemp(path.join(os.tmpdir(), "omr-browser-client-"));
  t.after(async () => rm(reviewRoot, { recursive: true, force: true }));
  await initializeReview(reviewRoot, manifest());
  const manifestBefore = await readFile(path.join(reviewRoot, "manifest.json"));
  const target = await installPortableBrowserClient(reviewRoot, artifact);
  assert.equal(target, path.join(reviewRoot, PORTABLE_BROWSER_FILENAME));
  assert.deepEqual(await readFile(path.join(reviewRoot, "manifest.json")), manifestBefore);
  assert.equal((await readdir(path.join(reviewRoot, "events"))).length, 0);
  await assert.rejects(() => installPortableBrowserClient(reviewRoot, artifact), /already exists/);
});

test("rendered review links highlighted anchored text to comment cards and shows replies", () => {
  execFileSync(process.execPath, [path.resolve("scripts/verify-rendered-comments.cjs")], { stdio: "pipe" });
});

test("audit PDF contains frozen content, tables, images, Mermaid, comments, replies, and a detached export event", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omr-pdf-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "image.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#2458a6"/><text x="60" y="25" text-anchor="middle" fill="white">Frozen image</text></svg>');
  await writeFile(path.join(root, "review.md"), "# Pilot review\n\nReviewed paragraph.\n\n| Item | Status |\n|---|---|\n| Mermaid | Required |\n\n![Flow](image.svg)\n\n```mermaid\nflowchart LR\nA-->B\n```\n");
  const reviewManifest = manifest();
  const reviewRoot = path.join(root, ".pdf-review");
  await initializeReview(reviewRoot, reviewManifest);
  const snapshot = await createSnapshot(root, reviewManifest, actor, { rootDocument: "review.md", storageRoot: reviewRoot });
  const documentDigest = snapshot.revision.documents[0].digest;
  const comment: CommentCreatedEvent = { ...created(), reviewId: reviewManifest.reviewId, revisionId: snapshot.revision.id, anchor: { ...created().anchor, document: "review.md", documentDigest } };
  const reply: CommentRepliedEvent = { ...replied(), reviewId: reviewManifest.reviewId, revisionId: snapshot.revision.id };
  const approval: ReviewApprovedEvent = { ...approved(), reviewId: reviewManifest.reviewId, revisionId: snapshot.revision.id };
  const suggestion: SuggestionCreatedEvent = { ...suggestionCreated(), reviewId: reviewManifest.reviewId, revisionId: snapshot.revision.id, anchor: { ...suggestionCreated().anchor, document: "review.md", documentDigest, quote: { exact: "Reviewed paragraph.", prefix: "# Pilot review\n\n", suffix: "\n\n| Item" } } };
  const acceptance: SuggestionAcceptedEvent = { ...suggestionAccepted(), reviewId: reviewManifest.reviewId, revisionId: snapshot.revision.id };
  await appendEvent(reviewRoot, comment);
  await appendEvent(reviewRoot, reply);
  await appendEvent(reviewRoot, suggestion);
  await appendEvent(reviewRoot, acceptance);
  await appendEvent(reviewRoot, approval);
  const loaded = await loadEvents(reviewRoot, reviewManifest.reviewId);
  const state = buildReviewState(loaded.events);
  assert.equal(state.threads.get(comment.threadId)?.replies[0]?.body.text, reply.body.text);
  const diagram = snapshot.revision.mermaidDiagrams[0];
  const result = await exportAuditPdf({
    reviewRoot,
    manifest: reviewManifest,
    revision: snapshot.revision,
    state,
    events: loaded.events,
    renderData: { diagrams: { [diagram.id]: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><rect x="10" y="25" width="90" height="50" fill="#dce8fa"/><rect x="200" y="25" width="90" height="50" fill="#dce8fa"/><path d="M100 50 H200" stroke="#2458a6"/><text x="55" y="55" text-anchor="middle">A</text><text x="245" y="55" text-anchor="middle">B</text></svg>' }, diagramErrors: {} },
    actor,
    clientVersion: "0.4.4-test",
  });
  const pdf = await readFile(result.absolutePath);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.byteLength > 5_000);
  assert.equal(result.event.exportDigest, sha256(pdf));
  assert.ok(result.event.includedEventIds.includes(comment.id));
  assert.ok(result.event.includedEventIds.includes(reply.id));
  const after = await loadEvents(reviewRoot, reviewManifest.reviewId);
  assert.ok(after.events.some((event) => event.type === "export.created"));
});

test("validation rejects cross-workspace anchors and malformed digests", () => {
  const invalid = created() as unknown as Record<string, unknown>;
  invalid.anchor = { ...(invalid.anchor as Record<string, unknown>), document: "../outside.md", documentDigest: "sha256:not-a-digest" };
  const result = validateEvent(invalid);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((error) => error.includes("workspace-relative")));
    assert.ok(result.errors.some((error) => error.includes("sha256")));
  }
});

test("cross-file validation binds publications and anchors to exact frozen revision content", () => {
  const hash = "a".repeat(64);
  const frozen: ReviewRevision = {
    schemaVersion: "0.2.0",
    id: "revision_1",
    reviewId: "review_test",
    createdAt: "2026-08-13T10:00:00.000Z",
    createdBy: actor,
    rootDocument: "architecture.md",
    documents: [{ path: "architecture.md", digest, blobPath: `blobs/sha256/aa/${hash}`, mediaType: "text/markdown", byteLength: 12 }],
    resources: [],
    externalReferences: [],
    mermaidDiagrams: [],
    diagnostics: [],
    renderer: { markdownProfile: "commonmark-gfm", mermaidVersion: "11.10.1" },
  };
  assert.deepEqual(validatePublishedRevision(manifest(), revisionCreated(), frozen), []);
  assert.deepEqual(validateEventAgainstRevision(created(), frozen), []);
  assert.match(validatePublishedRevision(manifest("different_review"), revisionCreated(), frozen).join(";"), /manifest/);
  const wrongAnchor = { ...created(), anchor: { ...created().anchor, documentDigest: `sha256:${"b".repeat(64)}` as const } };
  assert.match(validateEventAgainstRevision(wrongAnchor, frozen).join(";"), /documentDigest/);
  assert.match(tableIdFor("architecture.md", 0), /^table_[a-f0-9]{24}$/);
  assert.equal(tableIdFor("architecture.md", 0), tableIdFor("architecture.md", 0));
  const withoutSuggestions = { ...manifest(), capabilities: manifest().capabilities.filter((item) => item !== "suggested-edit-v1") };
  assert.match(validateEventCapabilities(withoutSuggestions, suggestionCreated()).join(";"), /suggested-edit-v1/);
});

test("revision validation rejects ambiguous roots, reversed ranges, and digest-path disagreement", () => {
  const invalidEvent = created() as unknown as Record<string, unknown>;
  invalidEvent.anchor = {
    ...(invalidEvent.anchor as Record<string, unknown>),
    range: { start: { line: 3, character: 4 }, end: { line: 2, character: 9 } },
  };
  const invalidEventResult = validateEvent(invalidEvent);
  assert.equal(invalidEventResult.ok, false);
  if (!invalidEventResult.ok) assert.match(invalidEventResult.errors.join(";"), /must not precede/);
  const invalidRevision = {
    schemaVersion: "0.2.0",
    id: "revision_1",
    reviewId: "review_test",
    createdAt: "2026-08-13T10:00:00.000Z",
    createdBy: actor,
    rootDocument: "missing.md",
    documents: [{ path: "architecture.md", digest, blobPath: `blobs/sha256/bb/${"b".repeat(64)}`, mediaType: "text/markdown", byteLength: 12 }],
    resources: [], externalReferences: [], mermaidDiagrams: [], diagnostics: [],
    renderer: { markdownProfile: "commonmark-gfm", mermaidVersion: "11.10.1" },
  };
  const result = validateRevision(invalidRevision);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((error) => error.includes("encode its digest")));
    assert.ok(result.errors.some((error) => error.includes("rootDocument")));
  }
});

test("event loader ignores a valid event stored under the wrong filename", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omr-filename-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await initializeReview(root, manifest());
  await writeFile(path.join(root, "events", "wrong-name.json"), `${JSON.stringify(created(), null, 2)}\n`);
  const loaded = await loadEvents(root, "review_test");
  assert.equal(loaded.events.length, 0);
  assert.match(loaded.warnings.join(";"), /filename must be evt_created\.json/);
});

test("new lifecycle events require schema 0.3 and validate their required fields", () => {
  for (const event of [decided(), suggestionCreated(), suggestionAccepted(), suggestionRejected(), suggestionApplied(), reviewRejected()]) {
    assert.equal(validateEvent(event).ok, true, event.type);
  }
  const legacySuggestion = { ...suggestionCreated(), schemaVersion: "0.2.0" };
  const legacyResult = validateEvent(legacySuggestion);
  assert.equal(legacyResult.ok, false);
  if (!legacyResult.ok) assert.ok(legacyResult.errors.some((error) => error.includes("requires schemaVersion 0.3.0")));
  const badRejection = { ...reviewRejected(), reason: "" };
  assert.equal(validateEvent(badRejection).ok, false);
});
