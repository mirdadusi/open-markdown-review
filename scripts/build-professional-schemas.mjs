import { readFile, writeFile, mkdir } from 'node:fs/promises';
import Ajv from 'ajv/dist/2020.js';
import standalone from 'ajv/dist/standalone/index.js';
import addFormats from 'ajv-formats';
const base = new URL('../', import.meta.url);
const read = async name => JSON.parse(await readFile(new URL(`protocol/schemas/${name}.schema.json`, base), 'utf8'));
const [event, manifest, revision] = await Promise.all(['event', 'manifest', 'revision'].map(read));
const str = { type: 'string', minLength: 1 };
const id = { ...str, pattern: '^[A-Za-z0-9_-]{1,128}$' };
const digest = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };
const ids = { type: 'array', uniqueItems: true, maxItems: 10000, items: id };
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const arr = (items, maxItems = 10000) => ({ type: 'array', items, maxItems });
const file = obj({ path: str, digest, byteLength: { type: 'integer', minimum: 0 }, mediaType: str });
const stored = obj({ digest, blobPath: { type: 'string', pattern: '^blobs/sha256/[a-f0-9]{2}/[a-f0-9]{64}$' }, mediaType: str, byteLength: { type: 'integer', minimum: 0 } });
const renderer = obj(Object.fromEntries(['client', 'clientVersion', 'markdownVersion', 'mermaidVersion', 'pdfEngine', 'fontSetDigest', 'sanitizerVersion', 'schemaSetDigest'].map(key => [key, key.endsWith('Digest') ? digest : str])));
for (const [name, schema] of Object.entries({ event, manifest, revision })) {
  schema.$id = `urn:open-markdown-review:schema:${name}:0.5`;
  schema.title = `Open Markdown Review ${name} 0.5`;
  schema.$defs.id = id;
  schema.$defs.actor.properties.id.maxLength = 128;
}
event.$defs.base.properties.schemaVersion = { const: '0.5.0' };
event.$defs.base.properties.revisionDigest = digest;
event.$defs.base.properties.operationId = id;
event.$defs.base.required.push('revisionDigest', 'operationId');
event.$defs.stored = stored;
const variants = event.oneOf.map(item => item.$ref.split('/').at(-1));
for (const name of variants) {
  const detail = event.$defs[name].allOf[1];
  delete detail.properties.schemaVersion;
  let predecessor;
  if (['threadDecided', 'suggestionAccepted', 'suggestionRejected'].includes(name)) predecessor = 'decisionPredecessors';
  if (name === 'threadResolved') predecessor = 'statusPredecessors';
  if (['reviewApproved', 'reviewRejected'].includes(name)) predecessor = 'stancePredecessors';
  if (name === 'suggestionApplied') predecessor = 'acceptanceIds';
  if (predecessor) { detail.properties[predecessor] = ids; (detail.required ??= []).push(predecessor); }
  if (['reviewApproved', 'reviewRejected'].includes(name)) { detail.properties.verification = { $ref: '#/$defs/stored' }; detail.required.push('verification'); }
  if (name === 'suggestionRejected') { detail.properties.reason = str; detail.required.push('reason'); }
}
const variant = (type, properties, required) => ({ type: 'object', allOf: [{ $ref: '#/$defs/base' }, { properties: { type: { const: type }, ...properties }, required }], unevaluatedProperties: false });
event.$defs.threadReopened = variant('thread.reopened', { threadId: id, reason: str, statusPredecessors: { ...ids, minItems: 1 } }, ['threadId', 'reason', 'statusPredecessors']);
event.$defs.reviewWithdrawn = variant('review.withdrawn', { reason: str, stancePredecessors: { ...ids, minItems: 1 }, verification: { $ref: '#/$defs/stored' } }, ['reason', 'stancePredecessors', 'verification']);
event.$defs.exportCreated = variant('export.created', { exportId: id, format: { const: 'application/pdf' }, pdf: file, inventory: file, renderer }, ['exportId', 'format', 'pdf', 'inventory', 'renderer']);
for (const name of ['threadReopened', 'reviewWithdrawn']) event.oneOf.push({ $ref: `#/$defs/${name}` });
event.$defs.base.properties.type.enum.push('thread.reopened', 'review.withdrawn');
Object.assign(manifest.properties, {
  protocolVersion: { const: '0.5.0' }, eventDirectory: { const: 'events' }, revisionDirectory: { const: 'revisions' }, blobDirectory: { const: 'blobs/sha256' }, exportDirectory: { const: 'exports' },
  eventLayout: { const: 'sha256-flat-v1' }, identityProfile: { const: 'self-asserted-v1' }, limitsProfile: { const: 'pilot-v1' }, creationOperationId: id,
  capabilities: { type: 'array', items: str, uniqueItems: true }, requiredCapabilities: { type: 'array', items: str, uniqueItems: true },
  extensions: arr(obj({ id: { type: 'string', format: 'uri' }, schemaUri: { type: 'string', format: 'uri' }, schemaDigest: digest, schemaBlobPath: stored.properties.blobPath, affectsState: { type: 'boolean' } }))
});
manifest.required.push('eventLayout', 'identityProfile', 'limitsProfile', 'creationOperationId', 'requiredCapabilities');
delete manifest.allOf;
Object.assign(revision.properties, { schemaVersion: { const: '0.5.0' }, parents: ids, policy: stored, creationOperationId: id });
revision.properties.renderer.properties.markdownProfile = { enum: ['commonmark-gfm', 'commonmark-gfm+sanitized-html-v1'] };
revision.required.push('parents', 'policy', 'creationOperationId');
revision.$defs.resource.allOf[1].properties.sourceKind.enum.push('granted-root');
revision.properties.documents.maxItems = 100;
revision.properties.resources.maxItems = 1000;
revision.properties.mermaidDiagrams.maxItems = 100;
const policy = { oneOf: [obj({ schemaVersion: { const: '0.5.0' }, kind: { const: 'review-policy' }, mode: { const: 'assertions-only' } }), obj({ schemaVersion: { const: '0.5.0' }, kind: { const: 'review-policy' }, mode: { const: 'quorum-v1' }, eligibleActorIds: { type: 'array', items: str, minItems: 1, uniqueItems: true }, minimumApprovals: { type: 'integer', minimum: 1 }, blockOnRejection: { type: 'boolean' }, requireResolvedThreads: { type: 'boolean' }, requireClosedSuggestions: { type: 'boolean' } })] };
const verificationProperties = { schemaVersion: { const: '0.5.0' }, kind: { const: 'verification-inventory' }, reviewId: id, revisionId: id, verifiedAt: { type: 'string', format: 'date-time' }, manifest: file, revision: file, policy: file, contextRevisions: arr(file, 1000), documents: arr(file), resources: arr(file), events: arr(obj({ ...file.properties, eventId: id, revisionId: id })), policyResult: { enum: ['not-evaluated', 'satisfied', 'unsatisfied', 'conflicted'] } };
const verification = obj(verificationProperties);
const inventory = obj({ ...verificationProperties, kind: { const: 'audit-export-inventory' }, exportId: id, pdf: file, representedEventIds: ids, renderedDiagrams: arr(obj({ diagramId: id, sourceDigest: digest, svg: file }), 100), diagnostics: arr(obj({ code: str, severity: { enum: ['warning', 'error'] }, path: str, message: str }, ['code', 'severity', 'message'])), renderer });
const schemas = { event, manifest, revision, policy, verification, inventory };
const ajv = new Ajv({ strict: true, allErrors: true, code: { source: true } });
addFormats(ajv);
await mkdir(new URL('protocol/schemas/v0.5/', base), { recursive: true });
await mkdir(new URL('src/professional/generated/', base), { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  schema.$schema = 'https://json-schema.org/draft/2020-12/schema';
  schema.$id ??= `urn:open-markdown-review:schema:${name}:0.5`;
  await writeFile(new URL(`protocol/schemas/v0.5/${name}.schema.json`, base), JSON.stringify(schema, null, 2) + '\n');
  const validator = ajv.compile(schema);
  await writeFile(new URL(`src/professional/generated/${name}.js`, base), standalone(ajv, validator));
}
// Optional profiles are independently versioned; they do not extend core events.
const slidevSchema = JSON.parse(await readFile(new URL('protocol/profiles/slidev/v1.schema.json', base), 'utf8'));
await writeFile(new URL('src/professional/generated/slidev.js', base), standalone(ajv, ajv.compile(slidevSchema)));
