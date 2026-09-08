export const PROTOCOL_ID = "open-markdown-review" as const;
export const PROTOCOL_VERSION = "0.4.0" as const;
export const LEGACY_PROTOCOL_VERSION_03 = "0.3.0" as const;
export const LEGACY_PROTOCOL_VERSION = "0.2.0" as const;
export const EVENT_SCHEMA_VERSION = "0.3.0" as const;
export const LEGACY_EVENT_SCHEMA_VERSION = "0.2.0" as const;
export const REVISION_SCHEMA_VERSION = "0.2.0" as const;

export type EventSchemaVersion = typeof EVENT_SCHEMA_VERSION | typeof LEGACY_EVENT_SCHEMA_VERSION;

export type Sha256Digest = `sha256:${string}`;

export interface ActorRef {
  /** Stable, self-asserted identifier. A signed profile can strengthen this later. */
  id: string;
  displayName?: string;
}

export interface ReviewManifest {
  protocol: typeof PROTOCOL_ID;
  protocolVersion: typeof PROTOCOL_VERSION | typeof LEGACY_PROTOCOL_VERSION_03 | typeof LEGACY_PROTOCOL_VERSION;
  reviewId: string;
  title: string;
  createdAt: string;
  createdBy: ActorRef;
  /** POSIX-style glob hints describing Markdown files in review scope. */
  documents: string[];
  /** Review-package-relative paths. Legacy 0.2/0.3 manifests may begin these with `.review/`. */
  eventDirectory: "events" | ".review/events";
  revisionDirectory: "revisions" | ".review/revisions";
  blobDirectory: "blobs/sha256" | ".review/blobs/sha256";
  exportDirectory: "exports" | ".review/exports";
  capabilities: Array<
    | "quote-anchor-v1"
    | "range-anchor-v1"
    | "semantic-anchor-v1"
    | "content-addressed-resources-v1"
    | "audit-export-v1"
    | "thread-decision-v1"
    | "suggested-edit-v1"
    | "review-rejection-v1"
  >;
}

export interface TextPosition {
  /** Zero-based line. */
  line: number;
  /** Zero-based UTF-16 character offset, matching VS Code positions. */
  character: number;
}

export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

export interface QuoteSelector {
  exact: string;
  prefix?: string;
  suffix?: string;
}

export type SemanticTarget =
  | { kind: "text" }
  | { kind: "image"; resourceId: string; label?: string }
  | { kind: "mermaid"; diagramId: string; label?: string }
  | { kind: "table"; tableId: string; label?: string }
  | { kind: "table-cell"; tableId: string; row: number; column: number; label?: string };

export interface MarkdownAnchor {
  /** Workspace-relative path with forward slashes. */
  document: string;
  range: TextRange;
  quote: QuoteSelector;
  /** Digest of the frozen Markdown document in the referenced revision. */
  documentDigest: Sha256Digest;
  target?: SemanticTarget;
}

export interface MarkdownBody {
  format: "markdown";
  text: string;
}

export interface StoredContent {
  digest: Sha256Digest;
  /** Review-root-relative path. The digest is also encoded in this path. */
  blobPath: string;
  mediaType: string;
  byteLength: number;
}

export interface RevisionDocument extends StoredContent {
  path: string;
}

export interface RevisionResource extends StoredContent {
  id: string;
  /** Markdown document containing the reference. */
  document: string;
  originalReference: string;
  sourceKind: "workspace" | "remote" | "data";
  role: "image" | "attachment";
  alt?: string;
  capturedAt: string;
}

export interface ExternalReference {
  id: string;
  document: string;
  uri: string;
  label?: string;
  relation: "link";
}

export interface MermaidDiagram {
  id: string;
  document: string;
  ordinal: number;
  sourceDigest: Sha256Digest;
  source: string;
}

export interface RevisionDiagnostic {
  severity: "warning" | "error";
  code: string;
  document?: string;
  reference?: string;
  message: string;
}

export interface ReviewRevision {
  schemaVersion: typeof REVISION_SCHEMA_VERSION;
  id: string;
  reviewId: string;
  createdAt: string;
  createdBy: ActorRef;
  rootDocument: string;
  documents: RevisionDocument[];
  resources: RevisionResource[];
  externalReferences: ExternalReference[];
  mermaidDiagrams: MermaidDiagram[];
  diagnostics: RevisionDiagnostic[];
  renderer: {
    markdownProfile: "commonmark-gfm";
    mermaidVersion: string;
  };
}

interface EventBase {
  schemaVersion: EventSchemaVersion;
  id: string;
  reviewId: string;
  occurredAt: string;
  actor: ActorRef;
}

export interface RevisionCreatedEvent extends EventBase {
  type: "revision.created";
  revisionId: string;
  revisionPath: string;
  revisionDigest: Sha256Digest;
}

export interface CommentCreatedEvent extends EventBase {
  type: "comment.created";
  revisionId: string;
  threadId: string;
  commentId: string;
  anchor: MarkdownAnchor;
  body: MarkdownBody;
}

export interface CommentRepliedEvent extends EventBase {
  type: "comment.replied";
  revisionId: string;
  threadId: string;
  commentId: string;
  inReplyTo?: string;
  body: MarkdownBody;
}

export interface ThreadResolvedEvent extends EventBase {
  type: "thread.resolved";
  revisionId: string;
  threadId: string;
  note?: string;
}

export type ThreadDecision = "accepted" | "rejected" | "wont-fix" | "duplicate";

export interface ThreadDecidedEvent extends EventBase {
  type: "thread.decided";
  revisionId: string;
  threadId: string;
  decision: ThreadDecision;
  reason?: string;
}

export interface ReviewApprovedEvent extends EventBase {
  type: "review.approved";
  revisionId: string;
  note?: string;
}

export interface ReviewRejectedEvent extends EventBase {
  type: "review.rejected";
  revisionId: string;
  reason: string;
}

export type SuggestedEditOperation =
  | { kind: "delete" }
  | { kind: "replace"; replacement: string }
  | { kind: "insert"; replacement: string; position: "before" | "after" };

export interface SuggestionCreatedEvent extends EventBase {
  type: "suggestion.created";
  revisionId: string;
  suggestionId: string;
  anchor: MarkdownAnchor;
  operation: SuggestedEditOperation;
  rationale: MarkdownBody;
}

export interface SuggestionAcceptedEvent extends EventBase {
  type: "suggestion.accepted";
  revisionId: string;
  suggestionId: string;
  note?: string;
}

export interface SuggestionRejectedEvent extends EventBase {
  type: "suggestion.rejected";
  revisionId: string;
  suggestionId: string;
  reason?: string;
}

export interface SuggestionAppliedEvent extends EventBase {
  type: "suggestion.applied";
  revisionId: string;
  suggestionId: string;
  document: string;
  sourceDigestBefore: Sha256Digest;
  sourceDigestAfter: Sha256Digest;
}

export interface ExportCreatedEvent extends EventBase {
  type: "export.created";
  revisionId: string;
  exportId: string;
  format: "application/pdf";
  exportPath: string;
  exportDigest: Sha256Digest;
  includedEventIds: string[];
  renderer: {
    /** Stable implementation identifier, not a protocol-defined client brand. */
    client: string;
    clientVersion: string;
    pdfEngine: string;
    mermaidVersion: string;
  };
  renderedDiagramDigests: Record<string, Sha256Digest>;
}

export type ReviewEvent =
  | RevisionCreatedEvent
  | CommentCreatedEvent
  | CommentRepliedEvent
  | ThreadResolvedEvent
  | ThreadDecidedEvent
  | ReviewApprovedEvent
  | ReviewRejectedEvent
  | SuggestionCreatedEvent
  | SuggestionAcceptedEvent
  | SuggestionRejectedEvent
  | SuggestionAppliedEvent
  | ExportCreatedEvent;

export type EventType = ReviewEvent["type"];

export interface ReviewThread {
  id: string;
  revisionId: string;
  root: CommentCreatedEvent;
  replies: CommentRepliedEvent[];
  resolved?: ThreadResolvedEvent;
  decision?: ThreadDecidedEvent;
  decisionConflicts: ThreadDecidedEvent[];
}

export type SuggestionStatus = "open" | "accepted" | "rejected" | "applied" | "conflicted";

export interface ReviewSuggestion {
  id: string;
  revisionId: string;
  created: SuggestionCreatedEvent;
  accepted?: SuggestionAcceptedEvent;
  rejected?: SuggestionRejectedEvent;
  applied?: SuggestionAppliedEvent;
  status: SuggestionStatus;
  decisionConflicts: Array<SuggestionAcceptedEvent | SuggestionRejectedEvent>;
}

export interface ReviewState {
  threads: Map<string, ReviewThread>;
  unresolvedThreads: ReviewThread[];
  approvals: ReviewApprovedEvent[];
  rejections: ReviewRejectedEvent[];
  suggestions: Map<string, ReviewSuggestion>;
  openSuggestions: ReviewSuggestion[];
  revisionEvents: RevisionCreatedEvent[];
  latestRevisionId?: string;
  exports: ExportCreatedEvent[];
  /** Events that reference a thread whose root comment has not synced yet. */
  danglingEvents: ReviewEvent[];
}
