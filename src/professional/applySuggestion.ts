import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import path from 'node:path';
import { ActorRef, Event, LIMITS, ProtocolError, Sha256Digest } from './types';
import { digest, decode, encode, jsonBytes, offsetAt, parseJson } from './bytes';
import { contained, NativeStorage } from './nativeStorage';
import { ReviewSession } from './session';
import { fold } from './state';

export interface ApplyRequest { store: NativeStorage; source: string; revisionId: string; suggestionId: string; expectedSourceDigest: Sha256Digest; actor: ActorRef; operationId: string; resume?: boolean }
interface ApplyPlan { source: string; document: string; before: Sha256Digest; after: Sha256Digest; replacementBytes?: number[]; replacementBase64?: string; originalBase64?: string; event: Event }

/** Stage beside source, then replace its directory entry. Never stream over live Markdown. */
async function replaceSource(store: NativeStorage, plan: ApplyPlan, confirmAcceptance: () => Promise<void>): Promise<void> {
  const bytes = plan.replacementBase64 === undefined ? new Uint8Array(plan.replacementBytes ?? []) : new Uint8Array(Buffer.from(plan.replacementBase64, 'base64'));
  if (bytes.length > LIMITS.markdown || digest(bytes) !== plan.after || plan.originalBase64 !== undefined && digest(Buffer.from(plan.originalBase64, 'base64')) !== plan.before) throw new ProtocolError('integrity', 'Source recovery plan bytes do not match their recorded digests.');
  const name = `.omr-apply-${digest(`${plan.event.actor.id}\0${plan.event.operationId}\0${plan.document}`).slice(7, 39)}.pending`;
  const staged = path.posix.join(path.posix.dirname(plan.document), name);
  // The private durable plan authorizes only this operation's exact staging bytes.
  // Recovery rejects unrelated contents; partial staging never damages the source.
  let recover = false;
  try {
    const pending = await store.read(staged, LIMITS.markdown);
    if (pending.length > bytes.length || !pending.every((b, i) => b === bytes[i])) throw new ProtocolError('integrity', 'Source staging file has unrelated bytes. It was not overwritten.');
    recover = true;
  } catch (error) { if (!(error instanceof ProtocolError) || error.code !== 'missing') throw error; }
  await store.write(staged, bytes, recover);
  const target = await contained(store.root, plan.document), handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let mode: number;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new ProtocolError('unsupported', 'Source application requires a regular, non-hard-linked Markdown file.');
    if (digest(await handle.readFile()) !== plan.before) throw new ProtocolError('changed', 'Source changed before save. It was not overwritten.');
    mode = info.mode & 0o777;
  } finally { await handle.close(); }
  const stagePath = await contained(store.root, staged), stageHandle = await open(stagePath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    if (digest(await stageHandle.readFile()) !== plan.after) throw new ProtocolError('integrity', 'Staged source changed before replacement.');
    await stageHandle.chmod(mode); await stageHandle.sync();
  } finally { await stageHandle.close(); }
  await confirmAcceptance();
  if (digest(await store.read(plan.document, LIMITS.markdown)) !== plan.before) throw new ProtocolError('changed', 'Source changed before replacement. It was not overwritten.');
  await contained(store.root, staged); await contained(store.root, plan.document);
  await rename(stagePath, target);
  // POSIX directory sync makes the rename durable. Node cannot open a Windows
  // directory for this operation; Windows/SMB durability is qualified in CI.
  if (process.platform !== 'win32') {
    const directory = await open(path.dirname(target), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
/** Source mutation is author-only, explicitly guarded and separate from review evidence. */
export async function applyAcceptedSuggestion(request: ApplyRequest): Promise<{ event: Event; outcome: 'completed' | 'already-completed' }> {
  const session = new ReviewSession(request.store); await session.open(); await session.pin(request.revisionId);
  const context = session.context(request.actor); await session.audit(context);
  const existing = session.events.find(e => e.operationId === request.operationId && e.actor.id === request.actor.id);
  if (existing) {
    if (existing.type !== 'suggestion.applied' || existing.suggestionId !== request.suggestionId || existing.revisionId !== request.revisionId || existing.sourceDigestBefore !== request.expectedSourceDigest) throw new ProtocolError('changed', 'Operation ID already belongs to another action.');
    return { event: existing, outcome: 'already-completed' };
  }
  const journalKey = `apply:${request.operationId}`, saved = await request.store.journalGet(journalKey);
  let plan: ApplyPlan;
  if (saved) {
    if (!request.resume) throw new ProtocolError('changed', 'An application recovery plan exists. Retry with --resume.');
    plan = parseJson<ApplyPlan>(new Uint8Array(saved.bytes), LIMITS.markdown * 6);
    if (plan.source !== request.source || plan.before !== request.expectedSourceDigest || plan.event.revisionId !== request.revisionId || !('suggestionId' in plan.event) || plan.event.suggestionId !== request.suggestionId || plan.event.actor.id !== request.actor.id) throw new ProtocolError('changed', 'Application resume parameters differ.');
  } else {
    const suggestion = fold(session.events, request.revisionId).suggestions.find(s => s.root.suggestionId === request.suggestionId);
    if (!suggestion || suggestion.status !== 'accepted') throw new ProtocolError('invalid', 'Only an unambiguously accepted, unapplied suggestion can change source.');
    const anchor = suggestion.root.anchor, sourceStore = new NativeStorage(request.source, request.store.journalRoot), bytes = await sourceStore.read(anchor.document, LIMITS.markdown);
    if (digest(bytes) !== request.expectedSourceDigest || digest(bytes) !== anchor.documentDigest) throw new ProtocolError('changed', 'Source differs from the selected frozen revision / expected digest. Create a new revision or reconcile it explicitly.');
    const source = decode(bytes), start = offsetAt(source, anchor.range.start), end = offsetAt(source, anchor.range.end);
    if (source.slice(start, end) !== anchor.quote.exact) throw new ProtocolError('changed', 'Suggested source range no longer matches.');
    const op = suggestion.root.operation;
    const replacement = op.kind === 'delete' ? '' : op.kind === 'replace' ? op.replacement : op.position === 'before' ? op.replacement + source.slice(start, end) : source.slice(start, end) + op.replacement;
    const changed = encode(source.slice(0, start) + replacement + source.slice(end));
    const event = session.makeEvent(context, { type: 'suggestion.applied', suggestionId: request.suggestionId, document: anchor.document, sourceDigestBefore: digest(bytes), sourceDigestAfter: digest(changed), acceptanceIds: suggestion.decision.heads.map(e => e.id) }, request.operationId);
    if (changed.length > LIMITS.markdown) throw new ProtocolError('unsupported', 'Suggested edit would exceed the Markdown byte limit.');
    plan = { source: request.source, document: anchor.document, before: digest(bytes), after: digest(changed), replacementBase64: Buffer.from(changed).toString('base64'), originalBase64: Buffer.from(bytes).toString('base64'), event };
    await request.store.journalPut(journalKey, { path: anchor.document, bytes: Array.from(jsonBytes(plan)), acknowledged: false });
  }
  const sourceStore = new NativeStorage(request.source, request.store.journalRoot), current = await sourceStore.read(plan.document, LIMITS.markdown);
  if (digest(current) !== plan.after) {
    if (digest(current) !== plan.before) throw new ProtocolError('changed', 'Source changed since application was prepared. It was not overwritten.');
    const confirmAcceptance = async () => {
      await session.refresh(true);
      if (session.diagnostics.some(d => d.severity === 'error')) throw new ProtocolError('integrity', 'Review has incomplete or invalid evidence. Source was not replaced.');
      const latest = fold(session.events, request.revisionId).suggestions.find(s => s.root.suggestionId === request.suggestionId);
      if (!latest || latest.status !== 'accepted' || plan.event.type !== 'suggestion.applied' || JSON.stringify(latest.decision.heads.map(e => e.id).sort()) !== JSON.stringify([...plan.event.acceptanceIds].sort())) throw new ProtocolError('changed', 'Suggestion acceptance changed while preparing source application.');
    };
    await confirmAcceptance();
    try { await replaceSource(sourceStore, plan, confirmAcceptance); }
    catch (error) {
      if (error instanceof ProtocolError && error.code !== 'uncertain') throw error;
      throw new ProtocolError('uncertain', `Source replacement was interrupted. Retry the same operation with --resume; exact before/after bytes will be checked. ${String(error)}`);
    }
  }
  if (digest(await sourceStore.read(plan.document, LIMITS.markdown)) !== plan.after) throw new ProtocolError('uncertain', 'Persisted source did not match the application evidence. Recovery is required.');
  try { await session.save(context, plan.event); }
  catch (error) { throw new ProtocolError('uncertain', `Source was saved, but application evidence is still pending. Retry this operation with --resume; do not apply the edit again. ${String(error)}`); }
  await request.store.journalPut(journalKey, { path: plan.document, bytes: Array.from(jsonBytes(plan)), acknowledged: true });
  return { event: plan.event, outcome: 'completed' };
}
