import { BrowserStorage, localValue } from './browserStorage';
import { ReviewSession, ActionContext } from './session';
import { JournalEntry, Storage } from './storage';
import { ActorRef, Event, LIMITS, MarkdownAnchor, Payload, ProtocolError } from './types';
import { decode, digest, jsonBytes, newId, parseJson, pointAt } from './bytes';
import { fold, predecessors } from './state';
import { annotate, escapeHtml as esc, renderDocument, RenderedSource, selectionAnchor } from './rendering';
import { dataUrl, populateAssets } from './assets';
import { exportAudit } from './export';

declare global {
  interface Window {
    acquireVsCodeApi?: () => { postMessage(message: unknown): void };
    omrHost?: (method: string, args: unknown[]) => Promise<unknown>;
    omrAutomation?: { connect(): Promise<void>; export(actor: ActorRef, revision: string, operationId: string): Promise<unknown>; session(): ReviewSession | undefined };
  }
}
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => { const el = document.getElementById(id); if (!el) throw new Error(`Missing UI element ${id}`); return el as T; };
const sessions = new Map<string, ReviewSession>(); let current: ReviewSession | undefined;
let activeDocument = '', source = '', rendered: RenderedSource | undefined, renderKey = '', semantic: HTMLElement | undefined;
let remembered: { root: FileSystemDirectoryHandle; reviewId: string; manifestDigest: string } | undefined;
let polling = false, nextPoll: number | undefined, generation = 0;
let lastStateKey = '';
let lastChromeKey = '';
let discussionLimit = 50, historyLimit = 100;
let canApply = false, externalAnchor: MarkdownAnchor | undefined;
let exportBusy = false;
function status(message: string, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function toast(message: string) { $('toast').textContent = message; $('toast').classList.add('visible'); setTimeout(() => $('toast').classList.remove('visible'), 4500); }
function report(error: unknown) { status(error instanceof Error ? error.message : String(error), true); }
const safely = (work: () => Promise<unknown>) => { void work().catch(report); };
function identity(): ActorRef { const id = $<HTMLInputElement>('actor-id').value.trim(), displayName = $<HTMLInputElement>('actor-name').value.trim(); if (!id) { $('actor-id').focus(); throw new Error('Enter your reviewer ID first. It will be written to each event.'); } try { localStorage.setItem('omr.identity', JSON.stringify({ id, displayName })); } catch { /* Identity remains usable in memory. */ } return { id, ...(displayName ? { displayName } : {}) }; }
function context(): ActionContext { if (!current) throw new Error('Open a review first.'); return current.context(identity()); }
function progress() {
  if (!current) return;
  if (current.diagnostics.length) status(`${current.diagnostics.some(d => d.severity === 'error') ? 'Review is not fully synchronized or valid.' : 'Review has nonblocking notices.'}\n${current.diagnostics.slice(0, 4).map(d => `${d.path}: ${d.message}`).join('\n')}`, current.diagnostics.some(d => d.severity === 'error'));
  else status(`${current.storage.writable ? 'Live shared-folder review' : 'Read-only review'} · ${current.events.length} verified events · ${current.heads.length > 1 ? `${current.heads.length} competing revision heads — choose explicitly` : 'revision stays pinned until you change it'}`);
}
function chrome() {
  if (!current) return;
  const key = `${current.storage.identity}:${activeDocument}:${current.pinnedRevisionId}:${[...current.revisions.keys()].join(',')}:${[...sessions.keys()].join(',')}`;
  if (key === lastChromeKey) { progress(); return; }
  lastChromeKey = key;
  $('title').textContent = current.manifest.title; $('welcome').hidden = true; $('toolbar').hidden = false; $('workspace').hidden = false;
  $('reviews').innerHTML = [...sessions.entries()].map(([key, session]) => `<option value="${esc(key)}" ${session === current ? 'selected' : ''}>${esc(session.manifest.title)}</option>`).join('');
  $('revisions').innerHTML = `${!current.revision ? '<option value="">Choose a revision…</option>' : ''}${[...current.revisions.values()].map(r => `<option value="${r.id}" ${r.id === current!.pinnedRevisionId ? 'selected' : ''}>${r.id}${current!.heads.some(h => h.id === r.id) ? ' · head' : ' · history'}</option>`).join('')}`;
  const revision = current.revision;
  if (revision) {
    if (!revision.documents.some(d => d.path === activeDocument)) activeDocument = revision.rootDocument;
    $('documents').innerHTML = revision.documents.map(d => `<li><button data-document="${esc(d.path)}" class="${d.path === activeDocument ? 'active' : ''}">${esc(d.path)}</button></li>`).join('');
  }
  for (const id of ['comment', 'suggest', 'approve', 'reject', 'withdraw', 'export']) $<HTMLButtonElement>(id).disabled = !revision || !current.storage.writable || id === 'export' && exportBusy;
  progress();
}
function stateView() {
  if (!current?.revision) return;
  const openOnly = $<HTMLInputElement>('open-only').checked, query = $<HTMLInputElement>('discussion-search').value.trim().toLocaleLowerCase();
  const stateKey = `${current.storage.identity}:${current.revision.id}:${activeDocument}:${openOnly}:${query}:${discussionLimit}:${historyLimit}:${renderKey}:${current.events.map(e => e.id).join(',')}`;
  if (stateKey === lastStateKey) return;
  lastStateKey = stateKey;
  const focused = document.activeElement as HTMLElement | null;
  const restoreFocus = focused?.closest('#threads, #suggestions') && focused instanceof HTMLButtonElement ? { action: focused.dataset.action, thread: focused.dataset.thread, suggestion: focused.dataset.suggestion } : undefined;
  const state = fold(current.events, current.revision.id);
  const matchingThreads = state.threads.filter(t => (!openOnly || t.open) && (!query || JSON.stringify(t).toLocaleLowerCase().includes(query)));
  const matchingSuggestions = state.suggestions.filter(s => (!openOnly || s.open) && (!query || JSON.stringify(s).toLocaleLowerCase().includes(query)));
  $('summary').innerHTML = `<h2>Revision summary</h2><p>${state.threads.filter(t => t.open).length} open concerns<br>${state.suggestions.filter(t => t.open).length} unfinished edits<br>${state.stances.filter(s => !s.conflict && s.heads[0]?.type === 'review.approved').length} current approvals</p>`;
  $('threads').innerHTML = matchingThreads.slice(0, discussionLimit).map(t => `<article class="thread ${t.open ? '' : 'closed'}" id="thread-${t.root.threadId}"><h3>${esc(t.root.actor.displayName ?? t.root.actor.id)} <span class="badge">${t.open ? 'open' : 'resolved'}${t.status.conflict || t.decision.conflict ? ' · conflict' : ''}</span></h3><button data-action="locate" data-thread="${t.root.threadId}">${esc(t.root.anchor.document)}:${t.root.anchor.range.start.line + 1}</button><blockquote>${esc(t.root.anchor.quote.exact)}</blockquote><p>${esc(t.root.body.text)}</p>${t.replies.map(e => e.type === 'comment.replied' ? `<div class="reply"><strong>${esc(e.actor.displayName ?? e.actor.id)}</strong><p>${esc(e.body.text)}</p></div>` : '').join('')}<p class="badge">${t.decision.heads.map(e => e.type === 'thread.decided' ? esc(e.decision + (e.reason ? ': ' + e.reason : '')) : '').join(' / ')}</p><div class="buttons"><button data-action="reply" data-thread="${t.root.threadId}">Reply</button><button data-action="decide" data-thread="${t.root.threadId}">Decide</button><button data-action="${t.open ? 'resolve' : 'reopen'}" data-thread="${t.root.threadId}">${t.open ? 'Resolve' : 'Reopen'}</button></div></article>`).join('') || '<p>No matching comments.</p>';
  $('suggestions').innerHTML = matchingSuggestions.slice(0, discussionLimit).map(s => `<article class="suggestion" id="suggestion-${s.root.suggestionId}"><h3>${esc(s.root.operation.kind)} · ${esc(s.status)}</h3><blockquote>${s.root.operation.kind === 'insert' ? esc(s.root.anchor.quote.exact) : `<del>${esc(s.root.anchor.quote.exact)}</del>`}${s.root.operation.kind !== 'delete' ? `<ins>${esc(s.root.operation.replacement)}</ins>` : ''}</blockquote><p>${esc(s.root.rationale.text)}</p><div class="buttons"><button data-suggestion="${s.root.suggestionId}" data-action="accept-suggestion">Accept</button><button data-suggestion="${s.root.suggestionId}" data-action="reject-suggestion">Reject</button></div></article>`).join('') || '<p>No suggested edits.</p>';
  $('history').innerHTML = state.current.slice(-historyLimit).reverse().map(e => `<div class="history-item"><strong>${esc(e.type)}</strong><br>${esc(e.actor.displayName ?? e.actor.id)} · ${esc(e.occurredAt)}<details><summary>Full event and reasons</summary><pre>${esc(JSON.stringify(e, null, 2))}</pre></details></div>`).join('');
  $('more-discussions').hidden = Math.max(matchingThreads.length, matchingSuggestions.length) <= discussionLimit;
  $('more-history').hidden = state.current.length <= historyLimit;
  $('discussion-count').textContent = `${matchingThreads.length} comments · ${matchingSuggestions.length} edits${query ? ' matching search' : ''}`;
  if (rendered) annotate($('document'), rendered, source, state.current, activeDocument);
  for (const section of document.querySelectorAll<HTMLElement>('.thread .buttons, .suggestion .buttons')) for (const button of section.querySelectorAll<HTMLButtonElement>('button')) button.disabled = !current.storage.writable;
  if (canApply) for (const suggestion of state.suggestions.filter(s => s.status === 'accepted')) {
    const actions = $('suggestions').querySelector<HTMLElement>(`[data-suggestion="${suggestion.root.suggestionId}"]`)?.parentElement;
    if (actions) { const button = document.createElement('button'); button.dataset.suggestion = suggestion.root.suggestionId; button.dataset.action = 'apply-suggestion'; button.textContent = 'Apply to source…'; actions.append(button); }
  }
  if (restoreFocus) {
    const target = [...document.querySelectorAll<HTMLButtonElement>('#threads button, #suggestions button')].find(b => b.dataset.action === restoreFocus.action && b.dataset.thread === restoreFocus.thread && b.dataset.suggestion === restoreFocus.suggestion);
    target?.focus({ preventScroll: true });
  }
}
async function showDocument() {
  const session = current, revision = session?.revision, selected = activeDocument, epoch = generation;
  if (!session || !revision || !selected) return;
  const key = `${session.storage.identity}:${revision.id}:${selected}`;
  if (key === renderKey) { stateView(); return; }
  status(`Loading ${selected}…`);
  const doc = revision.documents.find(d => d.path === selected)!; const text = decode(await session.content(doc));
  const render = renderDocument(text, selected, revision), host = document.createElement('article'); host.innerHTML = render.html;
  await populateAssets(host, revision, c => session.content(c));
  for (const figure of host.querySelectorAll<HTMLElement>('[data-diagram-id]')) { const zoom = document.createElement('button'); zoom.dataset.zoom = figure.dataset.diagramId; zoom.textContent = 'Zoom diagram'; figure.append(zoom); }
  if (session !== current || selected !== activeDocument || epoch !== generation || revision.id !== current.revision?.id) return;
  source = text; rendered = render; renderKey = key; semantic = undefined;
  $('document').replaceChildren(...host.childNodes); stateView(); progress();
}
async function activate(session: ReviewSession) { generation++; lastChromeKey = ''; discussionLimit = 50; historyLimit = 100; current = session; renderKey = ''; lastStateKey = ''; activeDocument = session.revision?.rootDocument ?? ''; chrome(); await showDocument(); schedulePoll(); }
async function attach(storage: Storage, expected?: { reviewId: string; manifestDigest: string }): Promise<ReviewSession> {
  const session = new ReviewSession(storage); await session.open();
  if (expected && (session.manifest.reviewId !== expected.reviewId || digest(await storage.read('manifest.json', LIMITS.manifest)) !== expected.manifestDigest)) throw new Error('Remembered folder now contains a different review. Choose it explicitly to connect.');
  sessions.set(storage.identity, session); await activate(session); return session;
}
async function choose(readOnly = false) {
  if (!window.showDirectoryPicker) throw new Error('This browser cannot read/write a chosen folder. Use supported Edge/Chrome, or VS Code.');
  const root = await window.showDirectoryPicker({ mode: readOnly ? 'read' : 'readwrite' });
  const preliminary = new BrowserStorage(root, 'opening', !readOnly);
  const manifest = parseJson<{ reviewId: string }>(await preliminary.read('manifest.json', LIMITS.manifest), LIMITS.manifest);
  const storage = new BrowserStorage(root, manifest.reviewId, !readOnly), session = await attach(storage);
  remembered = { root, reviewId: session.manifest.reviewId, manifestDigest: digest(await storage.read('manifest.json', LIMITS.manifest)) };
  try { await localValue(`connection:${location.href}`, remembered); } catch { toast('Review is open. This browser could not remember its folder permission.'); }
}
function schedulePoll() { if (nextPoll) clearTimeout(nextPoll); nextPoll = window.setTimeout(() => safely(refresh), document.hidden ? 15000 : 3000); }
async function refresh() {
  if (polling || !current) { schedulePoll(); return; }
  const session = current; polling = true;
  try { await session.refresh(); if (current === session) { chrome(); stateView(); } } finally { polling = false; schedulePoll(); }
}
interface ComposeOptions { title: string; label: string; required?: boolean; choices?: string[]; replacement?: boolean; submit: (text: string, choice: string, replacement: string) => Promise<void> }
function compose(ctx: ActionContext, options: ComposeOptions) {
  const dialog = $<HTMLDialogElement>('composer'); if (dialog.open) throw new Error('Finish or cancel the current draft first.');
  $('composer-title').textContent = options.title; $('composer-context').textContent = `${ctx.session.manifest.title} · ${ctx.revision.id} · ${ctx.actor.id}. This action stays on this revision.`;
  $('body-label').textContent = options.label; $<HTMLTextAreaElement>('body').value = ''; $<HTMLTextAreaElement>('body').required = !!options.required;
  $('choice-label').hidden = !options.choices; $('choice').innerHTML = (options.choices ?? []).map(c => `<option>${esc(c)}</option>`).join('');
  $('replacement-label').hidden = !options.replacement; $<HTMLTextAreaElement>('replacement').value = ''; $('composer-error').textContent = '';
  dialog.showModal(); $('body').focus();
  dialog.querySelector('form')!.onsubmit = async event => {
    event.preventDefault(); const save = $<HTMLButtonElement>('save'); if (save.disabled) return;
    save.disabled = true; save.textContent = 'Saving…'; $('composer-error').textContent = '';
    try {
      await options.submit($<HTMLTextAreaElement>('body').value, $<HTMLSelectElement>('choice').value, $<HTMLTextAreaElement>('replacement').value);
      dialog.close(); toast(`Saved to ${ctx.session.manifest.title} · ${ctx.revision.id}`); if (current === ctx.session) { chrome(); stateView(); }
    } catch (error) { $('composer-error').textContent = `${error instanceof Error ? error.message : String(error)} Your draft is still here.`; }
    finally { save.disabled = false; save.textContent = 'Save event'; }
  };
}
function eventComposer(ctx: ActionContext, options: Omit<ComposeOptions, 'submit'>, build: (text: string, choice: string, replacement: string) => Payload) {
  let event: Event | undefined, fingerprint: string | undefined;
  compose(ctx, { ...options, submit: async (text, choice, replacement) => {
    const now = JSON.stringify([text, choice, replacement]);
    if (event && now !== fingerprint) throw new Error('This action may already be partially saved. Retry the original text before starting another action.');
    if (!event) { event = ctx.session.makeEvent(ctx, build(text, choice, replacement)); fingerprint = now; }
    await ctx.session.save(ctx, event);
  } });
}
function comment(suggest = false) {
  const ctx = context(); if (!rendered) throw new Error('Wait for the document to finish rendering.');
  const selection = document.getSelection(), hasTextSelection = !!selection && !selection.isCollapsed && $('document').contains(selection.anchorNode) && $('document').contains(selection.focusNode);
  const anchor = externalAnchor ?? selectionAnchor($('document'), rendered, source, activeDocument, ctx.revision, hasTextSelection ? undefined : semantic); externalAnchor = undefined;
  if (!ctx.revision.documents.some(d => d.path === anchor.document && d.digest === anchor.documentDigest)) throw new Error('Source selection differs from the frozen revision. Select the frozen review text or create a new revision.');
  if (suggest && anchor.target?.kind !== 'text') throw new Error('Select text to suggest an insertion, replacement or strikeout.');
  eventComposer(ctx, { title: suggest ? 'Suggest an edit' : 'Comment on selection', label: suggest ? 'Rationale' : 'Comment', required: true, ...(suggest ? { choices: ['delete', 'replace', 'insert-before', 'insert-after'], replacement: true } : {}) }, (text, choice, replacement) => suggest
    ? { type: 'suggestion.created', suggestionId: newId('suggestion'), anchor, rationale: { format: 'markdown', text }, operation: choice === 'delete' ? { kind: 'delete' } : choice === 'replace' ? { kind: 'replace', replacement } : { kind: 'insert', position: choice === 'insert-before' ? 'before' : 'after', replacement } }
    : { type: 'comment.created', threadId: newId('thread'), commentId: newId('comment'), anchor, body: { format: 'markdown', text } });
}
async function stance(type: 'review.approved' | 'review.rejected' | 'review.withdrawn') {
  const ctx = context(), state = fold(ctx.session.events, ctx.revision.id), observed = state.register(`stance:${ctx.revision.id}:${ctx.actor.id}`).heads.map(e => e.id);
  if (type === 'review.withdrawn' && !observed.length) throw new Error('You have no previous stance on this revision to withdraw.');
  let confirmedFrontier: string | undefined, prepared: Event | undefined, preparedText: string | undefined;
  compose(ctx, { title: type === 'review.approved' ? 'Approve pinned revision' : type === 'review.rejected' ? 'Reject pinned revision' : 'Withdraw your stance', label: 'Reason / note', required: type !== 'review.approved', submit: async text => {
    if (prepared) {
      if (text !== preparedText) throw new Error('This pending assertion may already be partially saved. Retry its original reason before creating another action.');
      try { await ctx.session.save(ctx, prepared); return; }
      catch (error) { if (error instanceof ProtocolError && error.code === 'changed') { prepared = undefined; confirmedFrontier = undefined; } throw error; }
    }
    status('Verifying exact shared files before the decision…');
    const audit = await ctx.session.audit(ctx);
    if (confirmedFrontier !== audit.frontier) {
      confirmedFrontier = audit.frontier;
      const summary = fold(audit.events, ctx.revision.id);
      throw new Error(`Verified ${audit.events.length} events, ${summary.threads.filter(t => t.open).length} open concerns and ${summary.suggestions.filter(s => s.open).length} unfinished edits. Policy: ${audit.inventory.policyResult}. Press Save event again to confirm this observed state.`);
    }
    const op = newId('op'), verification = await ctx.session.verificationBlob(audit, op);
    const stancePredecessors = fold(audit.events, ctx.revision.id).register(`stance:${ctx.revision.id}:${ctx.actor.id}`).heads.map(e => e.id);
    preparedText = text;
    prepared = ctx.session.makeEvent(ctx, type === 'review.approved' ? { type, stancePredecessors, verification, ...(text.trim() ? { note: text } : {}) } : { type, stancePredecessors, verification, reason: text }, op);
    try { await ctx.session.save(ctx, prepared); }
    catch (error) { if (error instanceof ProtocolError && error.code === 'changed') { prepared = undefined; confirmedFrontier = undefined; } throw error; }
  } });
}
async function action(button: HTMLButtonElement) {
  const ctx = context(), state = fold(ctx.session.events, ctx.revision.id), thread = state.threads.find(t => t.root.threadId === button.dataset.thread), suggestion = state.suggestions.find(s => s.root.suggestionId === button.dataset.suggestion), action = button.dataset.action;
  if (action === 'locate' && thread) { activeDocument = thread.root.anchor.document; chrome(); await showDocument(); const target = $('document').querySelector<HTMLElement>(`[data-thread-ids~="${thread.root.threadId}"]`); if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' }); else toast('The anchor cannot be located in this rendering. The exact source quote is shown in the discussion.'); return; }
  if (thread) {
    const threadId = thread.root.threadId;
    if (action === 'reply') eventComposer(ctx, { title: 'Reply to comment', label: 'Reply', required: true }, text => ({ type: 'comment.replied', threadId, commentId: newId('comment'), inReplyTo: thread.root.commentId, body: { format: 'markdown', text } }));
    if (action === 'decide') eventComposer(ctx, { title: 'Decide comment', label: 'Reason (required unless accepted)', choices: ['accepted', 'rejected', 'wont-fix', 'duplicate'] }, (text, decision) => ({ type: 'thread.decided', threadId, decision: decision as 'accepted', reason: text, decisionPredecessors: thread.decision.heads.map(e => e.id) }));
    if (action === 'resolve') eventComposer(ctx, { title: 'Resolve concern', label: 'Resolution note' }, note => ({ type: 'thread.resolved', threadId, note, statusPredecessors: thread.status.heads.map(e => e.id) }));
    if (action === 'reopen') eventComposer(ctx, { title: 'Reopen concern', label: 'Reason', required: true }, reason => ({ type: 'thread.reopened', threadId, reason, statusPredecessors: thread.status.heads.map(e => e.id) }));
  }
  if (suggestion && action === 'apply-suggestion') { if (!rpc || !canApply) throw new Error('Source application is an author-only capability.'); await rpc('applySuggestion', [ctx.revision.id, suggestion.root.suggestionId, newId('apply')]); await ctx.session.refresh(); if (current === ctx.session) stateView(); return; }
  if (suggestion) eventComposer(ctx, { title: action === 'accept-suggestion' ? 'Accept suggested edit' : 'Reject suggested edit', label: 'Reason / note', required: action !== 'accept-suggestion' }, text => action === 'accept-suggestion' ? { type: 'suggestion.accepted', suggestionId: suggestion.root.suggestionId, note: text, decisionPredecessors: suggestion.decision.heads.map(e => e.id) } : { type: 'suggestion.rejected', suggestionId: suggestion.root.suggestionId, reason: text, decisionPredecessors: suggestion.decision.heads.map(e => e.id) });
}
function installHostRpc(): ((method: string, args: unknown[]) => Promise<unknown>) | undefined {
  if (window.omrHost) return async (method, args) => {
    const response = await window.omrHost!(method, args) as { ok: boolean; value?: unknown; code?: ProtocolError['code']; error?: string };
    if (!response.ok) throw new ProtocolError(response.code ?? 'uncertain', response.error ?? 'Host request failed.');
    return response.value;
  };
  if (!window.acquireVsCodeApi) return;
  const vscode = window.acquireVsCodeApi(), pending = new Map<string, { resolve(value: unknown): void; reject(reason: unknown): void }>();
  window.addEventListener('message', e => { const message = e.data; const request = pending.get(message?.id); if (!request) return; pending.delete(message.id); if (message.error) request.reject(new ProtocolError(message.code ?? 'uncertain', message.error)); else request.resolve(message.value); });
  return (method, args) => new Promise((resolve, reject) => { const id = newId('rpc'); pending.set(id, { resolve, reject }); vscode.postMessage({ id, method, args }); });
}
const rpc = installHostRpc();
async function connectHost() {
  if (!rpc) throw new Error('Native bridge is unavailable.');
  const metadata = await rpc('info', []) as { identity: string; writable: boolean; canApply?: boolean };
  canApply = !!metadata.canApply;
  const storage: Storage = { ...metadata, read: async (p, l) => new Uint8Array(await rpc('read', [p, l]) as number[]), list: async p => await rpc('list', [p]) as string[], write: async (p, b, r) => { await rpc('write', [p, Array.from(b), r]); }, journalGet: async o => await rpc('journalGet', [o]) as JournalEntry | undefined, journalPut: async (o, e) => { await rpc('journalPut', [o, e]); } };
  await attach(storage);
}
async function exportFromToolbox() {
  if (exportBusy) return;
  const ctx = context(), key = `export-ui:${digest(`${ctx.revision.id}\0${ctx.actor.id}`).slice(7)}`;
  exportBusy = true; $<HTMLButtonElement>('export').disabled = true;
  try {
    // The pointer is private recovery metadata, not another source of review state.
    // A reload/retry uses the same captured plan after an uncertain publication.
    const prior = await ctx.session.storage.journalGet(key);
    const operationId = prior && !prior.acknowledged ? parseJson<{ operationId: string }>(new Uint8Array(prior.bytes)).operationId : newId('export');
    const pointer = { path: 'exports', bytes: Array.from(jsonBytes({ operationId })), acknowledged: false };
    await ctx.session.storage.journalPut(key, pointer);
    status('Verifying and exporting every document, comment and response…');
    const result = await exportAudit(ctx, undefined, operationId);
    await ctx.session.storage.journalPut(key, { ...pointer, acknowledged: true });
    toast(`Saved ${result.pdfPath} and its audit inventory.`);
    if (current === ctx.session) stateView();
  } catch (error) { throw new Error(`Export did not finish. Click Export again to resume the same export safely. ${String(error)}`); }
  finally { exportBusy = false; lastChromeKey = ''; chrome(); }
}
for (const [id, fn] of Object.entries({ connect: () => choose(), another: () => choose(), 'read-only': () => choose(true), refresh, comment: async () => comment(), suggest: async () => comment(true), approve: () => stance('review.approved'), reject: () => stance('review.rejected'), withdraw: () => stance('review.withdrawn'), export: exportFromToolbox })) $(id).addEventListener('click', () => safely(fn));
$('cancel').addEventListener('click', () => $<HTMLDialogElement>('composer').close());
$('open-only').addEventListener('change', stateView);
$('discussion-search').addEventListener('input', () => { discussionLimit = 50; stateView(); });
$('more-discussions').addEventListener('click', () => { discussionLimit += 50; stateView(); });
$('more-history').addEventListener('click', () => { historyLimit += 100; stateView(); });
$('documents').addEventListener('click', e => { const button = (e.target as Element).closest<HTMLElement>('[data-document]'); if (button) safely(async () => { activeDocument = button.dataset.document!; chrome(); await showDocument(); }); });
$('reviews').addEventListener('change', () => safely(() => activate(sessions.get($<HTMLSelectElement>('reviews').value)!)));
$('revisions').addEventListener('change', () => safely(async () => { await current!.pin($<HTMLSelectElement>('revisions').value); activeDocument = current!.revision!.rootDocument; chrome(); await showDocument(); }));
for (const id of ['threads', 'suggestions']) $(id).addEventListener('click', e => { const button = (e.target as Element).closest<HTMLButtonElement>('button[data-action]'); if (button) safely(() => action(button)); });
$('document').addEventListener('click', e => {
  const zoom = (e.target as Element).closest<HTMLElement>('[data-zoom]');
  if (zoom) {
    const svg = zoom.parentElement?.querySelector('svg'); if (!svg) return;
    const clone = svg.cloneNode(true) as SVGElement; clone.style.maxWidth = 'none'; clone.style.width = '800px'; clone.style.height = 'auto';
    $('zoom-content').replaceChildren(clone); $<HTMLInputElement>('zoom-scale').value = '100'; $<HTMLDialogElement>('diagram-viewer').showModal(); return;
  }
  const target = e.target as Element, attachment = target.closest<HTMLElement>('[data-attachment]');
  if (attachment && current?.revision) { e.preventDefault(); const session = current, resource = session.revision!.resources.find(r => r.id === attachment.dataset.attachment)!; safely(async () => { const bytes = await session.content(resource), a = document.createElement('a'); a.href = dataUrl(bytes, 'application/octet-stream'); a.download = resource.originalReference.split('/').at(-1)?.split(/[?#]/)[0] || 'attachment'; a.click(); }); return; }
  const link = target.closest<HTMLElement>('[data-document-link]');
  if (link) { e.preventDefault(); const raw = link.dataset.documentLink!, parts = raw.split('#'); safely(async () => { if (parts[0]) { const resolved = new URL(parts[0], `https://review.invalid/${activeDocument}`).pathname.slice(1); const doc = decodeURIComponent(resolved); if (!current?.revision?.documents.some(d => d.path === doc)) throw new Error('Linked document is not part of this frozen revision.'); activeDocument = doc; chrome(); await showDocument(); } if (parts[1]) { const heading = [...$('document').querySelectorAll('h1,h2,h3,h4,h5,h6')].find(h => h.textContent?.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s/g, '-') === decodeURIComponent(parts[1])); heading?.scrollIntoView({ block: 'start' }); } }); return; }
  const marked = target.closest<HTMLElement>('[data-thread-ids]');
  if (marked) { const id = marked.dataset.threadIds!.split(' ')[0]; $<HTMLInputElement>('open-only').checked = false; $<HTMLInputElement>('discussion-search').value = ''; discussionLimit = Math.max(discussionLimit, fold(current!.events, current!.revision!.id).threads.findIndex(t => t.root.threadId === id) + 1); stateView(); const thread = document.getElementById(`thread-${id}`); thread?.scrollIntoView({ behavior: 'smooth', block: 'center' }); thread?.classList.add('focused'); }
  $('document').querySelectorAll('.selected').forEach(el => el.classList.remove('selected')); semantic = target.closest<HTMLElement>('.semantic') ?? undefined;
  semantic?.classList.add('selected'); $('selection').textContent = semantic ? `${semantic.dataset.kind} selected` : '';
});
$('reconnect').addEventListener('click', () => safely(async () => {
  if (!remembered) return; const api = remembered.root as FileSystemDirectoryHandle & { requestPermission(o: { mode: string }): Promise<string> };
  if (await api.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Access was not granted. Use Choose review folder or Open read-only.');
  await attach(new BrowserStorage(remembered.root, remembered.reviewId, true), remembered);
}));
$('zoom-close').addEventListener('click', () => $<HTMLDialogElement>('diagram-viewer').close());
$('zoom-scale').addEventListener('input', () => { const svg = $('zoom-content').querySelector<SVGElement>('svg'); if (svg) svg.style.width = `${Number($<HTMLInputElement>('zoom-scale').value) * 8}px`; });
$('document').addEventListener('keydown', event => { const target = event.target as HTMLElement; if ((event.key === 'Enter' || event.key === ' ') && target.classList.contains('semantic')) { event.preventDefault(); target.click(); } });
$('forget').addEventListener('click', () => safely(async () => { if (current) { for (const [key, s] of sessions) if (s === current) sessions.delete(key); } current = undefined; generation++; renderKey = ''; $('workspace').hidden = true; $('toolbar').hidden = true; $('welcome').hidden = false; remembered = undefined; $('reconnect').hidden = true; await localValue(`connection:${location.href}`, null); status('Connection forgotten. Shared review files are unchanged.'); }));
try { const actor = JSON.parse(localStorage.getItem('omr.identity') ?? '{}'); $<HTMLInputElement>('actor-id').value = actor.id ?? ''; $<HTMLInputElement>('actor-name').value = actor.displayName ?? ''; } catch { /* Storage is optional for identity. */ }
if (rpc) { $('another').hidden = true; $('forget').hidden = true; safely(connectHost); }
else if (!window.showDirectoryPicker) { $<HTMLButtonElement>('connect').disabled = true; $<HTMLButtonElement>('read-only').disabled = true; $('compatibility').textContent = 'Direct folder access is unavailable here. Open this HTML file in a supported Edge/Chrome browser, or connect the package in VS Code.'; }
else safely(async () => { try { remembered = await localValue(`connection:${location.href}`); } catch { return; } if (remembered) $('reconnect').hidden = false; });
window.omrAutomation = { connect: connectHost, export: async (actor, revision, operation) => { if (!current) await connectHost(); await current!.pin(revision); return exportAudit(current!.context(actor), undefined, operation); }, session: () => current };
document.documentElement.dataset.clientReady = 'true';
window.addEventListener('message', event => {
  if (rpc && event.data?.command === 'toolbox-action' && ['threads', 'suggestions'].includes(event.data.buttonId)) { $(event.data.buttonId).scrollIntoView({ block: 'start', behavior: 'smooth' }); toast('Choose the discussion or accepted edit in the review toolbox.'); return; }
  if (rpc && event.data?.command === 'toolbox-action' && ['comment', 'suggest', 'approve', 'reject', 'withdraw', 'export', 'refresh'].includes(event.data.buttonId)) {
    const selection = event.data.selection;
    if (selection && typeof selection.source === 'string' && typeof selection.document === 'string' && Number.isInteger(selection.start) && Number.isInteger(selection.end) && selection.start >= 0 && selection.end > selection.start && selection.end <= selection.source.length) externalAnchor = { document: selection.document, documentDigest: digest(selection.source), range: { start: pointAt(selection.source, selection.start), end: pointAt(selection.source, selection.end) }, quote: { exact: selection.source.slice(selection.start, selection.end) }, target: { kind: 'text' } };
    $(event.data.buttonId).click();
  }
});
