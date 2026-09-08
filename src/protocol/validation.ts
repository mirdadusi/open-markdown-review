import { createHash } from "node:crypto";
import {
  EVENT_SCHEMA_VERSION,
  EventType,
  LEGACY_EVENT_SCHEMA_VERSION,
  LEGACY_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION_03,
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  REVISION_SCHEMA_VERSION,
  ReviewEvent,
  ReviewManifest,
  ReviewRevision,
  RevisionCreatedEvent,
} from "./types";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

const EVENT_TYPES: ReadonlySet<EventType> = new Set([
  "revision.created",
  "comment.created",
  "comment.replied",
  "thread.resolved",
  "thread.decided",
  "review.approved",
  "review.rejected",
  "suggestion.created",
  "suggestion.accepted",
  "suggestion.rejected",
  "suggestion.applied",
  "export.created",
]);

const V03_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  "thread.decided",
  "review.rejected",
  "suggestion.created",
  "suggestion.accepted",
  "suggestion.rejected",
  "suggestion.applied",
]);

const CAPABILITIES = new Set([
  "quote-anchor-v1",
  "range-anchor-v1",
  "semantic-anchor-v1",
  "content-addressed-resources-v1",
  "audit-export-v1",
  "thread-decision-v1",
  "suggested-edit-v1",
  "review-rejection-v1",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}

function validTimestamp(value: unknown): value is string {
  return nonEmptyString(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value));
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function safeRelativePath(value: unknown): value is string {
  return (
    nonEmptyString(value) &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function validateActor(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!nonEmptyString(value.id)) errors.push(`${path}.id must be a non-empty string`);
  if (value.displayName !== undefined && !nonEmptyString(value.displayName)) {
    errors.push(`${path}.displayName must be a non-empty string when present`);
  }
}

function validateBody(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("body must be an object");
    return;
  }
  if (value.format !== "markdown") errors.push('body.format must be "markdown"');
  if (!nonEmptyString(value.text)) errors.push("body.text must be a non-empty string");
}

function validatePosition(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!Number.isInteger(value.line) || (value.line as number) < 0) {
    errors.push(`${path}.line must be a non-negative integer`);
  }
  if (!Number.isInteger(value.character) || (value.character as number) < 0) {
    errors.push(`${path}.character must be a non-negative integer`);
  }
}

function validateTarget(value: unknown, errors: string[]): void {
  if (!isRecord(value) || !nonEmptyString(value.kind)) {
    errors.push("anchor.target must be an object with a kind");
    return;
  }
  switch (value.kind) {
    case "text":
      break;
    case "image":
      if (!nonEmptyString(value.resourceId)) errors.push("image target requires resourceId");
      break;
    case "mermaid":
      if (!nonEmptyString(value.diagramId)) errors.push("mermaid target requires diagramId");
      break;
    case "table":
      if (typeof value.tableId !== "string" || !/^table_[a-f0-9]{24}$/.test(value.tableId)) errors.push("table target requires a table-v1 id");
      break;
    case "table-cell":
      if (typeof value.tableId !== "string" || !/^table_[a-f0-9]{24}$/.test(value.tableId)) errors.push("table-cell target requires a table-v1 id");
      if (!Number.isInteger(value.row) || (value.row as number) < 0) errors.push("table-cell row is invalid");
      if (!Number.isInteger(value.column) || (value.column as number) < 0) errors.push("table-cell column is invalid");
      break;
    default:
      errors.push("anchor.target.kind is not supported");
  }
}

function validateAnchor(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("anchor must be an object");
    return;
  }
  if (!safeRelativePath(value.document)) errors.push("anchor.document must be a safe workspace-relative path");
  if (!isRecord(value.range)) {
    errors.push("anchor.range must be an object");
  } else {
    validatePosition(value.range.start, "anchor.range.start", errors);
    validatePosition(value.range.end, "anchor.range.end", errors);
    if (isRecord(value.range.start) && isRecord(value.range.end)) {
      const startLine = Number(value.range.start.line);
      const startCharacter = Number(value.range.start.character);
      const endLine = Number(value.range.end.line);
      const endCharacter = Number(value.range.end.character);
      if (Number.isInteger(startLine) && Number.isInteger(startCharacter) && Number.isInteger(endLine) && Number.isInteger(endCharacter)
        && (endLine < startLine || (endLine === startLine && endCharacter < startCharacter))) {
        errors.push("anchor.range.end must not precede anchor.range.start");
      }
    }
  }
  if (!isRecord(value.quote)) {
    errors.push("anchor.quote must be an object");
  } else {
    if (!nonEmptyString(value.quote.exact)) errors.push("anchor.quote.exact must be non-empty");
    for (const key of ["prefix", "suffix"] as const) {
      if (value.quote[key] !== undefined && typeof value.quote[key] !== "string") {
        errors.push(`anchor.quote.${key} must be a string when present`);
      }
    }
  }
  if (!validDigest(value.documentDigest)) errors.push("anchor.documentDigest must be a sha256 digest");
  if (value.target !== undefined) validateTarget(value.target, errors);
}

function validateStoredContent(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!validDigest(value.digest)) errors.push(`${path}.digest must be a sha256 digest`);
  const blobMatch = /^(?:\.review\/)?blobs\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(String(value.blobPath));
  if (!safeRelativePath(value.blobPath) || !blobMatch) {
    errors.push(`${path}.blobPath must be inside blobs/sha256`);
  } else if (validDigest(value.digest)) {
    const hash = value.digest.slice("sha256:".length);
    if (blobMatch[1] !== hash.slice(0, 2) || blobMatch[2] !== hash) {
      errors.push(`${path}.blobPath must encode its digest`);
    }
  }
  if (!nonEmptyString(value.mediaType)) errors.push(`${path}.mediaType is required`);
  if (!Number.isInteger(value.byteLength) || (value.byteLength as number) < 0) {
    errors.push(`${path}.byteLength must be a non-negative integer`);
  }
}

export function validateManifest(value: unknown): ValidationResult<ReviewManifest> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["manifest must be an object"] };
  if (value.protocol !== PROTOCOL_ID) errors.push(`protocol must be ${PROTOCOL_ID}`);
  if (value.protocolVersion !== PROTOCOL_VERSION && value.protocolVersion !== LEGACY_PROTOCOL_VERSION_03 && value.protocolVersion !== LEGACY_PROTOCOL_VERSION) {
    errors.push(`protocolVersion must be ${PROTOCOL_VERSION}, ${LEGACY_PROTOCOL_VERSION_03}, or ${LEGACY_PROTOCOL_VERSION}`);
  }
  if (!validId(value.reviewId)) errors.push("reviewId must use only letters, digits, underscore, or hyphen");
  if (!nonEmptyString(value.title)) errors.push("title must be a non-empty string");
  if (!validTimestamp(value.createdAt)) errors.push("createdAt must be an ISO timestamp");
  validateActor(value.createdBy, "createdBy", errors);
  if (!Array.isArray(value.documents) || !value.documents.length || value.documents.some((v) => !nonEmptyString(v))) {
    errors.push("documents must contain at least one non-empty glob");
  } else if (new Set(value.documents).size !== value.documents.length) {
    errors.push("documents must not contain duplicates");
  }
  const portablePaths: Record<string, string> = {
    eventDirectory: "events",
    revisionDirectory: "revisions",
    blobDirectory: "blobs/sha256",
    exportDirectory: "exports",
  };
  const legacy = value.protocolVersion !== PROTOCOL_VERSION;
  for (const [key, portable] of Object.entries(portablePaths)) {
    const expected = legacy ? `.review/${portable}` : portable;
    if (value[key] !== expected) errors.push(`${key} must be ${expected} for protocol ${String(value.protocolVersion)}`);
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.some((v) => !CAPABILITIES.has(String(v)))) {
    errors.push("capabilities contains an unsupported value");
  } else if (new Set(value.capabilities).size !== value.capabilities.length) {
    errors.push("capabilities must not contain duplicates");
  } else if (value.protocolVersion === PROTOCOL_VERSION) {
    for (const required of ["quote-anchor-v1", "range-anchor-v1", "content-addressed-resources-v1"]) {
      if (!value.capabilities.includes(required)) errors.push(`protocol 0.4 requires capability ${required}`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: value as unknown as ReviewManifest };
}

export function validateRevision(value: unknown): ValidationResult<ReviewRevision> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["revision must be an object"] };
  if (value.schemaVersion !== REVISION_SCHEMA_VERSION) errors.push(`schemaVersion must be ${REVISION_SCHEMA_VERSION}`);
  if (!validId(value.id)) errors.push("id must be filename-safe");
  if (!validId(value.reviewId)) errors.push("reviewId must be filename-safe");
  if (!validTimestamp(value.createdAt)) errors.push("createdAt must be an ISO timestamp");
  validateActor(value.createdBy, "createdBy", errors);
  if (!safeRelativePath(value.rootDocument)) errors.push("rootDocument must be a safe relative path");
  if (!Array.isArray(value.documents) || !value.documents.length) {
    errors.push("documents must not be empty");
  } else {
    value.documents.forEach((document, index) => {
      validateStoredContent(document, `documents[${index}]`, errors);
      if (!isRecord(document) || !safeRelativePath(document.path)) errors.push(`documents[${index}].path is invalid`);
      if (isRecord(document) && document.mediaType !== "text/markdown") errors.push(`documents[${index}].mediaType must be text/markdown`);
    });
    const documentPaths = value.documents.filter(isRecord).map((document) => String(document.path));
    if (new Set(documentPaths).size !== documentPaths.length) errors.push("document paths must be unique");
    if (safeRelativePath(value.rootDocument) && !documentPaths.includes(value.rootDocument)) errors.push("rootDocument must be present in documents");
  }
  const documentPaths = new Set(Array.isArray(value.documents) ? value.documents.filter(isRecord).map((document) => String(document.path)) : []);
  if (!Array.isArray(value.resources)) {
    errors.push("resources must be an array");
  } else {
    value.resources.forEach((resource, index) => {
      validateStoredContent(resource, `resources[${index}]`, errors);
      if (!isRecord(resource)) return;
      if (!validId(resource.id)) errors.push(`resources[${index}].id must be filename-safe`);
      if (!safeRelativePath(resource.document) || !documentPaths.has(String(resource.document))) errors.push(`resources[${index}].document must identify a revision document`);
      if (!nonEmptyString(resource.originalReference)) errors.push(`resources[${index}].originalReference is required`);
      if (!['workspace', 'remote', 'data'].includes(String(resource.sourceKind))) errors.push(`resources[${index}].sourceKind is invalid`);
      if (!['image', 'attachment'].includes(String(resource.role))) errors.push(`resources[${index}].role is invalid`);
      if (!validTimestamp(resource.capturedAt)) errors.push(`resources[${index}].capturedAt must be an ISO timestamp`);
      if (resource.alt !== undefined && typeof resource.alt !== "string") errors.push(`resources[${index}].alt must be a string`);
      if (resource.role === "image" && nonEmptyString(resource.mediaType) && !resource.mediaType.startsWith("image/")) errors.push(`resources[${index}] image mediaType must start with image/`);
    });
    const ids = value.resources.filter(isRecord).map((resource) => String(resource.id));
    if (new Set(ids).size !== ids.length) errors.push("resource ids must be unique");
  }
  if (!Array.isArray(value.externalReferences)) errors.push("externalReferences must be an array");
  else {
    for (const [index, reference] of value.externalReferences.entries()) {
      if (!isRecord(reference)) { errors.push(`externalReferences[${index}] must be an object`); continue; }
      if (!validId(reference.id)) errors.push(`externalReferences[${index}].id must be filename-safe`);
      if (!safeRelativePath(reference.document) || !documentPaths.has(String(reference.document))) errors.push(`externalReferences[${index}].document must identify a revision document`);
      try { new URL(String(reference.uri)); } catch { errors.push(`externalReferences[${index}].uri must be absolute`); }
      if (reference.relation !== "link") errors.push(`externalReferences[${index}].relation must be link`);
    }
    const ids = value.externalReferences.filter(isRecord).map((reference) => String(reference.id));
    if (new Set(ids).size !== ids.length) errors.push("external reference ids must be unique");
  }
  if (!Array.isArray(value.mermaidDiagrams)) errors.push("mermaidDiagrams must be an array");
  else {
    const ordinals = new Map<string, number[]>();
    for (const [index, diagram] of value.mermaidDiagrams.entries()) {
      if (!isRecord(diagram)) { errors.push(`mermaidDiagrams[${index}] must be an object`); continue; }
      if (!validId(diagram.id)) errors.push(`mermaidDiagrams[${index}].id must be filename-safe`);
      if (!safeRelativePath(diagram.document) || !documentPaths.has(String(diagram.document))) errors.push(`mermaidDiagrams[${index}].document must identify a revision document`);
      if (!Number.isInteger(diagram.ordinal) || Number(diagram.ordinal) < 0) errors.push(`mermaidDiagrams[${index}].ordinal is invalid`);
      if (!nonEmptyString(diagram.source)) errors.push(`mermaidDiagrams[${index}].source is required`);
      if (!validDigest(diagram.sourceDigest)) errors.push(`mermaidDiagrams[${index}].sourceDigest is invalid`);
      else if (typeof diagram.source === "string" && `sha256:${createHash("sha256").update(diagram.source).digest("hex")}` !== diagram.sourceDigest) errors.push(`mermaidDiagrams[${index}].sourceDigest does not match source`);
      const list = ordinals.get(String(diagram.document)) ?? [];
      list.push(Number(diagram.ordinal));
      ordinals.set(String(diagram.document), list);
    }
    const ids = value.mermaidDiagrams.filter(isRecord).map((diagram) => String(diagram.id));
    if (new Set(ids).size !== ids.length) errors.push("Mermaid diagram ids must be unique");
    for (const [document, list] of ordinals) {
      const sorted = [...list].sort((a, b) => a - b);
      if (sorted.some((ordinal, index) => ordinal !== index)) errors.push(`Mermaid ordinals for ${document} must be contiguous from zero`);
    }
  }
  if (!Array.isArray(value.diagnostics)) errors.push("diagnostics must be an array");
  else value.diagnostics.forEach((diagnostic, index) => {
    if (!isRecord(diagnostic)) { errors.push(`diagnostics[${index}] must be an object`); return; }
    if (!['warning', 'error'].includes(String(diagnostic.severity))) errors.push(`diagnostics[${index}].severity is invalid`);
    if (!nonEmptyString(diagnostic.code)) errors.push(`diagnostics[${index}].code is required`);
    if (!nonEmptyString(diagnostic.message)) errors.push(`diagnostics[${index}].message is required`);
    if (diagnostic.document !== undefined && (!safeRelativePath(diagnostic.document) || !documentPaths.has(String(diagnostic.document)))) errors.push(`diagnostics[${index}].document must identify a revision document`);
  });
  if (!isRecord(value.renderer) || value.renderer.markdownProfile !== "commonmark-gfm" || !nonEmptyString(value.renderer.mermaidVersion)) {
    errors.push("renderer metadata is invalid");
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: value as unknown as ReviewRevision };
}

export function validateEvent(value: unknown): ValidationResult<ReviewEvent> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["event must be an object"] };
  if (value.schemaVersion !== EVENT_SCHEMA_VERSION && value.schemaVersion !== LEGACY_EVENT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${EVENT_SCHEMA_VERSION} or ${LEGACY_EVENT_SCHEMA_VERSION}`);
  }
  if (!validId(value.id)) errors.push("id must be filename-safe");
  if (!validId(value.reviewId)) errors.push("reviewId must be filename-safe");
  if (!validTimestamp(value.occurredAt)) errors.push("occurredAt must be an ISO timestamp");
  validateActor(value.actor, "actor", errors);
  if (!nonEmptyString(value.type) || !EVENT_TYPES.has(value.type as EventType)) {
    return { ok: false, errors: [...errors, "type is not supported"] };
  }
  if (V03_EVENT_TYPES.has(value.type as EventType) && value.schemaVersion !== EVENT_SCHEMA_VERSION) {
    errors.push(`${value.type} requires schemaVersion ${EVENT_SCHEMA_VERSION}`);
  }
  if (!validId(value.revisionId)) errors.push("revisionId must be filename-safe");

  switch (value.type) {
    case "revision.created":
      if (!safeRelativePath(value.revisionPath) || !/^(?:\.review\/)?revisions\//.test(String(value.revisionPath))) {
        errors.push("revisionPath must be inside revisions");
      }
      if (!validDigest(value.revisionDigest)) errors.push("revisionDigest must be a sha256 digest");
      break;
    case "comment.created":
      if (!validId(value.threadId)) errors.push("threadId must be filename-safe");
      if (!validId(value.commentId)) errors.push("commentId must be filename-safe");
      validateAnchor(value.anchor, errors);
      validateBody(value.body, errors);
      break;
    case "comment.replied":
      if (!validId(value.threadId)) errors.push("threadId must be filename-safe");
      if (!validId(value.commentId)) errors.push("commentId must be filename-safe");
      if (value.inReplyTo !== undefined && !validId(value.inReplyTo)) errors.push("inReplyTo is invalid");
      validateBody(value.body, errors);
      break;
    case "thread.resolved":
      if (!validId(value.threadId)) errors.push("threadId must be filename-safe");
      if (value.note !== undefined && typeof value.note !== "string") errors.push("note must be a string");
      break;
    case "thread.decided":
      if (!validId(value.threadId)) errors.push("threadId must be filename-safe");
      if (!["accepted", "rejected", "wont-fix", "duplicate"].includes(String(value.decision))) {
        errors.push("decision is not supported");
      }
      if (value.reason !== undefined && typeof value.reason !== "string") errors.push("reason must be a string");
      break;
    case "review.approved":
      if (value.note !== undefined && typeof value.note !== "string") errors.push("note must be a string");
      break;
    case "review.rejected":
      if (!nonEmptyString(value.reason)) errors.push("reason must be a non-empty string");
      break;
    case "suggestion.created":
      if (!validId(value.suggestionId)) errors.push("suggestionId must be filename-safe");
      validateAnchor(value.anchor, errors);
      if (isRecord(value.anchor) && isRecord(value.anchor.target) && value.anchor.target.kind !== "text") {
        errors.push("suggestion anchor target must be text");
      }
      if (!isRecord(value.operation)) {
        errors.push("operation must be an object");
      } else if (value.operation.kind === "delete") {
        // No additional data is needed for deletion; the anchor is the deleted text.
      } else if (value.operation.kind === "replace") {
        if (!nonEmptyString(value.operation.replacement)) errors.push("replace operation requires replacement");
      } else if (value.operation.kind === "insert") {
        if (!nonEmptyString(value.operation.replacement)) errors.push("insert operation requires replacement");
        if (value.operation.position !== "before" && value.operation.position !== "after") errors.push("insert position is invalid");
      } else {
        errors.push("suggestion operation kind is not supported");
      }
      validateBody(value.rationale, errors);
      break;
    case "suggestion.accepted":
      if (!validId(value.suggestionId)) errors.push("suggestionId must be filename-safe");
      if (value.note !== undefined && typeof value.note !== "string") errors.push("note must be a string");
      break;
    case "suggestion.rejected":
      if (!validId(value.suggestionId)) errors.push("suggestionId must be filename-safe");
      if (value.reason !== undefined && typeof value.reason !== "string") errors.push("reason must be a string");
      break;
    case "suggestion.applied":
      if (!validId(value.suggestionId)) errors.push("suggestionId must be filename-safe");
      if (!safeRelativePath(value.document)) errors.push("document must be a safe workspace-relative path");
      if (!validDigest(value.sourceDigestBefore)) errors.push("sourceDigestBefore must be a sha256 digest");
      if (!validDigest(value.sourceDigestAfter)) errors.push("sourceDigestAfter must be a sha256 digest");
      break;
    case "export.created":
      if (!validId(value.exportId)) errors.push("exportId must be filename-safe");
      if (value.format !== "application/pdf") errors.push("format must be application/pdf");
      if (!safeRelativePath(value.exportPath) || !/^(?:\.review\/)?exports\//.test(String(value.exportPath))) {
        errors.push("exportPath must be inside exports");
      }
      if (!validDigest(value.exportDigest)) errors.push("exportDigest must be a sha256 digest");
      if (!Array.isArray(value.includedEventIds) || value.includedEventIds.some((id) => !validId(id))) errors.push("includedEventIds must contain filename-safe ids");
      else if (new Set(value.includedEventIds).size !== value.includedEventIds.length) errors.push("includedEventIds must be unique");
      if (!isRecord(value.renderer) || !nonEmptyString(value.renderer.client) || !nonEmptyString(value.renderer.clientVersion) || !nonEmptyString(value.renderer.pdfEngine) || !nonEmptyString(value.renderer.mermaidVersion)) errors.push("renderer metadata is invalid");
      if (!isRecord(value.renderedDiagramDigests) || Object.values(value.renderedDiagramDigests).some((digest) => !validDigest(digest))) errors.push("renderedDiagramDigests must map diagram ids to sha256 digests");
      break;
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: value as unknown as ReviewEvent };
}

/** Validates invariants that cross the manifest, publication event, and revision descriptor. */
export function validatePublishedRevision(
  manifest: ReviewManifest,
  event: RevisionCreatedEvent,
  revision: ReviewRevision,
): string[] {
  const errors: string[] = [];
  if (event.reviewId !== manifest.reviewId) errors.push("revision.created reviewId does not match manifest");
  if (revision.reviewId !== manifest.reviewId) errors.push("revision reviewId does not match manifest");
  if (event.revisionId !== revision.id) errors.push("revision.created revisionId does not match revision id");
  const expectedPath = `${manifest.revisionDirectory}/${revision.id}.json`;
  if (event.revisionPath !== expectedPath) errors.push(`revisionPath must be ${expectedPath}`);
  return errors;
}

/** Enforces manifest capability negotiation for optional event families. */
export function validateEventCapabilities(manifest: ReviewManifest, event: ReviewEvent): string[] {
  const required: Partial<Record<EventType, ReviewManifest["capabilities"][number]>> = {
    "thread.decided": "thread-decision-v1",
    "review.rejected": "review-rejection-v1",
    "suggestion.created": "suggested-edit-v1",
    "suggestion.accepted": "suggested-edit-v1",
    "suggestion.rejected": "suggested-edit-v1",
    "suggestion.applied": "suggested-edit-v1",
    "export.created": "audit-export-v1",
  };
  const capability = required[event.type];
  return capability && !manifest.capabilities.includes(capability)
    ? [`${event.type} requires manifest capability ${capability}`]
    : [];
}

/** Validates event-to-event identity and lifecycle references without depending on file arrival order. */
export function validateEventGraph(events: readonly ReviewEvent[]): Map<string, string[]> {
  const errors = new Map<string, string[]>();
  const add = (event: ReviewEvent, message: string) => errors.set(event.id, [...(errors.get(event.id) ?? []), message]);
  const byId = new Map<string, ReviewEvent[]>();
  for (const event of events) byId.set(event.id, [...(byId.get(event.id) ?? []), event]);
  for (const duplicates of byId.values()) if (duplicates.length > 1) duplicates.forEach((event) => add(event, "event id is not unique"));

  const publications = new Map<string, RevisionCreatedEvent[]>();
  const threadRoots = new Map<string, Array<Extract<ReviewEvent, { type: "comment.created" }>>>();
  const suggestionRoots = new Map<string, Array<Extract<ReviewEvent, { type: "suggestion.created" }>>>();
  for (const event of events) {
    if (event.type === "revision.created") publications.set(event.revisionId, [...(publications.get(event.revisionId) ?? []), event]);
    if (event.type === "comment.created") threadRoots.set(event.threadId, [...(threadRoots.get(event.threadId) ?? []), event]);
    if (event.type === "suggestion.created") suggestionRoots.set(event.suggestionId, [...(suggestionRoots.get(event.suggestionId) ?? []), event]);
  }
  for (const roots of publications.values()) if (roots.length > 1) roots.forEach((event) => add(event, "revisionId has competing publication events"));
  for (const roots of threadRoots.values()) if (roots.length > 1) roots.forEach((event) => add(event, "threadId has competing root comments"));
  for (const roots of suggestionRoots.values()) if (roots.length > 1) roots.forEach((event) => add(event, "suggestionId has competing root suggestions"));

  const commentOwners = new Map<string, Array<{ threadId: string; revisionId: string; event: ReviewEvent }>>();
  for (const event of events) {
    if (event.type !== "comment.created" && event.type !== "comment.replied") continue;
    commentOwners.set(event.commentId, [...(commentOwners.get(event.commentId) ?? []), { threadId: event.threadId, revisionId: event.revisionId, event }]);
  }
  for (const owners of commentOwners.values()) if (owners.length > 1) owners.forEach(({ event }) => add(event, "commentId is not unique"));

  for (const event of events) {
    if (event.type !== "revision.created" && (publications.get(event.revisionId)?.length ?? 0) !== 1) add(event, "event does not reference exactly one published revision");
    if (event.type === "comment.replied" || event.type === "thread.resolved" || event.type === "thread.decided") {
      const roots = threadRoots.get(event.threadId) ?? [];
      if (roots.length !== 1 || roots[0].revisionId !== event.revisionId) add(event, "thread child does not reference one root in the same revision");
      if (event.type === "comment.replied" && event.inReplyTo) {
        const owners = commentOwners.get(event.inReplyTo) ?? [];
        if (owners.length !== 1 || owners[0].threadId !== event.threadId || owners[0].revisionId !== event.revisionId || owners[0].event.id === event.id) {
          add(event, "inReplyTo does not identify another comment in the same thread and revision");
        }
      }
    }
    if (event.type === "suggestion.accepted" || event.type === "suggestion.rejected" || event.type === "suggestion.applied") {
      const roots = suggestionRoots.get(event.suggestionId) ?? [];
      if (roots.length !== 1 || roots[0].revisionId !== event.revisionId) add(event, "suggestion child does not reference one root in the same revision");
      else if (event.type === "suggestion.applied" && event.document !== roots[0].anchor.document) add(event, "suggestion.applied document does not match its anchor document");
    }
    if (event.type === "export.created") {
      if (event.includedEventIds.includes(event.id)) add(event, "export cannot include its own detached event id");
      for (const includedId of event.includedEventIds) {
        const included = byId.get(includedId) ?? [];
        if (included.length !== 1) add(event, `included event ${includedId} is missing or ambiguous`);
        else if (included[0].reviewId !== event.reviewId || included[0].revisionId !== event.revisionId) add(event, `included event ${includedId} belongs to a different review or revision`);
      }
    }
  }
  return errors;
}

/** Validates an event against the immutable revision it claims to reference. */
export function validateEventAgainstRevision(event: ReviewEvent, revision: ReviewRevision): string[] {
  const errors: string[] = [];
  if (event.reviewId !== revision.reviewId) errors.push("event reviewId does not match revision");
  if (event.revisionId !== revision.id) errors.push("event revisionId does not match revision");
  const documents = new Map(revision.documents.map((document) => [document.path, document]));
  const anchor = event.type === "comment.created" || event.type === "suggestion.created" ? event.anchor : undefined;
  if (anchor) {
    const document = documents.get(anchor.document);
    if (!document) errors.push("anchor document is not part of the revision");
    else if (document.digest !== anchor.documentDigest) errors.push("anchor documentDigest does not match the frozen document");
    const target = anchor.target;
    if (target?.kind === "image") {
      const resource = revision.resources.find((item) => item.id === target.resourceId);
      if (!resource || resource.role !== "image" || resource.document !== anchor.document) errors.push("image target does not identify an image in the anchored document");
    } else if (target?.kind === "mermaid") {
      const diagram = revision.mermaidDiagrams.find((item) => item.id === target.diagramId);
      if (!diagram || diagram.document !== anchor.document) errors.push("Mermaid target does not identify a diagram in the anchored document");
    } else if ((target?.kind === "table" || target?.kind === "table-cell") && !/^table_[a-f0-9]{24}$/.test(target.tableId)) {
      errors.push("table target id does not use the table-v1 derivation");
    }
  }
  if (event.type === "suggestion.applied" && !documents.has(event.document)) errors.push("applied suggestion document is not part of the revision");
  if (event.type === "export.created") {
    const expected = revision.mermaidDiagrams.map((diagram) => diagram.id).sort();
    const actual = Object.keys(event.renderedDiagramDigests).sort();
    if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) errors.push("renderedDiagramDigests must contain every revision Mermaid diagram exactly once");
  }
  return errors;
}
