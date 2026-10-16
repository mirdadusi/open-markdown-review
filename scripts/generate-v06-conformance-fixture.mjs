import { mkdtemp, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest, encode, jsonBytes, stableId } from '../src/professional/bytes.ts';
import { validate, inspect } from '../src/professional/validation.ts';
import { CAPABILITIES, CREATOR_THREAD_CONTROL, ProtocolError, SANITIZED_HTML_CAPABILITY, SANITIZED_HTML_PROFILE, THREAD_ADDRESSING, VERSION } from '../src/professional/types.ts';
import { ReviewSession } from '../src/professional/session.ts';

const fixedNow = '2026-09-23T08:00:00.000Z';
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [fixedNow])); }
  static now() { return RealDate.parse(fixedNow); }
};

class FixtureStorage {
  identity = 'v0.6-conformance-fixture'; writable = true; files = new Map(); journals = new Map();
  async read(file, limit) { const bytes = this.files.get(file); if (!bytes) throw new ProtocolError('missing', file); if (bytes.length > limit) throw new ProtocolError('unsupported', `limit: ${file}`); return bytes.slice(); }
  async list(directory) { return [...this.files.keys()].filter(file => file.startsWith(`${directory}/`) && !file.slice(directory.length + 1).includes('/')).map(file => file.slice(directory.length + 1)).sort(); }
  async write(file, bytes) { if (this.files.has(file) && digest(this.files.get(file)) !== digest(bytes)) throw new Error(`collision: ${file}`); this.files.set(file, bytes.slice()); }
  async journalGet(operation) { return this.journals.get(operation); }
  async journalPut(operation, entry) { this.journals.set(operation, structuredClone(entry)); }
}

const store = new FixtureStorage();
const creator = { id: 'fixture-creator', displayName: 'Fixture Creator' };
const reviewer = { id: 'fixture-reviewer', displayName: 'Fixture Reviewer' };
const auditor = { id: 'fixture-auditor', displayName: 'Fixture Auditor' };
const capabilities = [...CAPABILITIES, CREATOR_THREAD_CONTROL, THREAD_ADDRESSING, SANITIZED_HTML_CAPABILITY];
const manifest = validate('manifest', {
  protocol: 'open-markdown-review', protocolVersion: VERSION, reviewId: 'review_v06_conformance', title: 'Protocol 0.6 conformance fixture',
  createdAt: fixedNow, createdBy: creator, documents: ['architecture.md'], eventDirectory: 'events', revisionDirectory: 'revisions',
  blobDirectory: 'blobs/sha256', exportDirectory: 'exports', eventLayout: 'sha256-flat-v1', identityProfile: 'self-asserted-v1', limitsProfile: 'pilot-v1',
  creationOperationId: 'fixture_create', capabilities, requiredCapabilities: capabilities
});
store.files.set('manifest.json', jsonBytes(manifest));

const stored = (bytes, mediaType) => {
  const hash = digest(bytes), blobPath = `blobs/sha256/${hash.slice(7, 9)}/${hash.slice(7)}`;
  store.files.set(blobPath, bytes); return { digest: hash, blobPath, mediaType, byteLength: bytes.length };
};
const imageReference = 'assets/system.svg';
const imageBytes = encode('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="90"><rect width="320" height="90" fill="#2458a6"/><text x="16" y="52" fill="white">Frozen system boundary</text></svg>');
const initialSource = `# Architecture

The service stores temporary state.

![System boundary](${imageReference})

\`\`\`mermaid
flowchart LR
  Author --> Review
\`\`\`

| Component | Responsibility |
| --- | --- |
| Review package | Immutable evidence |

[External evidence](https://example.com/evidence) · [Owner](mailto:owner@example.com) · [Author file](file:///private/evidence.pdf)
`;
const revisedSource = initialSource.replace('temporary state', 'durable state');
const policy = stored(jsonBytes(validate('policy', { schemaVersion: VERSION, kind: 'review-policy', mode: 'assertions-only' })), 'application/json');
const resource = { id: stableId('resource', `architecture.md\0${imageReference}`), document: 'architecture.md', originalReference: imageReference, sourceKind: 'workspace', role: 'image', alt: 'System boundary', capturedAt: fixedNow, ...stored(imageBytes, 'image/svg+xml') };
const descriptor = (id, source, parents, createdAt, operation) => {
  const parsed = inspect(source, 'architecture.md', SANITIZED_HTML_PROFILE);
  return validate('revision', {
    schemaVersion: VERSION, id, reviewId: manifest.reviewId, createdAt, createdBy: creator, rootDocument: 'architecture.md',
    documents: [{ path: 'architecture.md', ...stored(encode(source), 'text/markdown') }], resources: [resource],
    externalReferences: parsed.links.map(link => ({ ...link, document: 'architecture.md', relation: 'link' })), mermaidDiagrams: parsed.diagrams,
    diagnostics: [], renderer: { markdownProfile: SANITIZED_HTML_PROFILE, mermaidVersion: '11.10.1' }, parents, policy, creationOperationId: operation
  });
};
const first = descriptor('revision_fixture_initial', initialSource, [], fixedNow, 'fixture_revision_initial');
const second = descriptor('revision_fixture_addressed', revisedSource, [first.id], '2026-09-23T08:10:00.000Z', 'fixture_revision_addressed');
store.files.set(`revisions/${first.id}.json`, jsonBytes(first));

const envelope = (id, type, revision, actor, occurredAt, operationId, payload = {}) => validate('event', {
  schemaVersion: VERSION, id, type, reviewId: manifest.reviewId, revisionId: revision.id, revisionDigest: digest(jsonBytes(revision)), occurredAt, actor, operationId, ...payload
});
const initialPublication = envelope('event_revision_initial', 'revision.created', first, creator, fixedNow, 'fixture_publish_initial', { revisionPath: `revisions/${first.id}.json` });
store.files.set(`events/${digest(jsonBytes(initialPublication)).slice(7)}.json`, jsonBytes(initialPublication));

const session = new ReviewSession(store); await session.open();
const context = actor => session.context(actor);
const save = async (actor, event) => session.save(context(actor), event);
const anchor = { document: 'architecture.md', documentDigest: first.documents[0].digest, range: { start: { line: 2, character: 19 }, end: { line: 2, character: 28 } }, quote: { exact: 'temporary', prefix: 'The service stores ', suffix: ' state.' }, target: { kind: 'text' } };
const comment = envelope('event_comment', 'comment.created', first, reviewer, '2026-09-23T08:01:00.000Z', 'fixture_comment', { threadId: 'thread_state_durability', commentId: 'comment_state_durability', anchor, body: { format: 'markdown', text: 'Should this state survive a process restart?' } });
await save(reviewer, comment);
const reply = envelope('event_reply', 'comment.replied', first, creator, '2026-09-23T08:02:00.000Z', 'fixture_reply', { threadId: comment.threadId, commentId: 'reply_state_durability', inReplyTo: comment.commentId, body: { format: 'markdown', text: 'Yes. The revised wording will make that requirement explicit.' } });
await save(creator, reply);
const decision = envelope('event_decision', 'thread.decided', first, creator, '2026-09-23T08:03:00.000Z', 'fixture_decision', { threadId: comment.threadId, decision: 'accepted', reason: 'The persistence requirement must be explicit.', decisionPredecessors: [] });
await save(creator, decision);
const suggestion = envelope('event_suggestion', 'suggestion.created', first, reviewer, '2026-09-23T08:04:00.000Z', 'fixture_suggestion', { suggestionId: 'suggestion_durable', anchor, operation: { kind: 'replace', replacement: 'durable' }, rationale: { format: 'markdown', text: 'Use wording that states the persistence expectation.' } });
await save(reviewer, suggestion);
const suggestionAccepted = envelope('event_suggestion_accepted', 'suggestion.accepted', first, creator, '2026-09-23T08:05:00.000Z', 'fixture_suggestion_accepted', { suggestionId: suggestion.suggestionId, note: 'Accepted for the next revision.', decisionPredecessors: [] });
await save(creator, suggestionAccepted);

store.files.set(`revisions/${second.id}.json`, jsonBytes(second));
const secondPublication = envelope('event_revision_addressed', 'revision.created', second, creator, second.createdAt, 'fixture_publish_addressed', { revisionPath: `revisions/${second.id}.json` });
store.files.set(`events/${digest(jsonBytes(secondPublication)).slice(7)}.json`, jsonBytes(secondPublication));
await session.refresh();
const addressed = envelope('event_addressed', 'thread.addressed', first, creator, '2026-09-23T08:11:00.000Z', 'fixture_addressed', { threadId: comment.threadId, toRevisionId: second.id, document: 'architecture.md', sourceDigestBefore: first.documents[0].digest, sourceDigestAfter: second.documents[0].digest, summary: 'Changed temporary state to durable state in the published descendant revision.', decisionIds: [decision.id], addressingPredecessors: [] });
await save(creator, addressed);
const verified = envelope('event_verified', 'thread.verification.recorded', first, reviewer, '2026-09-23T08:12:00.000Z', 'fixture_verified', { threadId: comment.threadId, addressedEventId: addressed.id, verdict: 'verified', note: 'The published revision states the persistence requirement.', verificationPredecessors: [] });
await save(reviewer, verified);
const applied = envelope('event_suggestion_applied', 'suggestion.applied', first, creator, '2026-09-23T08:13:00.000Z', 'fixture_suggestion_applied', { suggestionId: suggestion.suggestionId, document: 'architecture.md', sourceDigestBefore: first.documents[0].digest, sourceDigestAfter: second.documents[0].digest, acceptanceIds: [suggestionAccepted.id] });
await save(creator, applied);
const resolved = envelope('event_resolved', 'thread.resolved', first, creator, '2026-09-23T08:14:00.000Z', 'fixture_resolved', { threadId: comment.threadId, note: 'Implemented and independently verified.', statusPredecessors: [] });
await save(creator, resolved);

const approveAudit = await session.audit(context(reviewer));
const approvalVerification = await session.verificationBlob(approveAudit, 'fixture_approval_receipt');
const approved = envelope('event_approved', 'review.approved', first, reviewer, '2026-09-23T08:15:00.000Z', 'fixture_approved', { note: 'Approved after verifying the addressed finding.', stancePredecessors: [], verification: approvalVerification });
await save(reviewer, approved);
const rejectAudit = await session.audit(context(auditor));
const rejectionVerification = await session.verificationBlob(rejectAudit, 'fixture_rejection_receipt');
const rejected = envelope('event_rejected', 'review.rejected', first, auditor, '2026-09-23T08:16:00.000Z', 'fixture_rejected', { reason: 'Temporary audit stance used to exercise withdrawal.', stancePredecessors: [], verification: rejectionVerification });
await save(auditor, rejected);
const withdrawAudit = await session.audit(context(auditor));
const withdrawalVerification = await session.verificationBlob(withdrawAudit, 'fixture_withdrawal_receipt');
const withdrawn = envelope('event_withdrawn', 'review.withdrawn', first, auditor, '2026-09-23T08:17:00.000Z', 'fixture_withdrawn', { reason: 'Concern cleared by the published evidence.', stancePredecessors: [rejected.id], verification: withdrawalVerification });
await save(auditor, withdrawn);
await session.audit(context(reviewer));

const parent = new URL('../protocol/fixtures/v0.6/', import.meta.url), target = new URL('conformant-core/', parent);
try { await stat(target); throw new Error(`Refusing to overwrite existing fixture: ${target.pathname}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const staging = await mkdtemp(path.join(os.tmpdir(), 'omr-v06-fixture-'));
for (const [relative, bytes] of [...store.files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  const file = path.join(staging, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
}
await mkdir(new URL('.', parent), { recursive: true });
await rename(staging, target);
console.log(`Generated ${store.files.size} immutable files in ${target.pathname}`);
