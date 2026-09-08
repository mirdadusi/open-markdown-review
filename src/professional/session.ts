import { ascii, decode, digest, jsonBytes, newId, parseJson } from './bytes';
import { admit, policyResult } from './state';
import { validate, validateAnchorEvent, validateSource } from './validation';
import { ByteCache, Storage, evidence, contentRef, publish, publishBlob } from './storage';
import { ActorRef, AuditInventory, Diagnostic, Event, FileEvidence, LIMITS, Manifest, Payload, Policy, ProtocolError, Revision, StoredContent, Verification } from './types';
import { mapWithConcurrency } from '../protocol/concurrency';
import { loadProfiles } from './profiles/registry';

export interface ActionContext { readonly session: ReviewSession; readonly revision: Revision; readonly publication: Extract<Event, { type: 'revision.created' }>; readonly actor: ActorRef }
export interface CapturedAudit { inventory: Verification; events: Event[]; revision: Revision; manifest: Manifest; bytes: ReadonlyMap<string, Uint8Array>; frontier: string; diagnostics: Diagnostic[] }
export class ReviewSession {
  manifest!: Manifest;
  events: Event[] = [];
  revisions = new Map<string, Revision>();
  diagnostics: Diagnostic[] = [];
  pinnedRevisionId?: string;
  readonly profiles = new Map<string, ReadonlyMap<string, unknown>>();
  private manifestBytes?: Uint8Array;
  private files = new Map<string, { event: Event; bytes: Uint8Array }>();
  private cache = new ByteCache();
  private queue: Promise<unknown> = Promise.resolve();
  private cursor = 0;
  private sourceCache = new Map<string, Map<string, string>>();
  private refreshFlight?: Promise<void>;
  private requireFullRefresh = false;
  private validatedAnchors = new Set<string>();
  private validatedReceipts = new Map<string, string[]>();
  private evidenceById = new Map<string, FileEvidence>();
  private auditReads?: Map<string, Promise<Uint8Array>>;
  constructor(readonly storage: Storage) {}
  private async readDisk(path: string, limit: number): Promise<Uint8Array> {
    if (!this.auditReads) return this.storage.read(path, limit);
    let read = this.auditReads.get(path);
    if (!read) { read = this.storage.read(path, limit); this.auditReads.set(path, read); }
    const bytes = await read;
    if (bytes.length > limit) throw new ProtocolError('unsupported', `File exceeds ${limit} bytes: ${path}`);
    return bytes;
  }
  get revision(): Revision | undefined { return this.pinnedRevisionId ? this.revisions.get(this.pinnedRevisionId) : undefined; }
  get heads(): Revision[] { const parents = new Set([...this.revisions.values()].flatMap(r => r.parents)); return [...this.revisions.values()].filter(r => !parents.has(r.id)); }
  private exclusive<T>(work: () => Promise<T>): Promise<T> { const result = this.queue.then(work); this.queue = result.catch(() => undefined); return result; }
  async open(): Promise<void> {
    this.manifestBytes = await this.storage.read('manifest.json', LIMITS.manifest);
    this.manifest = validate('manifest', parseJson(this.manifestBytes, LIMITS.manifest));
    await this.refresh();
    if (this.heads.length === 1) this.pinnedRevisionId = this.heads[0].id;
  }
  async content(item: StoredContent, fresh = false): Promise<Uint8Array> {
    let bytes = fresh ? undefined : this.cache.get(item.digest);
    if (!bytes) bytes = await this.readDisk(item.blobPath, Math.max(item.byteLength, 1));
    if (bytes.length !== item.byteLength || digest(bytes) !== item.digest) throw new ProtocolError('integrity', `Content digest mismatch: ${item.blobPath}`);
    this.cache.set(item.digest, bytes); return bytes;
  }
  private async sources(revision: Revision, fresh = false): Promise<Map<string, string>> {
    const key = digest(jsonBytes(revision));
    if (!fresh && this.sourceCache.has(key)) return this.sourceCache.get(key)!;
    const result = new Map(await mapWithConcurrency(revision.documents, 4, async d => {
      const source = decode(await this.content(d, fresh)); validateSource(revision, d.path, source); return [d.path, source] as const;
    }));
    const profiles = await loadProfiles(this.manifest, revision, result, c => this.content(c, fresh));
    this.profiles.set(revision.id, profiles);
    // Keep a bounded number of decoded working sets. Blobs remain in the byte-budgeted LRU.
    this.sourceCache.set(key, result);
    while (this.sourceCache.size > 2) this.sourceCache.delete(this.sourceCache.keys().next().value!);
    return result;
  }
  refresh(full = false): Promise<void> {
    this.requireFullRefresh ||= full;
    if (!this.refreshFlight) {
      const work = this.exclusive(async () => {
        do { const audit = this.requireFullRefresh; this.requireFullRefresh = false; await this.scan(audit); } while (this.requireFullRefresh);
      });
      this.refreshFlight = work;
      void work.then(() => { if (this.refreshFlight === work) this.refreshFlight = undefined; }, () => { if (this.refreshFlight === work) this.refreshFlight = undefined; });
    }
    return this.refreshFlight;
  }
  private async scan(full: boolean): Promise<void> {
    const diagnostics: Diagnostic[] = [];
    const problem = (path: string, error: unknown) => diagnostics.push({ code: error instanceof ProtocolError ? error.code : 'unavailable', severity: 'error', path, message: error instanceof Error ? error.message : String(error) });
    try {
      if (full) { const manifest = await this.readDisk('manifest.json', LIMITS.manifest); if (digest(manifest) !== digest(this.manifestBytes!)) throw new ProtocolError('integrity', 'Manifest changed after connection.'); }
      const names = (await this.storage.list('events')).filter(n => n.endsWith('.json'));
      if (names.length > LIMITS.events) throw new ProtocolError('unsupported', 'Too many event files.');
      const present = new Set(names);
      for (const name of this.files.keys()) if (!present.has(name)) problem(`events/${name}`, new ProtocolError('integrity', 'Previously admitted file disappeared.'));
      const sweep = new Set(names.slice(this.cursor, this.cursor + 64)); this.cursor = names.length ? (this.cursor + 64) % names.length : 0;
      const candidate = new Map(this.files);
      let changed = false;
      const copies: Array<{ path: string; canonical: string; eventId: string }> = [];
      await mapWithConcurrency(names, 4, async name => {
        if (!full && candidate.has(name) && !sweep.has(name)) return;
        try {
          const bytes = await this.readDisk(`events/${name}`, LIMITS.event);
          const canonical = `${digest(bytes).slice(7)}.json`;
          if (name !== canonical) { const event = validate('event', parseJson(bytes)); copies.push({ path: `events/${name}`, canonical, eventId: event.id }); changed = true; return; }
          const old = this.files.get(name);
          if (old && digest(old.bytes) !== digest(bytes)) throw new ProtocolError('integrity', 'An immutable event changed.');
          const event = old?.event ?? validate('event', parseJson(bytes));
          if (event.reviewId !== this.manifest.reviewId) throw new ProtocolError('invalid', 'Event belongs to another review.');
          if (!old) changed = true;
          candidate.set(name, old ?? { event, bytes });
        } catch (error) { changed = true; problem(`events/${name}`, error); candidate.delete(name); }
      });
      if (!full && !changed && !diagnostics.length && !this.diagnostics.length) return;
      if ([...candidate.values()].reduce((sum, f) => sum + f.bytes.length, 0) > LIMITS.eventBytes) throw new ProtocolError('unsupported', 'Aggregate event byte limit exceeded.');
      const all = [...candidate.values()].map(f => f.event), publications = all.filter((e): e is Extract<Event, { type: 'revision.created' }> => e.type === 'revision.created');
      if (publications.length > LIMITS.revisions) throw new ProtocolError('unsupported', 'Too many revisions.');
      const revisions = new Map<string, Revision>(), sources = new Map<string, Map<string, string>>();
      await mapWithConcurrency(publications, 4, async event => {
        try {
          let revision = !full ? this.revisions.get(event.revisionId) : undefined;
          const alreadyVerified = !!revision;
          if (!revision) {
            if (event.revisionPath !== `revisions/${event.revisionId}.json`) throw new ProtocolError('invalid', 'Revision publication path differs.');
            const bytes = await this.readDisk(event.revisionPath, LIMITS.revision);
            if (digest(bytes) !== event.revisionDigest) throw new ProtocolError('integrity', 'Revision descriptor digest differs.');
            revision = validate('revision', parseJson(bytes, LIMITS.revision));
            if (revision.reviewId !== this.manifest.reviewId || revision.id !== event.revisionId) throw new ProtocolError('invalid', 'Revision identity differs.');
          }
          // Assign only after dependencies pass: missing blobs retry even with no new filenames.
          if (!alreadyVerified) {
            sources.set(revision.id, await this.sources(revision, full));
            validate('policy', parseJson(await this.content(revision.policy, full), LIMITS.policy));
            await mapWithConcurrency(revision.resources, 4, r => this.content(r, full));
          }
          revisions.set(revision.id, revision);
        } catch (error) { problem(event.revisionPath, error); }
      });
      const nextAnchors = new Set<string>();
      let valid = (await mapWithConcurrency(all, 4, async event => {
        const revision = revisions.get(event.revisionId); if (!revision) return undefined;
        const key = digest(jsonBytes(event));
        try {
          if (full || !this.validatedAnchors.has(key)) {
            const source = sources.get(revision.id) ?? await this.sources(revision, full);
            sources.set(revision.id, source); validateAnchorEvent(event, revision, source);
          }
          nextAnchors.add(key); return event;
        } catch (error) { problem(event.id, error); return undefined; }
      })).filter((e): e is Event => !!e);
      this.validatedAnchors = nextAnchors;
      const receiptDependencies = new Map<string, string[]>(), invalidReceipts = new Set<string>();
      const exactEvents = new Map([...candidate.values()].map(f => [f.event.id, evidence(`events/${digest(f.bytes).slice(7)}.json`, f.bytes, 'application/json')]));
      await mapWithConcurrency(valid.filter(e => 'verification' in e || e.type === 'export.created'), 4, async event => {
        try {
          const key = digest(jsonBytes(event)), previous = !full && this.validatedReceipts.get(key);
          if (previous) { receiptDependencies.set(event.id, previous); return; }
          const reference = 'verification' in event ? { path: event.verification.blobPath, ...event.verification } : event.type === 'export.created' ? event.inventory : undefined;
          if (!reference) return;
          const raw = await this.readEvidence(reference, full), receipt = 'verification' in event ? validate('verification', parseJson(raw, LIMITS.inventory)) : validate('inventory', parseJson(raw, LIMITS.inventory));
          await this.checkReceipt(event, receipt, revisions, all, exactEvents, full);
          receiptDependencies.set(event.id, receipt.events.map(e => e.eventId));
          this.validatedReceipts.set(key, receipt.events.map(e => e.eventId));
        } catch (error) { problem(event.id, error); invalidReceipts.add(event.id); }
      });
      valid = valid.filter(e => !invalidReceipts.has(e.id));
      const graph = admit(valid, revisions, receiptDependencies); diagnostics.push(...graph.diagnostics);
      const graphIds = new Set(graph.events.map(e => e.id));
      for (const copy of copies) {
        const canonical = candidate.get(copy.canonical);
        if (canonical && canonical.event.id === copy.eventId && graphIds.has(copy.eventId)) diagnostics.push({ code: 'transport.duplicate', severity: 'warning', path: copy.path, message: 'Redundant exact-byte transport copy; the verified canonical event is counted once.' });
        else problem(copy.path, new ProtocolError('integrity', 'Noncanonical JSON has no verified canonical event counterpart.'));
      }
      // Failed candidates cannot become navigable heads.
      for (const e of publications) if (!graphIds.has(e.id)) revisions.delete(e.revisionId);
      this.files = candidate; this.events = graph.events; this.revisions = revisions;
      this.evidenceById = exactEvents;
      const presentKeys = new Set<string>(valid.map(e => digest(jsonBytes(e))));
      for (const key of this.validatedReceipts.keys()) if (!presentKeys.has(key)) this.validatedReceipts.delete(key);
    } catch (error) { problem(this.storage.identity, error); }
    this.diagnostics = diagnostics;
    if (full && diagnostics.some(d => d.severity === 'error')) throw new ProtocolError('integrity', diagnostics.map(d => `${d.path}: ${d.message}`).join('\n'));
  }
  async pin(id: string): Promise<void> {
    const revision = this.revisions.get(id); if (!revision) throw new ProtocolError('missing', 'Revision is not verified yet.');
    await this.sources(revision); await mapWithConcurrency(revision.resources, 4, r => this.content(r));
    this.pinnedRevisionId = id;
  }
  context(actor: ActorRef): ActionContext {
    const revision = this.revision, publication = this.events.find((e): e is Extract<Event, { type: 'revision.created' }> => e.type === 'revision.created' && e.revisionId === revision?.id);
    if (!revision || !publication) throw new ProtocolError('missing', 'Choose a verified revision first.');
    return Object.freeze({ session: this, revision, publication, actor: Object.freeze({ ...actor }) });
  }
  makeEvent(context: ActionContext, payload: Payload, operationId = newId('op')): Event {
    if (context.session !== this) throw new ProtocolError('invalid', 'Action belongs to another package session.');
    const event = validate('event', { ...payload, schemaVersion: '0.5.0', id: newId(), reviewId: this.manifest.reviewId, revisionId: context.revision.id, revisionDigest: context.publication.revisionDigest, occurredAt: new Date().toISOString(), actor: context.actor, operationId });
    if (jsonBytes(event).length > LIMITS.event) throw new ProtocolError('unsupported', 'Event exceeds 256 KiB.');
    return event;
  }
  async save(context: ActionContext, event: Event): Promise<void> {
    if (context.session !== this || event.revisionId !== context.revision.id || event.reviewId !== this.manifest.reviewId) throw new ProtocolError('invalid', 'Action context changed.');
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.refresh();
      if (!this.diagnostics.some(d => d.severity === 'error')) break;
      if (attempt === 2) throw new ProtocolError('integrity', 'Resolve package integrity/synchronization errors before saving. Your draft is retained.');
      // A peer may have created a digest target whose staged bytes are not yet
      // closed. Recheck briefly, without altering either file or our action ID.
      await new Promise(resolve => setTimeout(resolve, 75 * (attempt + 1)));
    }
    const existing = this.events.find(e => e.id === event.id);
    if (existing) { if (digest(jsonBytes(existing)) !== digest(jsonBytes(event))) throw new ProtocolError('integrity', 'Event ID collision.'); return; }
    validateAnchorEvent(event, context.revision, await this.sources(context.revision));
    if ('verification' in event || event.type === 'export.created') {
      const file = 'verification' in event ? { ...event.verification, path: event.verification.blobPath } : event.inventory;
      const raw = await this.readEvidence(file, true), receipt = 'verification' in event ? validate('verification', parseJson(raw, LIMITS.inventory)) : validate('inventory', parseJson(raw, LIMITS.inventory));
      const exact = new Map(this.events.map(e => [e.id, this.eventEvidence(e)]));
      await this.checkReceipt(event, receipt, this.revisions, this.events, exact, true);
      if ('verification' in event && JSON.stringify(receipt.events.map(e => e.eventId).sort(ascii)) !== JSON.stringify(this.events.map(e => e.id).sort(ascii))) throw new ProtocolError('changed', 'Observed review state changed after confirmation. Verify and confirm the new summary.');
    }
    const graph = admit([...this.events, event], this.revisions);
    if (graph.diagnostics.length) throw new ProtocolError('invalid', graph.diagnostics.map(d => d.message).join('\n'));
    const bytes = jsonBytes(event), file = evidence(`events/${digest(bytes).slice(7)}.json`, bytes, 'application/json');
    await publish(this.storage, event.operationId, file, bytes);
    await this.refresh();
  }
  async audit(context: ActionContext): Promise<CapturedAudit> {
    return this.exclusive(async () => {
      try {
      for (let attempt = 0; attempt < 3; attempt++) {
        // One fresh, bounded read per path in this verification attempt. Historical
        // receipts can reference the same file thousands of times without rereading SMB.
        this.auditReads = new Map();
        const before = (await this.storage.list('events')).filter(n => n.endsWith('.json')).sort();
        await this.scan(true);
        const bytes = new Map<string, Uint8Array>(), records = new Map<string, FileEvidence>();
        const read = async (file: FileEvidence) => {
          const actual = await this.readDisk(file.path, Math.max(file.byteLength, 1));
          if (digest(actual) !== file.digest || actual.length !== file.byteLength) throw new ProtocolError('integrity', `Audit input changed: ${file.path}`);
          bytes.set(file.path, actual); records.set(file.path, file);
        };
        await read(evidence('manifest.json', this.manifestBytes!, 'application/json'));
        for (const item of this.files.values()) await read(evidence(`events/${digest(item.bytes).slice(7)}.json`, item.bytes, 'application/json'));
        for (const r of this.revisions.values()) {
          const p = this.events.find((e): e is Extract<Event, { type: 'revision.created' }> => e.type === 'revision.created' && e.revisionId === r.id)!;
          const raw = await this.readDisk(p.revisionPath, LIMITS.revision);
          if (digest(raw) !== p.revisionDigest) throw new ProtocolError('integrity', 'Revision changed during audit.');
          bytes.set(p.revisionPath, raw); records.set(p.revisionPath, evidence(p.revisionPath, raw, 'application/json'));
          await mapWithConcurrency([...r.documents, ...r.resources, r.policy], 4, async c => { if (!records.has(c.blobPath)) await read({ path: c.blobPath, digest: c.digest, byteLength: c.byteLength, mediaType: c.mediaType }); });
        }
        for (const e of this.events) {
          if ('verification' in e) {
            const raw = await this.content(e.verification, true), v = validate('verification', parseJson(raw, LIMITS.inventory));
            await this.verifyReceipt(e, v, read);
          }
          if (e.type === 'export.created') {
            await read(e.pdf); await read(e.inventory);
            const v = validate('inventory', parseJson(bytes.get(e.inventory.path)!, LIMITS.inventory));
            if (v.exportId !== e.exportId || v.pdf.digest !== e.pdf.digest) throw new ProtocolError('integrity', 'Export inventory identity differs.');
            await this.verifyReceipt(e, v, read);
            for (const d of v.renderedDiagrams) await read(d.svg);
          }
        }
        const after = (await this.storage.list('events')).filter(n => n.endsWith('.json')).sort();
        if (JSON.stringify(before) !== JSON.stringify(after)) continue;
        const revision = this.revisions.get(context.revision.id);
        if (!revision) throw new ProtocolError('changed', 'Pinned revision is no longer verified.');
        const policy = validate('policy', parseJson(bytes.get(revision.policy.blobPath)!, LIMITS.policy));
        const unique = (files: FileEvidence[]) => [...new Map(files.map(f => [f.path, f])).values()].sort((a, b) => ascii(a.path, b.path));
        const revisions = [...this.revisions.values()];
        const inventory: Verification = {
          schemaVersion: '0.5.0', kind: 'verification-inventory', reviewId: this.manifest.reviewId, revisionId: revision.id, verifiedAt: new Date().toISOString(),
          manifest: records.get('manifest.json')!, revision: records.get(`revisions/${revision.id}.json`)!, policy: records.get(revision.policy.blobPath)!,
          contextRevisions: unique(revisions.filter(r => r.id !== revision.id).map(r => records.get(`revisions/${r.id}.json`)!)),
          documents: unique(revisions.flatMap(r => r.documents.map(d => records.get(d.blobPath)!))), resources: unique(revisions.flatMap(r => r.resources.map(d => records.get(d.blobPath)!))),
          events: this.events.map(e => ({ ...this.eventEvidence(e), eventId: e.id, revisionId: e.revisionId })).sort((a, b) => ascii(a.eventId, b.eventId)),
          policyResult: policyResult(policy, this.events, revision.id)
        };
        validate('verification', inventory);
        return { inventory, events: [...this.events], revision, manifest: this.manifest, bytes, frontier: digest(jsonBytes(inventory.events)), diagnostics: [...this.diagnostics] };
      }
      throw new ProtocolError('changed', 'The observed event set kept changing during audit. Try again.');
      } finally { this.auditReads = undefined; }
    });
  }
  private eventEvidence(event: Event): FileEvidence {
    const file = this.evidenceById.get(event.id);
    if (!file) throw new ProtocolError('integrity', 'Exact event evidence is unavailable.');
    return file;
  }
  private async readEvidence(file: FileEvidence, fresh: boolean): Promise<Uint8Array> {
    if (!Number.isSafeInteger(file.byteLength) || file.byteLength > (file.mediaType === 'application/pdf' ? LIMITS.pdf : LIMITS.inventory)) throw new ProtocolError('unsupported', 'Receipt file exceeds size limit.');
    let bytes = fresh ? undefined : this.cache.get(file.digest);
    if (!bytes) bytes = await this.readDisk(file.path, Math.max(1, file.byteLength));
    if (bytes.length !== file.byteLength || digest(bytes) !== file.digest) throw new ProtocolError('integrity', `Evidence digest mismatch: ${file.path}`);
    this.cache.set(file.digest, bytes); return bytes;
  }
  private async checkReceipt(event: Event, receipt: Verification | AuditInventory, revisions: ReadonlyMap<string, Revision>, events: readonly Event[], exactEvents: ReadonlyMap<string, FileEvidence>, fresh: boolean): Promise<void> {
    const fail = (message: string): never => { throw new ProtocolError('invalid', message); };
    const r = revisions.get(event.revisionId); if (!r) fail('Receipt revision is missing.');
    if (receipt.reviewId !== event.reviewId || receipt.revisionId !== event.revisionId || receipt.revision.digest !== event.revisionDigest || receipt.revision.path !== `revisions/${event.revisionId}.json` || receipt.manifest.path !== 'manifest.json' || receipt.manifest.digest !== digest(this.manifestBytes!) || receipt.policy.path !== r!.policy.blobPath || receipt.policy.digest !== r!.policy.digest) fail('Receipt does not bind the exact manifest, revision and policy.');
    const observed: Event[] = [];
    const byId = new Map(events.map(e => [e.id, e]));
    for (const item of receipt.events) {
      const actual = exactEvents.get(item.eventId), known = byId.get(item.eventId);
      if (!actual || !known || item.eventId === event.id || item.path !== actual.path || item.digest !== actual.digest || item.byteLength !== actual.byteLength || item.revisionId !== known.revisionId) fail('Receipt has an unknown, changed or self-referential event.');
      observed.push(known!);
    }
    if (!observed.some(e => e.type === 'revision.created' && e.revisionId === event.revisionId)) fail('Receipt omits its revision publication.');
    if (admit(observed, revisions).diagnostics.length) fail('Receipt observed events are not causally closed and valid.');
    const contextual = [...new Set(observed.map(e => e.revisionId))].filter(id => id !== r!.id);
    if (receipt.contextRevisions.length !== contextual.length || contextual.some(id => {
      const publication = observed.find(e => e.type === 'revision.created' && e.revisionId === id);
      return !publication || !receipt.contextRevisions.some(f => f.path === `revisions/${id}.json` && f.digest === publication.revisionDigest && f.mediaType === 'application/json');
    })) fail('Receipt context descriptors do not match observed revision publications.');
    for (const [items, required] of [[receipt.documents, r!.documents], [receipt.resources, r!.resources]] as const) for (const c of required) {
      if (!items.some(f => f.path === c.blobPath && f.digest === c.digest && f.byteLength === c.byteLength && f.mediaType === c.mediaType)) fail('Receipt omits required frozen content.');
    }
    const policy = validate('policy', parseJson(await this.content(r!.policy, fresh), LIMITS.policy));
    if (receipt.policyResult !== policyResult(policy, observed, r!.id)) fail('Receipt policy result does not match its observed events.');
    await mapWithConcurrency([receipt.manifest, receipt.revision, receipt.policy, ...receipt.contextRevisions, ...receipt.documents, ...receipt.resources, ...receipt.events], 4, f => this.readEvidence(f, fresh));
    if (event.type === 'export.created') {
      if (receipt.kind !== 'audit-export-inventory' || receipt.exportId !== event.exportId || receipt.pdf.digest !== event.pdf.digest || receipt.pdf.path !== event.pdf.path || receipt.pdf.byteLength !== event.pdf.byteLength || receipt.pdf.mediaType !== 'application/pdf' || JSON.stringify(receipt.renderer) !== JSON.stringify(event.renderer)) fail('Export identity or renderer differs.');
      const inventory = receipt as AuditInventory;
      const expected = observed.filter(e => e.revisionId === event.revisionId).map(e => e.id).sort(ascii);
      if (JSON.stringify([...inventory.representedEventIds].sort(ascii)) !== JSON.stringify(expected)) fail('Export omits selected-revision evidence.');
      if (inventory.renderedDiagrams.length !== r!.mermaidDiagrams.length || r!.mermaidDiagrams.some(d => !inventory.renderedDiagrams.some(i => i.diagramId === d.id && i.sourceDigest === d.sourceDigest))) fail('Export diagram inventory differs.');
      await this.readEvidence(event.pdf, fresh); for (const d of inventory.renderedDiagrams) await this.readEvidence(d.svg, fresh);
    }
  }
  private async verifyReceipt(event: Event, receipt: Verification | AuditInventory, read: (f: FileEvidence) => Promise<void>): Promise<void> {
    if (receipt.reviewId !== event.reviewId || receipt.revisionId !== event.revisionId || receipt.revision.digest !== event.revisionDigest || receipt.events.some(e => e.eventId === event.id)) throw new ProtocolError('invalid', 'Invalid verification inventory context/self-reference.');
    for (const e of receipt.events) {
      const known = this.events.find(item => item.id === e.eventId);
      if (!known || this.eventEvidence(known).digest !== e.digest) throw new ProtocolError('integrity', 'Receipt event dependency is missing or changed.');
    }
    await mapWithConcurrency([receipt.manifest, receipt.revision, receipt.policy, ...receipt.contextRevisions, ...receipt.documents, ...receipt.resources, ...receipt.events], 4, read);
  }
  async verificationBlob(audit: CapturedAudit, operationId: string): Promise<StoredContent> { return publishBlob(this.storage, `${operationId}_verification`, jsonBytes(audit.inventory), 'application/json'); }
}
