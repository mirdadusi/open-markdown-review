import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { ActorRef, Event, LIMITS, ProtocolError, Sha256Digest, THREAD_ADDRESSING } from './types';
import { AuthorRequest, authorReview, preparedAuthoring, checkPreparedResources } from './authoring';
import { NativeStorage } from './nativeStorage';
import { ReviewSession } from './session';
import { decode, digest, jsonBytes, newId, parseJson } from './bytes';
import { fold, threadWorkflowQueue, ThreadWorkflowQueue } from './state';
import { implementationSummary } from './implementationNote';
import { checkpoint, interruptible, OperationControl } from './operation';
import { mapWithConcurrency } from '../protocol/concurrency';
import { FindingScopeChoice, FindingScopePlan, findingScopeChoice, findingScopeProblems } from './findingScope';
import { planFindingScope } from './findingScopePlan';

export interface FindingSelection { threadId: string; summary?: string }
export interface FindingPublicationPreview {
  operationId: string; reviewTitle: string; originRevisionId: string; revisionId: string;
  parents: string[]; sourceRoot: string; destination: string;
  documents: Array<{ path: string; changed: boolean; change?: 'added' | 'modified' | 'removed' | 'unchanged'; before: string; after: string; truncated: boolean; beforeDigest?: string; afterDigest?: string }>;
  resources: Array<{ document: string; reference: string; changed: boolean; digest: string; removed?: boolean }>;
  findings: Array<{ threadId: string; document: string; quote: string; addressed: boolean; workflow?: ThreadWorkflowQueue; open?: boolean; body?: string; author?: string }>;
  pending?: FindingPublicationResult;
  preparedSelections?: FindingSelection[];
  scopeConfirmed?: boolean;
  removedFindingCount?: number;
}
export interface FindingPublicationResult { revisionId: string; originRevisionId: string; records: Array<{ threadId: string; saved: boolean; error?: string }> }
interface Draft {
  reviewId: string; manifestDigest: Sha256Digest; actor: ActorRef; origin: string; heads: string[];
  request: AuthorRequest; preview: FindingPublicationPreview;
  selections?: FindingSelection[]; records?: Event[];
  observedFindings: Array<{ threadId: string; decisions: string[]; addressing: string[] }>;
  retired?: { reason: string; at: string };
}
export interface FindingPublisherOptions { root: string; source: string; journalRoot: string; artifact: string }
const running = new Map<string, Promise<unknown>>();
const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Native-only orchestration. The shared record remains revisions, blobs and events. */
export class FindingPublisher {
  private readonly store: NativeStorage;
  private readonly journal: NativeStorage;
  private readonly intents: NativeStorage;
  constructor(private readonly options: FindingPublisherOptions) {
    this.store = new NativeStorage(options.root, options.journalRoot);
    // Participant journal RPC must never be able to replace a native authoring intent.
    this.journal = new NativeStorage(options.root, path.join(options.journalRoot, 'finding-authority'));
    this.intents = new NativeStorage(path.join(options.journalRoot, 'finding-intents'), options.journalRoot);
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const key = this.store.identity, previous = running.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(work); running.set(key, task);
    void task.finally(() => { if (running.get(key) === task) running.delete(key); }).catch(() => {});
    return task;
  }
  private checkedSession(session: ReviewSession, origin: string, actor: ActorRef) {
    if (session.storage.identity !== this.store.identity || session.pinnedRevisionId !== origin) throw new ProtocolError('invalid', 'The verified preparation context belongs to another review or snapshot.');
    if (session.diagnostics.some(d => d.severity === 'error')) throw new ProtocolError('integrity', 'Resolve review integrity errors before processing findings.');
    if (session.manifest.createdBy.id !== actor.id) throw new ProtocolError('permission', 'Only the review initiator can publish and record finding implementations.');
    if (!session.manifest.requiredCapabilities.includes(THREAD_ADDRESSING)) throw new ProtocolError('unsupported', 'This review does not declare thread-addressing-v1. It remains readable without silently changing its capabilities.');
    return session;
  }
  private async session(origin: string, actor: ActorRef, control?: OperationControl) {
    checkpoint(control, 'Verifying the review and original finding snapshot…');
    const session = new ReviewSession(this.store, control?.progress); await interruptible(session.open(), control); await interruptible(session.pin(origin), control);
    return this.checkedSession(session, origin, actor);
  }
  private key(operationId: string) {
    if (!/^finding_[a-zA-Z0-9_-]{1,90}$/.test(operationId)) throw new ProtocolError('invalid', 'Invalid finding publication operation.');
    return `native-finding:${operationId}`;
  }
  private pointer(origin: string, actor: ActorRef) { return `native-finding-active:${digest(`${origin}\0${actor.id}`).slice(7)}`; }
  private async write(draft: Draft) { await this.journal.journalPut(this.key(draft.request.operationId), { path: 'private/finding-publication', bytes: jsonBytes(draft), acknowledged: false }); }
  private async read(operationId: string, actor: ActorRef, verified?: ReviewSession, control?: OperationControl): Promise<{ draft: Draft; session: ReviewSession }> {
    const record = await this.journal.journalGet(this.key(operationId));
    if (!record) throw new ProtocolError('missing', 'This device has no saved publication draft. Prepare the change again.');
    const draft = parseJson<Draft>(new Uint8Array(record.bytes), LIMITS.pdf * 8);
    if (draft.request.store !== this.options.root || draft.request.source !== this.options.source || draft.actor.id !== actor.id || draft.actor.displayName !== actor.displayName) throw new ProtocolError('changed', 'Review, source or participant changed. Return to the original publication context.');
    const session = verified ? this.checkedSession(verified, draft.origin, actor) : await this.session(draft.origin, actor, control);
    if (digest(await this.store.read('manifest.json', LIMITS.manifest)) !== draft.manifestDigest) throw new ProtocolError('integrity', 'The immutable review manifest changed.');
    return { draft, session };
  }
  /** Reuse only a fresh request-local native snapshot, never a cross-request cache. */
  async pending(origin: string, actor: ActorRef, verified?: ReviewSession, control?: OperationControl): Promise<FindingPublicationPreview | undefined> {
    checkpoint(control, 'Checking saved publication/recovery state…');
    const session = verified ? this.checkedSession(verified, origin, actor) : await this.session(origin, actor, control);
    const pointer = await this.journal.journalGet(this.pointer(origin, actor));
    checkpoint(control);
    if (!pointer) return;
    if (!pointer.bytes.length) return;
    const operationId = decode(new Uint8Array(pointer.bytes));
    const { draft } = await this.read(operationId, actor, session); checkpoint(control);
    if (draft.retired) return;
    if (draft.records) {
      const preview = await this.resultPreview(draft, session);
      if (!preview.pending || preview.pending.records.some(r => !r.saved)) return preview;
    }
  }
  async discard(origin: string, actor: ActorRef, operationId: string): Promise<void> {
    return this.exclusive(async () => {
      const { draft, session } = await this.read(operationId, actor);
      if (draft.origin !== origin) throw new ProtocolError('changed', 'The original revision changed.');
      const preview = await this.resultPreview(draft, session);
      if (preview.pending?.records.some(r => !r.saved)) throw new ProtocolError('changed', 'The revision is already published. Retry its pending records instead of discarding the operation.');
      const pointer = await this.journal.journalGet(this.pointer(origin, actor));
      if (pointer && decode(new Uint8Array(pointer.bytes)) === operationId) await this.journal.journalPut(this.pointer(origin, actor), { path: 'private/finding-publication', bytes: [], acknowledged: true });
    });
  }
  /** Explicitly retain the published snapshot while leaving pending findings for manual reconciliation. */
  async retire(origin: string, actor: ActorRef, operationId: string, reason: string): Promise<void> {
    return this.exclusive(async () => {
      const { draft, session } = await this.read(operationId, actor);
      if (draft.origin !== origin || !reason.trim() || reason.length > 32768) throw new ProtocolError('invalid', 'Keep the original context and explain why pending findings will be handled manually.');
      const current = await this.resultPreview(draft, session);
      if (!current.pending) throw new ProtocolError('changed', 'No revision has been published. Cancel this preparation instead.');
      draft.retired = { reason: reason.trim(), at: new Date().toISOString() }; await this.write(draft);
      const pointer = await this.journal.journalGet(this.pointer(origin, actor));
      if (pointer && decode(new Uint8Array(pointer.bytes)) === operationId) await this.journal.journalPut(this.pointer(origin, actor), { path: 'private/finding-publication', bytes: [], acknowledged: true });
    });
  }
  private async resultPreview(draft: Draft, verified?: ReviewSession) {
    const session = verified ? this.checkedSession(verified, draft.origin, draft.actor) : await this.session(draft.origin, draft.actor);
    const published = session.revisions.has(draft.preview.revisionId);
    return { ...draft.preview, ...(draft.selections ? { preparedSelections: draft.selections } : {}), ...(published ? { pending: { revisionId: draft.preview.revisionId, originRevisionId: draft.origin, records: (draft.records ?? []).map(event => ({ threadId: 'threadId' in event ? event.threadId : '', saved: session.events.some(item => item.id === event.id) })) } } : {}) };
  }
  async prepare(origin: string, actor: ActorRef, parents?: string[], resourceRoots?: string[], control?: OperationControl): Promise<FindingPublicationPreview> {
    const result = await this.preparation(origin, actor, parents, resourceRoots, control, false);
    if ('kind' in result) throw new ProtocolError('invalid', 'Confirm the referenced Markdown scope before preparing the comparison.');
    return result;
  }
  prepareGuided(origin: string, actor: ActorRef, parents?: string[], resourceRoots?: string[], control?: OperationControl, choice?: FindingScopeChoice, verified?: ReviewSession): Promise<FindingPublicationPreview | FindingScopePlan> {
    return this.preparation(origin, actor, parents, resourceRoots, control, true, choice, verified);
  }
  private async preparation(origin: string, actor: ActorRef, parents: string[] | undefined, resourceRoots: string[] | undefined, control: OperationControl | undefined, guided: boolean, input?: FindingScopeChoice, verified?: ReviewSession): Promise<FindingPublicationPreview | FindingScopePlan> {
    return this.exclusive(async () => {
      const session = verified ? this.checkedSession(verified, origin, actor) : await this.session(origin, actor, control);
      const pending = await this.pending(origin, actor, session, control); if (pending) return pending;
      const heads = session.heads.map(r => r.id);
      if (!parents && heads.length !== 1) throw new ProtocolError('changed', 'This review has multiple heads. Choose explicit revision parents in Advanced publication settings.');
      const selected = parents ?? heads;
      if (!selected.length || selected.some(id => !session.revisions.has(id))) throw new ProtocolError('invalid', 'Choose existing revision parents.');
      const ancestors = new Set<string>(), visit = (id: string) => { if (ancestors.has(id)) return; ancestors.add(id); session.revisions.get(id)?.parents.forEach(visit); }; selected.forEach(visit);
      if (!ancestors.has(origin)) throw new ProtocolError('changed', 'Publication parents must descend from the original finding revision.');
      const parent = session.revisions.get(selected[0])!;
      if (session.manifest.extensions?.length) throw new ProtocolError('unsupported', 'Use Review Setup and Documents for presentation-profile capture. The guided text-correction path currently supports Markdown reviews.');
      const scope = await planFindingScope(this.options.source, this.options.root, this.options.journalRoot, parent, origin, selected, heads, session.manifest.title, control);
      const choice = input === undefined ? undefined : findingScopeChoice(input);
      if (choice && (choice.planDigest !== scope.digest || !same(choice.parents, selected))) throw new ProtocolError('changed', 'Source files, document links or revision heads changed after scope selection. Cancel and inspect a fresh scope.');
      const included = choice?.documents ?? parent.documents.map(doc => doc.path);
      const problems = findingScopeProblems(scope, included);
      if (!choice && guided && (scope.documents.some(doc => !doc.inReview || !doc.available) || problems.length)) return scope;
      if (problems.length) throw new ProtocolError('invalid', `Confirm a complete Markdown scope before publication:\n${problems.slice(0, 10).join('\n')}`);
      const request: AuthorRequest = { source: this.options.source, store: this.options.root, journalRoot: this.options.journalRoot,
        clientArtifact: this.options.artifact, operationId: newId('finding'), actor, parents: selected, include: included, rootDocument: parent.rootDocument,
        policy: parseJson(await session.content(parent.policy), LIMITS.policy), preserveClient: true, ...(resourceRoots ? { resourceRoots } : {}) };
      await authorReview({ ...request, prepareOnly: true, ...control });
      checkpoint(control, 'Building the comparison; unchanged documents need no text preview…');
      const captured = await preparedAuthoring(request);
      if (captured.revision.documents.some(doc => scope.documents.find(item => item.path === doc.path)?.digest !== doc.digest)) throw new ProtocolError('changed', 'Source changed while capturing the confirmed scope. Inspect a fresh scope and comparison.');
      const documents: FindingPublicationPreview['documents'] = await mapWithConcurrency(captured.revision.documents, 4, async document => {
        checkpoint(control);
        const before = parent.documents.find(d => d.path === document.path), changed = before?.digest !== document.digest;
        const [oldText, text] = changed ? await Promise.all([before ? session.content(before).then(decode) : '', captured.content(document).then(decode)]) : ['', ''];
        return { path: document.path, changed, change: !before ? 'added' as const : changed ? 'modified' as const : 'unchanged' as const, before: oldText.slice(0, 65536), after: text.slice(0, 65536), truncated: text.length > 65536 || oldText.length > 65536, beforeDigest: before?.digest, afterDigest: document.digest };
      });
      const removed = await mapWithConcurrency(parent.documents.filter(doc => !included.includes(doc.path)), 4, async doc => {
        const before = decode(await session.content(doc)); checkpoint(control);
        return { path: doc.path, changed: true, change: 'removed' as const, before: before.slice(0, 65536), after: '', truncated: before.length > 65536, beforeDigest: doc.digest, afterDigest: undefined };
      });
      documents.push(...removed);
      checkpoint(control);
      const resources: FindingPublicationPreview['resources'] = captured.revision.resources.map(r => ({ document: r.document, reference: r.originalReference, digest: r.digest, changed: parent.resources.find(p => p.id === r.id)?.digest !== r.digest }));
      resources.push(...parent.resources.filter(r => !captured.revision.resources.some(next => next.id === r.id)).map(r => ({ document: r.document, reference: r.originalReference, digest: r.digest, changed: true, removed: true })));
      if (!documents.some(d => d.changed) && !resources.some(r => r.changed) && parent.resources.length === resources.length) throw new ProtocolError('changed', 'Source is unchanged. Edit and save the Markdown or resources first; saving alone never records implementation.');
      const preview: FindingPublicationPreview = { operationId: request.operationId, reviewTitle: session.manifest.title, originRevisionId: origin,
        revisionId: captured.revision.id, parents: selected, sourceRoot: request.source, destination: request.store, documents, resources, scopeConfirmed: !!choice,
        removedFindingCount: fold(session.events, origin).threads.filter(thread => !included.includes(thread.root.anchor.document)).length,
        findings: fold(session.events, origin).threads.filter(t => threadWorkflowQueue(t) !== 'conflict' && t.decision.heads.some(e => e.type === 'thread.decided' && e.decision === 'accepted') && captured.revision.documents.some(d => d.path === t.root.anchor.document)).map(t => ({ threadId: t.root.threadId, document: t.root.anchor.document, quote: t.root.anchor.quote.exact.slice(0, 500), addressed: !!t.addressed, workflow: threadWorkflowQueue(t), open: t.open, body: t.comment.body.text.slice(0, 300), author: t.root.actor.displayName ?? t.root.actor.id })) };
      const draft: Draft = { reviewId: session.manifest.reviewId, manifestDigest: digest(await this.store.read('manifest.json', LIMITS.manifest)), actor, origin, heads, request, preview,
        observedFindings: fold(session.events, origin).threads.map(t => ({ threadId: t.root.threadId, decisions: t.decision.heads.map(e => e.id), addressing: t.addressing.heads.map(e => e.id) })) };
      await this.write(draft);
      await this.journal.journalPut(this.pointer(origin, actor), { path: 'private/finding-publication', bytes: new TextEncoder().encode(request.operationId), acknowledged: false });
      checkpoint(control);
      return preview;
    });
  }
  async finish(operationId: string, actor: ActorRef, selections: FindingSelection[], beforePublish?: () => Promise<void>, expectedOrigin?: string, progress?: (message: string) => void, verified?: ReviewSession): Promise<FindingPublicationResult> {
    return this.exclusive(async () => {
      progress?.('Checking the confirmed publication and finding selections…');
      const loaded = await this.read(operationId, actor, verified, { progress });
      const { draft } = loaded; let session = loaded.session;
      if (draft.retired) throw new ProtocolError('changed', 'This retry intent was explicitly retired for manual reconciliation. Its captured evidence and history were preserved.');
      if (expectedOrigin !== undefined && expectedOrigin !== draft.origin) throw new ProtocolError('changed', 'Return to the original finding snapshot before retrying this publication.');
      if (!Array.isArray(selections) || selections.length > LIMITS.documents || selections.some(s => !s || typeof s.threadId !== 'string' || s.summary !== undefined && (typeof s.summary !== 'string' || s.summary.length > 32768)) || new Set(selections.map(s => s.threadId)).size !== selections.length) throw new ProtocolError('invalid', 'Select up to 100 unique findings; implementation notes may be omitted.');
      if (draft.selections && digest(jsonBytes(selections)) !== digest(jsonBytes(draft.selections))) throw new ProtocolError('changed', 'Retry the original selected fixes and summaries; this operation already has an exact intent.');
      if (!draft.records) {
        const state = fold(session.events, draft.origin), ctx = session.context(actor);
        draft.records = selections.map(selection => {
          if (!draft.preview.findings.some(f => f.threadId === selection.threadId)) throw new ProtocolError('invalid', 'A selected finding was not in the confirmed preparation.');
          const thread = state.threads.find(t => t.root.threadId === selection.threadId)!;
          const observed = draft.observedFindings.find(f => f.threadId === selection.threadId);
          if (!thread || thread.decision.conflict || thread.addressing.conflict || !thread.decision.heads.some(e => e.type === 'thread.decided' && e.decision === 'accepted')) throw new ProtocolError('changed', 'A finding decision changed. Inspect it before recording implementation.');
          if (['implemented', 'verified'].includes(threadWorkflowQueue(thread))) throw new ProtocolError('changed', 'This finding is already implemented. Reopen the finding explicitly before recording a replacement fix.');
          if (!observed || !same(observed.decisions, thread.decision.heads.map(e => e.id)) || !same(observed.addressing, thread.addressing.heads.map(e => e.id))) throw new ProtocolError('changed', 'A selected finding changed since preparation. Prepare and confirm its current state.');
          const doc = draft.preview.documents.find(d => d.path === thread.root.anchor.document)!;
          return session.makeEvent(ctx, { type: 'thread.addressed', threadId: selection.threadId, toRevisionId: draft.preview.revisionId, document: doc.path,
            sourceDigestBefore: thread.root.anchor.documentDigest, sourceDigestAfter: doc.afterDigest as Sha256Digest, summary: implementationSummary(selection.summary, draft.preview.revisionId, doc.path),
            decisionIds: thread.decision.heads.map(e => e.id), addressingPredecessors: thread.addressing.heads.map(e => e.id) }, newId('address'));
        });
        // A write-once private intent also coordinates separate VS Code windows.
        // Atomic journal replacement alone cannot choose the first event bytes.
        const fingerprint = digest(jsonBytes({ operationId, reviewId: draft.reviewId, manifestDigest: draft.manifestDigest, origin: draft.origin, target: draft.preview.revisionId, actor, selections }));
        const file = `${operationId}.json`;
        await mkdir(this.intents.root, { recursive: true, mode: 0o700 });
        try { await this.intents.write(file, jsonBytes({ fingerprint, records: draft.records }), false); }
        catch (error) {
          const first = parseJson<{ fingerprint: string; records: Event[] }>(await this.intents.read(file, LIMITS.event * LIMITS.documents), LIMITS.event * LIMITS.documents);
          if (first.fingerprint !== fingerprint) throw new ProtocolError('changed', 'Another window already confirmed a different selection or summary. Retry its original intent or cancel before publication.');
          draft.records = first.records;
        }
        draft.selections = selections; await this.write(draft);
      }
      if (!session.revisions.has(draft.preview.revisionId)) {
        await authorReview({ ...draft.request, resume: true, progress, beforePublish: async () => {
          await beforePublish?.();
          const fresh = await this.session(draft.origin, actor, { progress });
          if (!same(draft.heads, fresh.heads.map(r => r.id))) throw new ProtocolError('changed', 'Revision heads changed after preparation. Inspect the new branch before publishing.');
          const source = new NativeStorage(draft.request.source, draft.request.journalRoot), documents = draft.preview.documents.filter(d => d.afterDigest);
          let checked = 0;
          progress?.(`Rechecking saved source documents (0/${documents.length})…`);
          await mapWithConcurrency(documents, 4, async d => {
            if (digest(await source.read(d.path, LIMITS.markdown)) !== d.afterDigest) throw new ProtocolError('changed', 'Source changed after the diff was prepared. Cancel and prepare a fresh diff.');
            progress?.(`Rechecking saved source documents (${++checked}/${documents.length})…`);
          });
          await checkPreparedResources({ ...draft.request, progress });
          const threads = new Map(fold(fresh.events, draft.origin).threads.map(thread => [thread.root.threadId, thread]));
          for (const event of draft.records!) {
            const thread = 'threadId' in event ? threads.get(event.threadId) : undefined;
            if (event.type !== 'thread.addressed' || !thread || thread.decision.conflict || thread.addressing.conflict || !same(thread.decision.heads.map(e => e.id), event.decisionIds) || !same(thread.addressing.heads.map(e => e.id), event.addressingPredecessors)) throw new ProtocolError('changed', 'A selected finding changed after confirmation. Inspect its current state.');
          }
        } });
        progress?.('Verifying the published revision before recording fixes…');
        await session.refresh(); this.checkedSession(session, draft.origin, actor);
      }
      const records: FindingPublicationResult['records'] = [];
      for (const event of draft.records) {
        progress?.(`Recording selected fixes (${records.length}/${draft.records.length})…`);
        if (event.type !== 'thread.addressed') throw new ProtocolError('invalid', 'Invalid private finding record.');
        try { await session.save(session.context(actor), event); records.push({ threadId: event.threadId, saved: true }); }
        catch (error) { records.push({ threadId: event.threadId, saved: false, error: error instanceof Error ? error.message : String(error) }); }
      }
      const result = { revisionId: draft.preview.revisionId, originRevisionId: draft.origin, records };
      progress?.(`Publication verified · ${records.filter(record => record.saved).length}/${records.length} selected fixes recorded.`);
      return result;
    });
  }
}
