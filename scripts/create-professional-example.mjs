import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { authorReview, installClient } = require('../out/src/professional/authoring.js');
const { NativeStorage } = require('../out/src/professional/nativeStorage.js');
const { ReviewSession } = require('../out/src/professional/session.js');
const root = path.resolve('examples/professional/review'), actor = { id: 'example-author', displayName: 'Example author' };
let existing = false;
try { await access(path.join(root, 'manifest.json')); existing = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
const created = existing ? { outcome: 'completed', browserClientPath: await installClient(new NativeStorage(root, path.join(os.tmpdir(), 'omr-example-authoring')), path.resolve('dist/OpenMarkdownReview.html')) } : await authorReview({ source: path.resolve('examples/professional/source'), store: root, rootDocument: 'architecture.md', actor, operationId: 'professional_example_v1', clientArtifact: path.resolve('dist/OpenMarkdownReview.html'), journalRoot: path.join(os.tmpdir(), 'omr-example-authoring'), resume: true });
if (created.outcome !== 'completed') throw new Error(JSON.stringify(created));
const session = new ReviewSession(new NativeStorage(root, path.join(os.tmpdir(), 'omr-example-events'))); await session.open();
const context = session.context(actor);
const save = async (operation, payload) => { const existing = session.events.find(e => e.actor.id === actor.id && e.operationId === operation); if (existing) return existing; const event = session.makeEvent(context, payload, operation); await session.save(context, event); return event; };
const document = context.revision.documents.find(d => d.path === 'architecture.md');
const anchor = { document: document.path, documentDigest: document.digest, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 10 } }, quote: { exact: 'The author' }, target: { kind: 'text' } };
await save('example_comment', { type: 'comment.created', threadId: 'example_thread', commentId: 'example_comment', anchor, body: { format: 'markdown', text: 'Can we make author responsibility explicit?' } });
await save('example_reply', { type: 'comment.replied', threadId: 'example_thread', commentId: 'example_reply', inReplyTo: 'example_comment', body: { format: 'markdown', text: 'Yes. Authoring is available in VS Code and from the CLI.' } });
await save('example_decide', { type: 'thread.decided', threadId: 'example_thread', decision: 'accepted', reason: 'Useful clarification.', decisionPredecessors: [] });
await save('example_resolve', { type: 'thread.resolved', threadId: 'example_thread', note: 'Clarified in the review response.', statusPredecessors: [] });
await save('example_suggestion', { type: 'suggestion.created', suggestionId: 'example_suggestion', anchor, operation: { kind: 'replace', replacement: 'The document author' }, rationale: { format: 'markdown', text: 'More precise ownership.' } });
await save('example_accept_edit', { type: 'suggestion.accepted', suggestionId: 'example_suggestion', note: 'Accepted, not applied to source.', decisionPredecessors: [] });
if (!session.events.some(e => e.operationId === 'example_approve')) { const audit = await session.audit(context), verification = await session.verificationBlob(audit, 'example_approve'); await save('example_approve', { type: 'review.approved', verification, stancePredecessors: [], note: 'Example assertion; accepted edit is intentionally still unapplied.' }); }
console.log(`Example ready: ${created.browserClientPath}\n${session.events.length} independent events; exact descriptor evidence is in the revision publication.`);
