import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent } from "../out/src/protocol/store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "protocol", "examples");
const reviewRoot = path.join(root, ".review");
const manifest = JSON.parse(await readFile(path.join(reviewRoot, "manifest.json"), "utf8"));
const revisionName = (await readdir(path.join(reviewRoot, "revisions"))).find((name) => name.endsWith(".json"));
const revision = JSON.parse(await readFile(path.join(reviewRoot, "revisions", revisionName), "utf8"));
const document = revision.documents.find((item) => item.path === "architecture.md");
const actor = { id: "mirek", displayName: "Mirek" };
const base = {
  schemaVersion: "0.2.0",
  reviewId: manifest.reviewId,
  revisionId: revision.id,
  actor,
};

for (const event of [
  {
    ...base,
    id: "evt_example_comment_created",
    type: "comment.created",
    occurredAt: "2026-08-13T13:01:00.000Z",
    threadId: "thread_global_state",
    commentId: "comment_global_state_root",
    anchor: {
      document: "architecture.md",
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 39 } },
      quote: { exact: "The orchestrator owns the global state.", prefix: "# Architecture\n\n", suffix: "\n\nWorker agents" },
      documentDigest: document.digest,
      target: { kind: "text" },
    },
    body: { format: "markdown", text: "Should this ownership live in the runtime layer?" },
  },
  {
    ...base,
    id: "evt_example_comment_replied",
    type: "comment.replied",
    occurredAt: "2026-08-13T13:02:00.000Z",
    threadId: "thread_global_state",
    commentId: "comment_global_state_reply",
    inReplyTo: "comment_global_state_root",
    body: { format: "markdown", text: "Yes. The next revision will clarify that boundary." },
  },
  {
    ...base,
    id: "evt_example_thread_resolved",
    type: "thread.resolved",
    occurredAt: "2026-08-13T13:03:00.000Z",
    threadId: "thread_global_state",
    note: "Clarification accepted for the pilot example.",
  },
  {
    ...base,
    id: "evt_example_review_approved",
    type: "review.approved",
    occurredAt: "2026-08-13T13:04:00.000Z",
    note: "Approved for protocol demonstration.",
  },
]) {
  await appendEvent(reviewRoot, event);
}
