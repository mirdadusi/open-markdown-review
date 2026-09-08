import type { ActorRef, ReviewEvent, ReviewRevision, StoredContent, Sha256Digest } from "../protocol/types";
export type { ActorRef, MarkdownAnchor, StoredContent, Sha256Digest } from "../protocol/types";

export const VERSION = "0.5.0" as const;
export const OPTIONAL_CAPABILITIES = ['presentation-profiles-v1'] as const;
export const CAPABILITIES = ["quote-anchor-v1", "range-anchor-v1", "semantic-anchor-v1", "content-addressed-resources-v1", "revision-parents-v1", "thread-lifecycle-v2", "suggested-edit-v2", "review-stance-v1", "review-policy-v1", "audit-inventory-v1"] as const;
export interface Manifest {
  protocol: "open-markdown-review"; protocolVersion: typeof VERSION;
  reviewId: string; title: string; createdAt: string; createdBy: ActorRef; documents: string[];
  eventDirectory: "events"; revisionDirectory: "revisions"; blobDirectory: "blobs/sha256"; exportDirectory: "exports";
  eventLayout: "sha256-flat-v1"; identityProfile: "self-asserted-v1"; limitsProfile: "pilot-v1";
  creationOperationId: string; capabilities: string[]; requiredCapabilities: string[];
  extensions?: Array<{ id: string; schemaUri: string; schemaDigest: Sha256Digest; schemaBlobPath: string; affectsState: boolean }>;
}
export type Revision = Omit<ReviewRevision, "schemaVersion" | "resources"> & {
  schemaVersion: typeof VERSION; parents: string[]; policy: StoredContent; creationOperationId: string;
  resources: Array<Omit<ReviewRevision["resources"][number], "sourceKind"> & { sourceKind: "workspace" | "granted-root" | "remote" | "data" }>;
};
export type Policy = { schemaVersion: typeof VERSION; kind: "review-policy" } & (
  { mode: "assertions-only" } |
  { mode: "quorum-v1"; eligibleActorIds: string[]; minimumApprovals: number; blockOnRejection: boolean; requireResolvedThreads: boolean; requireClosedSuggestions: boolean }
);
export interface Envelope {
  schemaVersion: typeof VERSION; id: string; reviewId: string; revisionId: string;
  revisionDigest: Sha256Digest; occurredAt: string; actor: ActorRef; operationId: string;
}
type Upgraded<E extends ReviewEvent> = E extends { type: "export.created" } ? never : E extends ReviewEvent
  ? Omit<E, keyof Envelope> & Envelope & (
    E extends { type: "suggestion.rejected" } ? { decisionPredecessors: string[]; reason: string } :
    E extends { type: "thread.decided" | "suggestion.accepted" } ? { decisionPredecessors: string[] } :
    E extends { type: "thread.resolved" } ? { statusPredecessors: string[] } :
    E extends { type: "review.approved" | "review.rejected" } ? { stancePredecessors: string[]; verification: StoredContent } :
    E extends { type: "suggestion.applied" } ? { acceptanceIds: string[] } : object
  ) : never;
export type Event = Upgraded<ReviewEvent> |
  (Envelope & { type: "thread.reopened"; threadId: string; reason: string; statusPredecessors: string[] }) |
  (Envelope & { type: "review.withdrawn"; reason: string; stancePredecessors: string[]; verification: StoredContent }) |
  (Envelope & { type: "export.created"; exportId: string; format: "application/pdf"; pdf: FileEvidence; inventory: FileEvidence; renderer: Renderer });
export type Payload = Event extends infer E ? E extends Event ? Omit<E, keyof Envelope> : never : never;
export interface FileEvidence { path: string; digest: Sha256Digest; byteLength: number; mediaType: string }
export interface EventEvidence extends FileEvidence { eventId: string; revisionId: string }
export type PolicyResult = "not-evaluated" | "satisfied" | "unsatisfied" | "conflicted";
export interface Verification {
  schemaVersion: typeof VERSION; kind: "verification-inventory"; reviewId: string; revisionId: string; verifiedAt: string;
  manifest: FileEvidence; revision: FileEvidence; policy: FileEvidence; contextRevisions: FileEvidence[];
  documents: FileEvidence[]; resources: FileEvidence[]; events: EventEvidence[]; policyResult: PolicyResult;
}
export interface Renderer { client: string; clientVersion: string; markdownVersion: string; mermaidVersion: string; pdfEngine: string; fontSetDigest: Sha256Digest; sanitizerVersion: string; schemaSetDigest: Sha256Digest }
export interface AuditInventory extends Omit<Verification, "kind"> {
  kind: "audit-export-inventory"; exportId: string; pdf: FileEvidence; representedEventIds: string[];
  renderedDiagrams: Array<{ diagramId: string; sourceDigest: Sha256Digest; svg: FileEvidence }>;
  diagnostics: Diagnostic[]; renderer: Renderer;
}
export interface Diagnostic { code: string; severity: "warning" | "error"; path?: string; message: string }
export class ProtocolError extends Error {
  constructor(readonly code: "missing" | "invalid" | "unsupported" | "integrity" | "permission" | "uncertain" | "changed" | "cancelled", message: string) { super(message); this.name = "ProtocolError"; }
}
export const LIMITS = { manifest: 1048576, policy: 262144, event: 262144, text: 32768, events: 10000, eventBytes: 67108864, revisions: 1000, revision: 4194304, documents: 100, markdown: 2097152, resources: 1000, resource: 20971520, content: 536870912, diagrams: 100, diagram: 131072, inventory: 33554432, pdf: 268435456, depth: 1024 } as const;
