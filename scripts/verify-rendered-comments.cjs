const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return { Uri: { file: (value) => value } };
  return originalLoad.call(this, request, parent, isMain);
};

const { buildReviewState } = require(path.resolve("out/src/protocol/state.js"));
const { renderDocument, threadHtml } = require(path.resolve("out/src/renderedView.js"));
const digest = `sha256:${"a".repeat(64)}`;
const actor = { id: "reviewer", displayName: "Reviewer" };
const revisionId = "revision_highlight";
const threadId = "thread_highlight";
const events = [
  { schemaVersion: "0.3.0", id: "evt_revision_highlight", type: "revision.created", reviewId: "review_highlight", revisionId, occurredAt: "2026-08-13T10:00:00Z", actor, revisionPath: "revisions/revision_highlight.json", revisionDigest: digest },
  { schemaVersion: "0.3.0", id: "evt_comment_highlight", type: "comment.created", reviewId: "review_highlight", revisionId, occurredAt: "2026-08-13T10:01:00Z", actor, threadId, commentId: "comment_highlight", anchor: { document: "architecture.md", range: { start: { line: 2, character: 4 }, end: { line: 2, character: 16 } }, quote: { exact: "orchestrator" }, documentDigest: digest, target: { kind: "text" } }, body: { format: "markdown", text: "Clarify ownership." } },
  { schemaVersion: "0.3.0", id: "evt_reply_highlight", type: "comment.replied", reviewId: "review_highlight", revisionId, occurredAt: "2026-08-13T10:02:00Z", actor: { id: "author", displayName: "Author" }, threadId, commentId: "reply_highlight", inReplyTo: "comment_highlight", body: { format: "markdown", text: "Ownership is documented." } },
];
const state = buildReviewState(events);
const revision = { schemaVersion: "0.2.0", id: revisionId, reviewId: "review_highlight", createdAt: "2026-08-13T10:00:00Z", createdBy: actor, rootDocument: "architecture.md", documents: [], resources: [], externalReferences: [], mermaidDiagrams: [], diagnostics: [], renderer: { markdownProfile: "commonmark-gfm", mermaidVersion: "11.10.1" } };
const rendered = renderDocument("# Architecture\n\nThe orchestrator owns state.\n", "architecture.md", revision, state, { asWebviewUri: (value) => value }, "/review");
assert.match(rendered, /class="comment-highlight comment-open"/);
assert.match(rendered, /data-thread-ids="thread_highlight"/);
assert.match(rendered, />orchestrator<span class="comment-glyph"/);
const card = threadHtml(state.threads.get(threadId));
assert.match(card, /id="thread-thread_highlight"/);
assert.match(card, /Clarify ownership\./);
assert.match(card, /Ownership is documented\./);
assert.match(card, /data-command="navigateThread"/);
