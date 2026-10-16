import { BrowserStorage, localValue } from './browserStorage';
import { SLIDEV_ID, SlidevProfile } from './profiles/slidev';
import { renderSlide, sourceView, frozenReferenceLinks } from './profiles/slidevView';
import { ReviewSession, ActionContext } from './session';
import { JournalEntry, Storage } from './storage';
import { ActorRef, Event, LIMITS, MarkdownAnchor, Payload, ProtocolError, REVIEWER_COMPLETION, REVIEWER_INVITATIONS, THREAD_ADDRESSING } from './types';
import { decode, digest, jsonBytes, newId, parseJson, pointAt, offsetAt, toBase64, fromBase64 } from './bytes';
import { companionHost } from './companionTransport';
import { fold, heads, predecessors, reviewerProgress, threadWorkflowQueue, ThreadWorkflowQueue } from './state';
import { annotate, escapeHtml as esc, renderDocument, RenderedSource, selectionAnchor } from './rendering';
import { dataUrl, populateAssets } from './assets';
import { exportAudit, ExportResult } from './export';
import { effectiveReviewers, parseReviewerEmails, reviewerForInput, reviewerIdentity, reviewerRoster } from './reviewer';

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
let activeSlide: string | undefined;
function presentation(): SlidevProfile | undefined { return current?.revision ? current.profiles.get(current.revision.id)?.get(SLIDEV_ID) as SlidevProfile | undefined : undefined; }
interface LauncherBinding { schemaVersion: 'omr-launcher/1'; reviewId: string; title: string; manifestDigest: string }
interface RememberedConnection { root: FileSystemDirectoryHandle; reviewId: string; manifestDigest: string }
function launcherBinding(): LauncherBinding | undefined {
  const value = document.querySelector<HTMLMetaElement>('meta[name="open-markdown-review-bootstrap"]')?.content;
  if (!value || value.startsWith('__OPEN_MARKDOWN_REVIEW_') && value.endsWith('BOOTSTRAP__')) return;
  try {
    const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0)), parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<LauncherBinding>;
    return parsed.schemaVersion === 'omr-launcher/1' && typeof parsed.reviewId === 'string' && typeof parsed.title === 'string' && /^sha256:[a-f0-9]{64}$/.test(parsed.manifestDigest ?? '') ? parsed as LauncherBinding : undefined;
  } catch { return; }
}
const launcher = launcherBinding();
const connectionKey = launcher ? `connection:review:${launcher.reviewId}` : `connection:${location.href}`;
let remembered: RememberedConnection | undefined;
let polling = false, nextPoll: number | undefined, generation = 0;
let companionStopped = false;
let lastStateKey = '';
let lastChromeKey = '';
let discussionLimit = 50, historyLimit = 100;
let canApply = false, externalAnchor: MarkdownAnchor | undefined;
let exportBusy = false;
let exportController: AbortController | undefined, documentController: AbortController | undefined;
let canOpenExports = false;
interface ExportNotice { kind: 'busy' | 'error' | 'success' | 'cancelled'; message: string; result?: ExportResult }
const exportNotices = new Map<string, ExportNotice>();
const exportKey = (session: ReviewSession) => `${session.storage.identity}\0${session.manifest.reviewId}`;
function exportNotice() { return current ? exportNotices.get(exportKey(current)) : undefined; }
function showExportNotice(session: ReviewSession, notice: ExportNotice) {
  exportNotices.set(exportKey(session), notice);
  if (current === session) { renderExportNotice(); status(notice.message, notice.kind === 'error'); }
}
function renderExportNotice() {
  const notice = exportNotice(), result = notice?.result;
  $('export-result').hidden = !notice; $('export-result').dataset.kind = notice?.kind ?? '';
  $('export-result-title').textContent = notice?.kind === 'error' ? 'PDF export failed' : notice?.kind === 'success' ? 'PDF export saved' : notice?.kind === 'cancelled' ? 'PDF export cancelled' : 'Creating audit PDF';
  $('export-result-message').textContent = notice?.message ?? '';
  $('export-result-path').textContent = result ? `Review folder: ${result.pdfPath}\nAudit inventory: ${result.inventoryPath}` : '';
  $('open-export').hidden = !result || !canOpenExports; $('reveal-export').hidden = !result || !canOpenExports;
  $('download-export').hidden = !result || canOpenExports;
  $<HTMLButtonElement>('dismiss-export-result').disabled = notice?.kind === 'busy';
}
let identityGeneration = 0, canRememberReviewer = false, lastRememberedReviewer = '';
let identitySave: Promise<unknown> = Promise.resolve();
function status(message: string, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function toast(message: string) { $('toast').textContent = message; $('toast').classList.add('visible'); setTimeout(() => $('toast').classList.remove('visible'), 4500); }
function report(error: unknown) { status(error instanceof Error ? error.message : String(error), true); }
const safely = (work: () => Promise<unknown>) => { void work().catch(error => { if (!(error instanceof ProtocolError && error.code === 'cancelled')) report(error); }); };
function opening(message?: string) {
  const active = !!message; $('open-progress').hidden = !active; document.body.setAttribute('aria-busy', String(active));
  for (const id of ['connect', 'reconnect', 'read-only', 'another']) $<HTMLButtonElement>(id).disabled = active;
  if (message) { $('open-progress-message').textContent = message; status(message); }
}
const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
function selectedReviewer() { return reviewerForInput(current?.manifest, { id: $<HTMLInputElement>('actor-id').value, displayName: $<HTMLInputElement>('actor-name').value }, current?.events); }
function cacheReviewer(actor: ActorRef) { try { localStorage.setItem(current ? `omr.identity:${current.manifest.reviewId}` : 'omr.identity', JSON.stringify(actor)); } catch { /* Identity remains usable in memory. */ } }
function showReviewer(value: unknown) {
  const actor = reviewerIdentity(value); if (!actor) return;
  $<HTMLInputElement>('actor-id').value = current ? effectiveReviewers(current.manifest, current.events).find(r => r.id === actor.id)?.email ?? actor.id : actor.id; $<HTMLInputElement>('actor-name').value = actor.displayName ?? '';
  cacheReviewer(actor);
}
function rememberReviewer(actor: ActorRef) {
  cacheReviewer(actor);
  const serialized = JSON.stringify(actor);
  if (!rpc || !canRememberReviewer || serialized === lastRememberedReviewer) return;
  lastRememberedReviewer = serialized;
  // Preserve edit order without delaying review actions or writing shared evidence.
  identitySave = identitySave.then(() => rpc('rememberReviewer', [actor])).catch(() => {
    lastRememberedReviewer = ''; toast('Could not remember your reviewer identity on this device. Current actions still use the identity shown here.');
  });
}
function identity(): ActorRef { const actor = selectedReviewer(); if (!actor) { $('actor-id').focus(); throw new Error(current?.manifest.reviewers ? 'Enter one of the reviewer email addresses specified by the review initiator.' : 'Enter a reviewer ID first (1–128 characters, no control characters). It will be written to each event.'); } rememberReviewer(actor); return actor; }
function context(): ActionContext { if (!current) throw new Error('Open a review first.'); return current.context(identity()); }
function isReviewCreator(actor = selectedReviewer()): boolean { return !!current && !!actor && actor.id === current.manifest.createdBy.id; }
function feedbackLocked(): boolean {
  const actor = selectedReviewer();
  if (!current?.revision || !actor) return true;
  if (!current.manifest.requiredCapabilities.includes(REVIEWER_COMPLETION)) return false;
  const completion = current.events.filter(e => e.revisionId === current!.revision!.id && e.actor.id === actor.id && 'completionPredecessors' in e);
  return heads(completion).some(e => e.type === 'review.completed');
}
function descendantRevisions(fromRevisionId: string, document: string) {
  if (!current) return [];
  const descends = (candidate: string) => {
    const pending = [candidate], seen = new Set<string>();
    while (pending.length) { const id = pending.pop()!; if (id === fromRevisionId) return candidate !== fromRevisionId; if (seen.has(id)) continue; seen.add(id); pending.push(...(current!.revisions.get(id)?.parents ?? [])); }
    return false;
  };
  return [...current.revisions.values()].filter(revision => descends(revision.id) && revision.documents.some(item => item.path === document)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
}
const workflowLabel: Record<ThreadWorkflowQueue, string> = {
  conflict: 'conflict', 'needs-decision': 'needs decision', 'accepted-not-implemented': 'accepted · implementation pending',
  'awaiting-verification': 'published · verification pending', challenged: 'challenged again', verified: 'verified', disposed: 'rejected / deferred / duplicate'
};
function updateSelectionActions() {
  const actions = $('selection-actions'), selection = document.getSelection();
  const textSelected = !!selection && !selection.isCollapsed && $('document').contains(selection.anchorNode) && $('document').contains(selection.focusNode);
  const writable = !!current?.revision && current.storage.writable && !feedbackLocked() && !$<HTMLDialogElement>('composer').open;
  actions.hidden = !writable || !textSelected && !semantic;
  if (actions.hidden) return;
  const label = textSelected ? selection!.toString().replace(/\s+/g, ' ').trim() : `${semantic!.dataset.kind ?? 'content'} selected`;
  $('selection-action-label').textContent = label ? `Selected: ${label.slice(0, 100)}${label.length > 100 ? '…' : ''}` : 'Selected content';
  $<HTMLButtonElement>('selection-suggest').disabled = !textSelected;
}
function progress() {
  if (!current) return;
  const notice = exportNotice();
  if (notice && !current.diagnostics.length) { status(notice.message, notice.kind === 'error'); return; }
  if (current.diagnostics.length) status(`${current.diagnostics.some(d => d.severity === 'error') ? 'Review is not fully synchronized or valid.' : 'Review has nonblocking notices.'}\n${current.diagnostics.slice(0, 4).map(d => `${d.path}: ${d.message}`).join('\n')}`, current.diagnostics.some(d => d.severity === 'error'));
  else status(`${current.storage.writable ? 'Live shared-folder review · auto-updates every 3s visible / 15s hidden' : 'Read-only review'} · ${current.events.length} verified events · ${current.heads.length > 1 ? `${current.heads.length} competing revision heads — choose explicitly` : 'revision stays pinned until you change it'}`);
}
function chrome() {
  if (!current) return;
  const key = `${current.storage.identity}:${activeDocument}:${activeSlide}:${current.pinnedRevisionId}:${[...current.revisions.keys()].join(',')}:${[...sessions.keys()].join(',')}`;
  if (key === lastChromeKey) { progress(); return; }
  lastChromeKey = key;
  $('title').textContent = current.manifest.title; $('welcome').hidden = true; $('toolbar').hidden = false; $('workspace').hidden = false;
  $('reviews').innerHTML = [...sessions.entries()].map(([key, session]) => `<option value="${esc(key)}" ${session === current ? 'selected' : ''}>${esc(session.manifest.title)}</option>`).join('');
  $('revisions').innerHTML = `${!current.revision ? '<option value="">Choose a revision…</option>' : ''}${[...current.revisions.values()].map(r => `<option value="${r.id}" ${r.id === current!.pinnedRevisionId ? 'selected' : ''}>${r.id}${current!.heads.some(h => h.id === r.id) ? ' · head' : ' · history'}</option>`).join('')}`;
  const revision = current.revision;
  if (revision) {
    const profile = presentation();
    if (profile && activeSlide === undefined) { activeSlide = profile.slides[0].id; activeDocument = profile.slides[0].document; }
    if (!revision.documents.some(d => d.path === activeDocument)) activeDocument = revision.rootDocument;
    $('documents').innerHTML = (profile ? `<li><h3>Slides</h3></li>${profile.slides.map(s => `<li><button data-slide="${s.id}" class="${s.id === activeSlide ? 'active' : ''}">${s.number}. ${esc(s.title)}</button></li>`).join('')}<li><h3>Frozen source files</h3></li>` : '') + revision.documents.map(d => `<li><button data-document="${esc(d.path)}" class="${!activeSlide && d.path === activeDocument ? 'active' : ''}">${esc(d.path)}</button></li>`).join('');
  }
  const locked = feedbackLocked();
  for (const id of ['comment', 'suggest', 'approve', 'reject', 'withdraw', 'export']) $<HTMLButtonElement>(id).disabled = !revision || !current.storage.writable || (id === 'export' ? exportBusy : locked);
  progress(); updateSelectionActions();
}
function stateView() {
  if (!current?.revision) return;
  const openOnly = $<HTMLInputElement>('open-only').checked, query = $<HTMLInputElement>('discussion-search').value.trim().toLocaleLowerCase();
  const scope = $<HTMLSelectElement>('discussion-scope').value === 'document' ? 'document' : 'all';
  const workflow = $<HTMLSelectElement>('workflow-queue').value;
  const reviewer = selectedReviewer(), creator = isReviewCreator(reviewer);
  const identityInput = $<HTMLInputElement>('actor-id'), emailEntry = !!current.manifest.reviewers && !creator;
  $('actor-id-label').textContent = emailEntry ? 'Your reviewer email' : creator && current.manifest.reviewers ? 'Initiator ID' : 'Reviewer ID';
  identityInput.type = emailEntry ? 'email' : 'text'; identityInput.maxLength = emailEntry ? 254 : 128; identityInput.autocomplete = emailEntry ? 'email' : 'username'; identityInput.placeholder = emailEntry ? 'Your invited work email' : 'Your stable reviewer ID';
  $('identity-help').textContent = emailEntry ? 'Use an email listed by the initiator. Email ownership is self-asserted.' : 'Identity is self-asserted, not a Windows login.';
  const stateKey = `${current.storage.identity}:${current.revision.id}:${activeDocument}:${reviewer?.id ?? ''}:${scope}:${workflow}:${openOnly}:${query}:${discussionLimit}:${historyLimit}:${renderKey}:${current.events.map(e => e.id).join(',')}`;
  if (stateKey === lastStateKey) return;
  lastStateKey = stateKey;
  const focused = document.activeElement as HTMLElement | null;
  const restoreFocus = focused?.closest('#threads, #suggestions') && focused instanceof HTMLButtonElement ? { action: focused.dataset.action, thread: focused.dataset.thread, suggestion: focused.dataset.suggestion } : undefined;
  const state = fold(current.events, current.revision.id);
  const completionEnabled = current.manifest.requiredCapabilities.includes(REVIEWER_COMPLETION), locked = feedbackLocked();
  const ownCompletion = state.register(`completion:${current.revision.id}:${reviewer?.id ?? ''}`);
  const hasFinished = ownCompletion.heads.some(e => e.type === 'review.completed');
  $('completion-status').hidden = !completionEnabled;
  $('completion-status').textContent = `My review: ${!reviewer ? 'enter your identity' : ownCompletion.conflict ? 'conflicted — reopen to continue' : hasFinished ? 'finished' : ownCompletion.heads.length ? 'reopened' : 'in progress'}`;
  $<HTMLButtonElement>('finish-review').hidden = !completionEnabled || hasFinished;
  $<HTMLButtonElement>('reopen-review').hidden = !completionEnabled || !hasFinished;
  for (const id of ['comment', 'suggest', 'approve', 'reject', 'withdraw', 'finish-review']) $<HTMLButtonElement>(id).disabled = !current.storage.writable || !reviewer || locked;
  $<HTMLButtonElement>('reopen-review').disabled = !current.storage.writable || !reviewer;
  $<HTMLButtonElement>('add-reviewers').hidden = !creator || !current.manifest.requiredCapabilities.includes(REVIEWER_INVITATIONS);
  $<HTMLButtonElement>('add-reviewers').disabled = !current.storage.writable;
  let roster = document.getElementById('reviewer-progress');
  if (!roster) { roster = document.createElement('section'); roster.id = 'reviewer-progress'; roster.setAttribute('aria-label', 'Reviewer progress'); $('workbench').before(roster); }
  roster.hidden = !completionEnabled;
  const progressRows = reviewerProgress(current.manifest, current.events, current.revision.id);
  const countedRows = current.manifest.reviewers ? progressRows.filter(r => r.email) : progressRows, finishedCount = countedRows.filter(r => r.status === 'finished').length;
  const labels: Record<string, string> = { 'not-started': 'Not started', 'in-progress': 'In progress', finished: 'Finished', reopened: 'Reopened', conflicted: 'Conflicted' };
  roster.innerHTML = `<h2>Reviewer progress</h2><p>${finishedCount} of ${countedRows.length} reviewers finished this revision.</p>${progressRows.map(r => `<div class="reviewer-row" data-reviewer-id="${esc(r.id)}" data-reviewer-status="${r.status}"><strong>${esc(r.email ?? r.displayName ?? r.id)}${r.id === current!.manifest.createdBy.id ? ' (initiator)' : ''}</strong><span class="badge">${labels[r.status]}</span>${r.latest ? `<small>${esc(r.latest.occurredAt)}</small>` : ''}</div>`).join('')}${locked && reviewer ? '<p class="closed-notice">Your feedback is locked. Use Reopen my review to continue. The initiator can still process findings.</p>' : ''}`;
  const addressingEnabled = current.manifest.requiredCapabilities.includes(THREAD_ADDRESSING);
  const workflowMatches = (queue: ThreadWorkflowQueue) => workflow === 'all' || workflow === queue || workflow === 'creator-action' && ['conflict', 'needs-decision', 'accepted-not-implemented', 'challenged'].includes(queue);
  const matchingThreads = state.threads.filter(t => (scope === 'all' || t.root.anchor.document === activeDocument) && workflowMatches(threadWorkflowQueue(t)) && (!openOnly || t.open) && (!query || JSON.stringify(t).toLocaleLowerCase().includes(query)));
  const matchingSuggestions = state.suggestions.filter(s => (scope === 'all' || s.root.anchor.document === activeDocument) && (!openOnly || s.open) && (!query || JSON.stringify(s).toLocaleLowerCase().includes(query)));
  const ownStance = reviewer ? state.stances.find(stance => stance.actor === reviewer.id) : undefined;
  const activeStance = !!ownStance?.heads.some(event => event.type === 'review.approved' || event.type === 'review.rejected');
  const stanceLabel = !reviewer ? 'enter reviewer ID' : ownStance?.conflict ? 'conflicted' : ownStance?.heads.every(event => event.type === 'review.approved') ? 'approved' : ownStance?.heads.every(event => event.type === 'review.rejected') ? 'rejected' : ownStance?.heads.every(event => event.type === 'review.withdrawn') ? 'withdrawn' : 'not set';
  $('stance-status').textContent = `Your status: ${stanceLabel}`;
  $<HTMLButtonElement>('approve').hidden = activeStance; $<HTMLButtonElement>('reject').hidden = activeStance; $<HTMLButtonElement>('withdraw').hidden = !activeStance;
  const queueCounts = state.threads.reduce((counts, thread) => { const queue = threadWorkflowQueue(thread); counts[queue] = (counts[queue] ?? 0) + 1; return counts; }, {} as Partial<Record<ThreadWorkflowQueue, number>>);
  $('summary').innerHTML = `<h2>Revision summary</h2><p><strong>Your review status: ${esc(stanceLabel)}</strong><br>${state.threads.filter(t => t.open).length} open concerns<br>${state.suggestions.filter(t => t.open).length} unfinished edits<br>${state.stances.filter(s => !s.conflict && s.heads[0]?.type === 'review.approved').length} current approvals</p><p><strong>Processing</strong><br>${queueCounts['needs-decision'] ?? 0} need decisions<br>${queueCounts['accepted-not-implemented'] ?? 0} accepted, not implemented<br>${queueCounts['awaiting-verification'] ?? 0} awaiting verification<br>${queueCounts.challenged ?? 0} challenged again</p><p class="role-note">${creator ? 'Initiator controls enabled: decide findings, edit linked source, publish a revision, record the implementation, then close.' : `Reviewer controls: verify published fixes; only ${esc(current.manifest.createdBy.displayName ?? current.manifest.createdBy.id)} can decide, record implementation, close or reopen findings.`}</p>`;
  $('threads').innerHTML = matchingThreads.slice(0, discussionLimit).map(t => {
    const queue = threadWorkflowQueue(t), candidates = descendantRevisions(t.root.revisionId, t.root.anchor.document);
    const accepted = !t.decision.conflict && t.decision.heads.some(event => event.type === 'thread.decided' && event.decision === 'accepted');
    const participantActions = t.open && !locked ? `<button data-action="reply" data-thread="${t.root.threadId}">Reply</button>` : '';
    const creatorAction = creator ? `${t.open ? `<button data-action="decide" data-thread="${t.root.threadId}">Decide</button><button data-action="resolve" data-thread="${t.root.threadId}">Close thread</button>` : `<button data-action="reopen" data-thread="${t.root.threadId}">Reopen thread</button>`}${canApply ? `<button data-action="reveal-source" data-thread="${t.root.threadId}">Address in source</button>` : ''}${addressingEnabled && accepted && candidates.length ? `<button data-action="record-addressed" data-thread="${t.root.threadId}">Record published fix…</button>` : ''}` : '';
    const addressingActions = t.addressed ? `<button data-action="open-addressed" data-thread="${t.root.threadId}">Open ${esc(t.addressed.toRevisionId)}</button>${addressingEnabled && !locked ? `<button data-action="verify-addressing" data-thread="${t.root.threadId}">Verify outcome…</button>` : ''}` : '';
    const closedNotice = t.open ? '' : '<p class="closed-notice">Closed: replies and decisions are locked until the review creator reopens this thread.</p>';
    const addressed = t.addressed ? `<div class="addressing"><strong>Implemented in ${esc(t.addressed.toRevisionId)}</strong><p>${esc(t.addressed.summary)}</p><small>${esc(t.addressed.sourceDigestBefore)} → ${esc(t.addressed.sourceDigestAfter)}</small></div>` : '';
    const verification = t.verification.heads.map(event => event.type === 'thread.verification.recorded' ? `<p class="verification ${event.verdict}"><strong>${esc(event.verdict)}</strong> by ${esc(event.actor.displayName ?? event.actor.id)}${event.note ? ` · ${esc(event.note)}` : ''}</p>` : '').join('');
    return `<article class="thread ${t.open ? '' : 'closed'}" id="thread-${t.root.threadId}"><h3>${esc(t.root.actor.displayName ?? t.root.actor.id)} <span class="badge">${t.open ? 'open' : 'closed'} · ${esc(workflowLabel[queue])}</span></h3><button data-action="locate" data-thread="${t.root.threadId}">${esc(t.root.anchor.document)}:${t.root.anchor.range.start.line + 1}</button><blockquote>${esc(t.root.anchor.quote.exact)}</blockquote><p>${esc(t.root.body.text)}</p>${t.replies.map(e => e.type === 'comment.replied' ? `<div class="reply"><strong>${esc(e.actor.displayName ?? e.actor.id)}</strong><p>${esc(e.body.text)}</p></div>` : '').join('')}<p class="badge">${t.decision.heads.map(e => e.type === 'thread.decided' ? esc(e.decision + (e.reason ? ': ' + e.reason : '')) : '').join(' / ')}</p>${addressed}${verification}${closedNotice}<div class="buttons">${participantActions}${creatorAction}${addressingActions}</div></article>`;
  }).join('') || '<p>No matching comments.</p>';
  $('suggestions').innerHTML = matchingSuggestions.slice(0, discussionLimit).map(s => `<article class="suggestion" id="suggestion-${s.root.suggestionId}"><h3>${esc(s.root.operation.kind)} · ${esc(s.status)}</h3><button data-suggestion="${s.root.suggestionId}" data-action="locate">${esc(s.root.anchor.document)}:${s.root.anchor.range.start.line + 1}</button><blockquote>${s.root.operation.kind === 'insert' ? esc(s.root.anchor.quote.exact) : `<del>${esc(s.root.anchor.quote.exact)}</del>`}${s.root.operation.kind !== 'delete' ? `<ins>${esc(s.root.operation.replacement)}</ins>` : ''}</blockquote><p>${esc(s.root.rationale.text)}</p><div class="buttons">${s.open && !locked ? `<button data-suggestion="${s.root.suggestionId}" data-action="accept-suggestion">Accept</button><button data-suggestion="${s.root.suggestionId}" data-action="reject-suggestion">Reject</button>` : ''}</div></article>`).join('') || '<p>No suggested edits.</p>';
  $('history').innerHTML = state.current.slice(-historyLimit).reverse().map(e => `<div class="history-item"><strong>${esc(e.type)}</strong><br>${esc(e.actor.displayName ?? e.actor.id)} · ${esc(e.occurredAt)}<details><summary>Full event and reasons</summary><pre>${esc(JSON.stringify(e, null, 2))}</pre></details></div>`).join('');
  $('more-discussions').hidden = Math.max(matchingThreads.length, matchingSuggestions.length) <= discussionLimit;
  const profile = presentation();
  if (profile) for (const finding of [...matchingThreads.slice(0, discussionLimit).map(item => ({ anchor: item.root.anchor, selector: `[data-action="locate"][data-thread="${item.root.threadId}"]` })), ...matchingSuggestions.slice(0, discussionLimit).map(item => ({ anchor: item.root.anchor, selector: `[data-action="locate"][data-suggestion="${item.root.suggestionId}"]` }))]) {
    const target = finding.anchor.target, start = finding.anchor.document === activeDocument ? offsetAt(source, finding.anchor.range.start) : -1;
    const slide = target?.kind === 'image' ? profile.slides.find(s => s.previewResourceId === target.resourceId) : profile.slides.find(s => s.document === finding.anchor.document && start >= 0 && s.range.start <= start && s.range.end > start);
    const button = document.querySelector<HTMLButtonElement>(finding.selector);
    if (slide && button) { button.textContent = `Slide ${slide.number} · ${slide.title}`; button.title = `${slide.document}:${finding.anchor.range.start.line + 1}`; }
  }
  $('more-history').hidden = state.current.length <= historyLimit;
  const scopeLabel = scope === 'all' ? `across all ${current.revision.documents.length} review document(s)` : `on ${activeDocument}`;
  $('discussion-count').textContent = `${matchingThreads.length} comments · ${matchingSuggestions.length} edits ${scopeLabel}${workflow !== 'all' ? ` · queue: ${workflow}` : ''}${query ? ' matching search' : ''}`;
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
  updateSelectionActions();
}
async function showDocument() {
  const session = current, revision = session?.revision, selected = activeDocument, epoch = generation;
  if (!session || !revision || !selected) return;
  const key = `${session.storage.identity}:${revision.id}:${selected}:${activeSlide}`;
  if (key === renderKey) { stateView(); return; }
  documentController?.abort(); const controller = new AbortController(); documentController = controller;
  status(`Loading ${selected}…`);
  const doc = revision.documents.find(d => d.path === selected)!; const text = decode(await session.content(doc));
  const profile = presentation(), slide = profile?.slides.find(s => s.id === activeSlide);
  const render = slide && profile ? renderSlide(profile, slide, text) : profile ? sourceView(text) : renderDocument(text, selected, revision), host = document.createElement('article'); host.innerHTML = render.html;
  if (profile) host.insertAdjacentHTML('beforeend', frozenReferenceLinks(revision, selected));
  await populateAssets(host, revision, c => session.content(c), { signal: controller.signal, progress: message => { if (documentController === controller) status(message); } });
  for (const figure of host.querySelectorAll<HTMLElement>('[data-diagram-id]')) { const zoom = document.createElement('button'); zoom.dataset.zoom = figure.dataset.diagramId; zoom.textContent = 'Zoom diagram'; figure.append(zoom); }
  if (session !== current || selected !== activeDocument || epoch !== generation || revision.id !== current.revision?.id || controller.signal.aborted) return;
  source = text; rendered = render; renderKey = key; semantic = undefined; $('selection-actions').hidden = true;
  $('document').replaceChildren(...host.childNodes); stateView(); progress();
  if (documentController === controller) documentController = undefined;
}
async function activate(session: ReviewSession) {
  const previous = current, previousReviewer = selectedReviewer(); if (previousReviewer) cacheReviewer(previousReviewer);
  generation++; lastChromeKey = ''; discussionLimit = 50; historyLimit = 100; current = session; renderKey = ''; lastStateKey = ''; activeSlide = undefined; activeDocument = session.revision?.rootDocument ?? '';
  if (!rpc || previous && previous !== session || !$<HTMLInputElement>('actor-id').value.trim()) {
    let saved: unknown; try { saved = JSON.parse(localStorage.getItem(`omr.identity:${session.manifest.reviewId}`) ?? 'null'); } catch { /* Optional preference. */ }
    if (saved) showReviewer(saved);
    else if (previous && previous !== session) { $<HTMLInputElement>('actor-id').value = ''; $<HTMLInputElement>('actor-name').value = ''; }
  }
  const reviewer = selectedReviewer(); if (reviewer) showReviewer(reviewer);
  if (!exportNotices.has(exportKey(session))) {
    const latest = [...session.events].filter((event): event is Extract<Event, { type: 'export.created' }> => event.type === 'export.created').sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id))[0];
    if (latest) exportNotices.set(exportKey(session), { kind: 'success', message: `Latest archived PDF is in this review's exports folder (${latest.occurredAt}).`, result: { pdfPath: latest.pdf.path, inventoryPath: latest.inventory.path, event: latest } });
  }
  renderExportNotice(); chrome(); await showDocument(); schedulePoll();
}
async function showSlide(id: string) { const slide = presentation()?.slides.find(s => s.id === id); if (!slide) return; activeSlide = id; activeDocument = slide.document; generation++; chrome(); await showDocument(); }
async function attach(storage: Storage, expected?: { reviewId: string; manifestDigest: string }): Promise<ReviewSession> {
  opening(`Opening ${launcher?.title ?? 'review'}…`); await paint();
  try {
    let initialOpen = true;
    const session = new ReviewSession(storage, message => { if (initialOpen) opening(message); });
    try { await session.open(); } finally { initialOpen = false; }
    if (expected && (session.manifest.reviewId !== expected.reviewId || digest(await storage.read('manifest.json', LIMITS.manifest)) !== expected.manifestDigest)) throw new Error('Remembered folder now contains a different review. Choose it explicitly to connect.');
    sessions.set(storage.identity, session); opening('Rendering the first reviewed document…'); await activate(session); return session;
  } finally { opening(); }
}
async function choose(readOnly = false) {
  if (!window.showDirectoryPicker) throw new Error('This browser cannot read/write a chosen folder. Use supported Edge/Chrome, or VS Code.');
  opening('Waiting for folder selection in the browser dialog…');
  try {
    const root = await window.showDirectoryPicker({ mode: readOnly ? 'read' : 'readwrite' });
    opening('Reading the selected folder…'); await paint();
    const preliminary = new BrowserStorage(root, 'opening', !readOnly);
    const manifest = parseJson<{ reviewId: string }>(await preliminary.read('manifest.json', LIMITS.manifest), LIMITS.manifest);
    const storage = new BrowserStorage(root, manifest.reviewId, !readOnly), session = await attach(storage, launcher);
    remembered = { root, reviewId: session.manifest.reviewId, manifestDigest: digest(await storage.read('manifest.json', LIMITS.manifest)) };
    try { await localValue(connectionKey, remembered); } catch { toast('Review is open. This browser could not remember its folder permission.'); }
  } catch (error) {
    opening();
    if (error instanceof DOMException && error.name === 'NotAllowedError') throw new Error('The browser denied folder access. Check file editing permissions or managed FileSystem policies. If your organization blocks local HTML file access, use an approved Edge browser or VS Code. This client cannot override browser policy.');
    throw error;
  }
}
function schedulePoll() { if (nextPoll) clearTimeout(nextPoll); if (!companionStopped) nextPoll = window.setTimeout(() => safely(refresh), document.hidden ? 15000 : 3000); }
async function refresh() {
  if (polling || !current) { schedulePoll(); return; }
  const session = current, before = new Set(session.events.map(event => event.id)); polling = true;
  try {
    await session.refresh();
    if (current === session) {
      const arrived = session.events.filter(event => !before.has(event.id));
      chrome(); stateView();
      const completion = arrived.filter(event => event.type === 'review.completed' || event.type === 'review.reopened');
      if (completion.length) toast(completion.map(event => `${effectiveReviewers(session.manifest, session.events).find(r => r.id === event.actor.id)?.email ?? event.actor.displayName ?? event.actor.id} ${event.type === 'review.completed' ? 'finished' : 'reopened'} their review of ${event.revisionId}.`).join(' '));
      else if (arrived.length) toast(`${arrived.length} new review event${arrived.length === 1 ? '' : 's'} received from the shared folder.`);
    }
  } finally { polling = false; schedulePoll(); }
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
  if (feedbackLocked()) throw new Error('Enter your reviewer identity and reopen your review before adding feedback.');
  const ctx = context(); if (!rendered) throw new Error('Wait for the document to finish rendering.');
  const selection = document.getSelection(), hasTextSelection = !!selection && !selection.isCollapsed && $('document').contains(selection.anchorNode) && $('document').contains(selection.focusNode);
  const anchor = externalAnchor ?? selectionAnchor($('document'), rendered, source, activeDocument, ctx.revision, hasTextSelection ? undefined : semantic); externalAnchor = undefined;
  if (!ctx.revision.documents.some(d => d.path === anchor.document && d.digest === anchor.documentDigest)) throw new Error('Source selection differs from the frozen revision. Select the frozen review text or create a new revision.');
  if (suggest && anchor.target?.kind !== 'text') throw new Error('Select text to suggest an insertion, replacement or strikeout.');
  $('selection-actions').hidden = true;
  eventComposer(ctx, { title: suggest ? 'Suggest an edit' : 'Comment on selection', label: suggest ? 'Rationale' : 'Comment', required: true, ...(suggest ? { choices: ['delete', 'replace', 'insert-before', 'insert-after'], replacement: true } : {}) }, (text, choice, replacement) => suggest
    ? { type: 'suggestion.created', suggestionId: newId('suggestion'), anchor, rationale: { format: 'markdown', text }, operation: choice === 'delete' ? { kind: 'delete' } : choice === 'replace' ? { kind: 'replace', replacement } : { kind: 'insert', position: choice === 'insert-before' ? 'before' : 'after', replacement } }
    : { type: 'comment.created', threadId: newId('thread'), commentId: newId('comment'), anchor, body: { format: 'markdown', text } });
}
async function addReviewers() {
  const ctx = context();
  if (!isReviewCreator(ctx.actor) || !ctx.session.manifest.requiredCapabilities.includes(REVIEWER_INVITATIONS)) throw new Error('Only the initiator can add reviewers to a review declaring reviewer-invitations-v1.');
  let prepared: Event[] | undefined, originalText: string | undefined;
  compose(ctx, { title: 'Add reviewers', label: 'Reviewer email addresses (one per line or comma-separated)', required: true, submit: async text => {
    if (prepared && text !== originalText) throw new Error('An invitation may already be partly saved. Retry the original email list before starting another action.');
    if (!prepared) {
      const emails = parseReviewerEmails(text); if (!emails.length) throw new Error('Enter at least one reviewer email address.');
      await ctx.session.refresh();
      const existing = new Set(effectiveReviewers(ctx.session.manifest, ctx.session.events).map(r => r.id));
      const additions = reviewerRoster(emails).filter(r => !existing.has(r.id));
      if (!additions.length) throw new Error('All of these reviewers are already invited.');
      prepared = additions.map(reviewer => ctx.session.makeEvent(ctx, { type: 'reviewer.invited', reviewer })); originalText = text;
    }
    for (const event of prepared) await ctx.session.save(ctx, event);
  } });
  $('composer-context').textContent = `${ctx.session.manifest.title} · Initiator-only action. Adds reviewers across all revisions without modifying the manifest, existing completion records or approval quorum. Already-listed emails are skipped. Share the OneDrive/shared folder separately; this does not send email or grant filesystem access.`;
}
async function completion(type: 'review.completed' | 'review.reopened') {
  const ctx = context(); await ctx.session.refresh();
  if (type === 'review.reopened') {
    const observed = fold(ctx.session.events, ctx.revision.id).register(`completion:${ctx.revision.id}:${ctx.actor.id}`).heads.map(e => e.id);
    eventComposer(ctx, { title: 'Reopen my review', label: 'Note (optional)' }, note => ({ type, completionPredecessors: observed, ...(note.trim() ? { note: note.trim() } : {}) }));
    return;
  }
  status('Verifying the revision and review history before finishing…');
  let verified = await ctx.session.audit(ctx), prepared: Event | undefined, preparedNote: string | undefined;
  compose(ctx, { title: 'Finish my review', label: 'Completion note (optional)', submit: async note => {
    if (!prepared) {
      const latest = await ctx.session.audit(ctx);
      if (latest.frontier !== verified.frontier) { verified = latest; throw new ProtocolError('changed', 'New review activity arrived. Review the updated information, then confirm again.'); }
      const operationId = newId('finish'), verification = await ctx.session.verificationBlob(latest, operationId);
      const completionPredecessors = fold(latest.events, ctx.revision.id).register(`completion:${ctx.revision.id}:${ctx.actor.id}`).heads.map(e => e.id);
      prepared = ctx.session.makeEvent(ctx, { type, completionPredecessors, verification, ...(note.trim() ? { note: note.trim() } : {}) }, operationId); preparedNote = note;
    } else if (note !== preparedNote) throw new Error('Retry the original completion note before starting a different action.');
    try { await ctx.session.save(ctx, prepared); }
    catch (error) { if (error instanceof ProtocolError && error.code === 'changed') { prepared = undefined; verified = await ctx.session.audit(ctx); } throw error; }
  } });
  $('composer-context').textContent += ` Finishing records this revision and the verified review history. Your comments and stance stay as recorded; use Reopen my review to add further feedback. Finishing does not approve the revision.`;
}
async function stance(type: 'review.approved' | 'review.rejected' | 'review.withdrawn') {
  const ctx = context(), state = fold(ctx.session.events, ctx.revision.id), stanceHeads = state.register(`stance:${ctx.revision.id}:${ctx.actor.id}`).heads, observed = stanceHeads.map(e => e.id);
  const active = stanceHeads.some(event => event.type === 'review.approved' || event.type === 'review.rejected');
  if (type === 'review.withdrawn' && !active) throw new Error('You have no active approval or rejection to withdraw.');
  if (type !== 'review.withdrawn' && active) throw new Error('Withdraw your current review stance before approving or rejecting again.');
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
  if (action === 'locate' && (thread || suggestion)) {
    const anchor = (thread ?? suggestion)!.root.anchor;
    activeDocument = anchor.document;
    const target = anchor.target, profile = presentation();
    const slides = profile?.slides.filter(s => s.document === activeDocument) ?? [];
    const start = offsetAt(decode(await ctx.session.content(ctx.revision.documents.find(d => d.path === activeDocument)!)), anchor.range.start);
    activeSlide = (target?.kind === 'image' ? slides.find(s => s.previewResourceId === target.resourceId) : slides.find(s => s.id === activeSlide && s.range.start <= start && s.range.end > start) ?? slides.find(s => s.range.start <= start && s.range.end > start))?.id ?? '';
    generation++; chrome(); await showDocument();
    const element = thread ? $('document').querySelector<HTMLElement>(`[data-thread-ids~="${thread.root.threadId}"]`) : $('document').querySelector<HTMLElement>(`[data-suggestion-jump="${suggestion!.root.suggestionId}"]`) ?? $('document').querySelector<HTMLElement>(`[data-suggestion-ids~="${suggestion!.root.suggestionId}"]`);
    if (element) { const details = element.closest('details'); if (details) details.open = true; element.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    else toast('The finding anchor cannot be located in this rendering. Its exact source quote remains in the discussion.'); return;
  }
  if (thread) {
    const threadId = thread.root.threadId;
    if ((action === 'reply' || action === 'decide') && !thread.open) throw new Error('This comment thread is closed. The review creator must reopen it first.');
    if ((action === 'decide' || action === 'resolve' || action === 'reopen' || action === 'reveal-source' || action === 'record-addressed') && !isReviewCreator(ctx.actor)) throw new Error(`Only the review initiator (${ctx.session.manifest.createdBy.id}) can decide, process, close or reopen findings.`);
    if (action === 'reply') eventComposer(ctx, { title: 'Reply to comment', label: 'Reply', required: true }, text => ({ type: 'comment.replied', threadId, commentId: newId('comment'), inReplyTo: thread.root.commentId, body: { format: 'markdown', text } }));
    if (action === 'decide') eventComposer(ctx, { title: 'Decide comment', label: 'Reason (required unless accepted)', choices: ['accepted', 'rejected', 'wont-fix', 'duplicate'] }, (text, decision) => ({ type: 'thread.decided', threadId, decision: decision as 'accepted', reason: text, decisionPredecessors: thread.decision.heads.map(e => e.id) }));
    if (action === 'resolve') eventComposer(ctx, { title: 'Close comment thread', label: 'Resolution note' }, note => ({ type: 'thread.resolved', threadId, note, statusPredecessors: thread.status.heads.map(e => e.id) }));
    if (action === 'reopen') eventComposer(ctx, { title: 'Reopen concern', label: 'Reason', required: true }, reason => ({ type: 'thread.reopened', threadId, reason, statusPredecessors: thread.status.heads.map(e => e.id) }));
    if (action === 'reveal-source') {
      if (!rpc || !canApply) throw new Error('Link a local source workspace in VS Code before addressing this finding.');
      const result = await rpc('revealSource', [ctx.revision.id, threadId]) as { confidence?: string };
      toast(result.confidence === 'position' ? 'Opened the last known source position. Reconcile the missing quote explicitly.' : 'Opened and selected the finding in the linked source workspace.'); return;
    }
    if (action === 'record-addressed') {
      if (!ctx.session.manifest.requiredCapabilities.includes(THREAD_ADDRESSING)) throw new Error('This review does not declare thread-addressing-v1.');
      const revisions = descendantRevisions(ctx.revision.id, thread.root.anchor.document);
      if (!revisions.length) throw new Error('Publish a descendant review revision before recording implementation evidence.');
      eventComposer(ctx, { title: 'Record a published fix', label: 'Implementation summary', required: true, choices: revisions.map(revision => revision.id) }, (summary, toRevisionId) => {
        const target = ctx.session.revisions.get(toRevisionId), document = target?.documents.find(item => item.path === thread.root.anchor.document);
        if (!target || !document) throw new Error('The selected revision no longer contains this document.');
        return { type: 'thread.addressed', threadId, toRevisionId, document: thread.root.anchor.document, sourceDigestBefore: thread.root.anchor.documentDigest, sourceDigestAfter: document.digest, summary, decisionIds: thread.decision.heads.map(event => event.id), addressingPredecessors: thread.addressing.heads.map(event => event.id) };
      });
    }
    if (action === 'verify-addressing') {
      if (!thread.addressed) throw new Error('No current published implementation is available to verify.');
      eventComposer(ctx, { title: 'Verify published outcome', label: 'Verification note (required when challenged)', choices: ['verified', 'challenged'] }, (note, verdict) => ({ type: 'thread.verification.recorded', threadId, addressedEventId: thread.addressed!.id, verdict: verdict as 'verified' | 'challenged', ...(note.trim() ? { note } : {}), verificationPredecessors: thread.verification.heads.map(event => event.id) }));
    }
    if (action === 'open-addressed') {
      if (!thread.addressed) throw new Error('No addressed revision is recorded.');
      await ctx.session.pin(thread.addressed.toRevisionId); activeSlide = undefined; activeDocument = thread.addressed.document; generation++; renderKey = ''; lastChromeKey = ''; lastStateKey = ''; chrome(); await showDocument(); toast(`Opened published implementation ${thread.addressed.toRevisionId}. Use the revision selector to return.`); return;
    }
  }
  if (suggestion && action === 'apply-suggestion') { if (!rpc || !canApply) throw new Error('Source application is an author-only capability.'); await rpc('applySuggestion', [ctx.revision.id, suggestion.root.suggestionId, newId('apply')]); await ctx.session.refresh(); if (current === ctx.session) stateView(); return; }
  if (suggestion) eventComposer(ctx, { title: action === 'accept-suggestion' ? 'Accept suggested edit' : 'Reject suggested edit', label: 'Reason / note', required: action !== 'accept-suggestion' }, text => action === 'accept-suggestion' ? { type: 'suggestion.accepted', suggestionId: suggestion.root.suggestionId, note: text, decisionPredecessors: suggestion.decision.heads.map(e => e.id) } : { type: 'suggestion.rejected', suggestionId: suggestion.root.suggestionId, reason: text, decisionPredecessors: suggestion.decision.heads.map(e => e.id) });
}
function installHostRpc(): ((method: string, args: unknown[]) => Promise<unknown>) | undefined {
  const host = window.omrHost ?? companionHost();
  if (host) return async (method, args) => {
    const response = await host(method, args) as { ok: boolean; value?: unknown; code?: ProtocolError['code']; error?: string };
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
  const initialIdentityGeneration = identityGeneration;
  const metadata = await rpc('info', []) as { identity: string; writable: boolean; companion?: boolean; binaryEncoding?: 'base64'; canApply?: boolean; canRememberReviewer?: boolean; canNotifyReady?: boolean; canOpenExports?: boolean; reviewer?: ActorRef };
  canApply = !!metadata.canApply;
  canOpenExports = !!metadata.canOpenExports;
  canRememberReviewer = !!metadata.canRememberReviewer;
  lastRememberedReviewer = JSON.stringify(reviewerIdentity(metadata.reviewer)) ?? '';
  // A slow host handshake must not replace identity text already entered by the user.
  if (identityGeneration === initialIdentityGeneration) showReviewer(metadata.reviewer);
  const compact = metadata.binaryEncoding === 'base64';
  const storage: Storage = { ...metadata,
    read: async (p, l) => { const value = await rpc('read', [p, l]); return compact ? fromBase64(value as string) : new Uint8Array(value as number[]); },
    list: async p => await rpc('list', [p]) as string[],
    write: async (p, b, r) => { await rpc('write', [p, compact ? toBase64(b) : Array.from(b), r]); },
    journalGet: async o => { const value = await rpc('journalGet', [o]) as (Omit<JournalEntry, 'bytes'> & { bytes: number[] | string }) | null; return value ? { ...value, bytes: compact ? Array.from(fromBase64(value.bytes as string)) : value.bytes as number[] } : undefined; },
    journalPut: async (o, e) => { await rpc('journalPut', [o, compact ? { ...e, bytes: toBase64(new Uint8Array(e.bytes)) } : e]); }
  };
  $('companion-status').hidden = !metadata.companion;
  await attach(storage);
  if (metadata.canNotifyReady) await rpc('toolboxReady', []);
}
async function exportFromToolbox() {
  if (exportBusy) return;
  let ctx: ActionContext;
  try { ctx = context(); }
  catch (error) { if (current) showExportNotice(current, { kind: 'error', message: error instanceof Error ? error.message : String(error) }); throw error; }
  const key = `export-ui:${digest(`${ctx.revision.id}\0${ctx.actor.id}`).slice(7)}`;
  let pointer: JournalEntry | undefined;
  exportBusy = true; exportController = new AbortController(); $<HTMLButtonElement>('export').disabled = true; $<HTMLButtonElement>('cancel-operation').hidden = false;
  showExportNotice(ctx.session, { kind: 'busy', message: 'Preparing the archival PDF. It will be saved in this review folder, not Downloads.' });
  try {
    // The pointer is private recovery metadata, not another source of review state.
    // A reload/retry uses the same captured plan after an uncertain publication.
    const prior = await ctx.session.storage.journalGet(key);
    const operationId = prior && !prior.acknowledged ? parseJson<{ operationId: string }>(new Uint8Array(prior.bytes)).operationId : newId('export');
    pointer = { path: 'exports', bytes: Array.from(jsonBytes({ operationId })), acknowledged: false };
    await ctx.session.storage.journalPut(key, pointer);
    showExportNotice(ctx.session, { kind: 'busy', message: 'Verifying and exporting every document, comment and response…' });
    const result = await exportAudit(ctx, undefined, operationId, { signal: exportController.signal, progress: message => showExportNotice(ctx.session, { kind: 'busy', message }) });
    await ctx.session.storage.journalPut(key, { ...pointer, acknowledged: true });
    showExportNotice(ctx.session, { kind: 'success', message: 'Audit PDF and its exact-byte inventory are saved in this review folder. Use the actions below to open or download the PDF.', result });
    toast(`Saved ${result.pdfPath} and its audit inventory.`);
    if (current === ctx.session) stateView();
  } catch (error) {
    if (error instanceof ProtocolError && error.code === 'cancelled') { if (pointer) await ctx.session.storage.journalPut(key, { ...pointer, acknowledged: true }); showExportNotice(ctx.session, { kind: 'cancelled', message: 'Export cancelled before publication. Review evidence is unchanged.' }); toast('Export cancelled before publication. Review evidence is unchanged.'); return; }
    const message = `Export did not finish. Click Export again to resume the same export safely. ${String(error)}`;
    showExportNotice(ctx.session, { kind: 'error', message }); throw new Error(message);
  }
  finally { exportBusy = false; exportController = undefined; $<HTMLButtonElement>('cancel-operation').hidden = true; lastChromeKey = ''; chrome(); }
}
$('dismiss-export-result').addEventListener('click', () => { if (!current || exportNotice()?.kind === 'busy') return; exportNotices.delete(exportKey(current)); renderExportNotice(); progress(); });
$('stop-companion').addEventListener('click', () => safely(async () => {
  if (!rpc || exportBusy || !confirm('Stop the local companion? Wait for pending saves to finish first. Saved review files will remain in the shared folder.')) return;
  await rpc('stop', []); companionStopped = true; if (nextPoll) clearTimeout(nextPoll);
  $<HTMLButtonElement>('stop-companion').disabled = true;
  $('workspace').hidden = true; $('toolbar').hidden = true;
  status('Local companion stopped. Saved review files are unchanged. Close this tab; use StartReview or VS Code to reopen.');
}));
for (const [id, method] of [['open-export', 'openExport'], ['reveal-export', 'revealExport']] as const) $(id).addEventListener('click', () => safely(async () => { const result = exportNotice()?.result; if (rpc && canOpenExports && result) await rpc(method, [result.event.id]); }));
$('download-export').addEventListener('click', () => safely(async () => {
  const session = current, result = exportNotice()?.result;
  if (!session || !result || result.event.type !== 'export.created') return;
  const pdf = result.event.pdf, bytes = await session.storage.read(pdf.path, Math.max(1, pdf.byteLength));
  if (bytes.length !== pdf.byteLength || digest(bytes) !== pdf.digest) throw new Error('The archived PDF changed or is incomplete. No download was started.');
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${session.manifest.title.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'Review'}-archive.pdf`;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}));
for (const [id, fn] of Object.entries({ connect: () => choose(), another: () => choose(), 'read-only': () => choose(true), refresh, comment: async () => comment(), suggest: async () => comment(true), approve: () => stance('review.approved'), reject: () => stance('review.rejected'), withdraw: () => stance('review.withdrawn'), 'finish-review': () => completion('review.completed'), 'reopen-review': () => completion('review.reopened'), 'add-reviewers': addReviewers, export: exportFromToolbox })) $(id).addEventListener('click', () => safely(fn));
$('selection-comment').addEventListener('click', () => safely(async () => comment()));
$('selection-suggest').addEventListener('click', () => safely(async () => comment(true)));
$('cancel').addEventListener('click', () => { $<HTMLDialogElement>('composer').close(); updateSelectionActions(); });
$('cancel-operation').addEventListener('click', () => exportController?.abort());
$('open-only').addEventListener('change', stateView);
$('workflow-queue').addEventListener('change', () => { discussionLimit = 50; lastStateKey = ''; stateView(); });
$('discussion-scope').addEventListener('change', () => { discussionLimit = 50; lastStateKey = ''; stateView(); });
$('discussion-search').addEventListener('input', () => { discussionLimit = 50; stateView(); });
$('more-discussions').addEventListener('click', () => { discussionLimit += 50; stateView(); });
$('more-history').addEventListener('click', () => { historyLimit += 100; stateView(); });
$('documents').addEventListener('click', e => { const button = (e.target as Element).closest<HTMLElement>('[data-document],[data-slide]'); if (button) safely(async () => { if (button.dataset.slide) return showSlide(button.dataset.slide); activeSlide = ''; generation++; activeDocument = button.dataset.document!; chrome(); await showDocument(); }); });
$('reviews').addEventListener('change', () => safely(() => activate(sessions.get($<HTMLSelectElement>('reviews').value)!)));
$('revisions').addEventListener('change', () => safely(async () => { await current!.pin($<HTMLSelectElement>('revisions').value); activeSlide = undefined; generation++; activeDocument = current!.revision!.rootDocument; chrome(); await showDocument(); }));
for (const id of ['threads', 'suggestions']) $(id).addEventListener('click', e => { const button = (e.target as Element).closest<HTMLButtonElement>('button[data-action]'); if (button) safely(() => action(button)); });
$('document').addEventListener('click', e => {
  const slideButton = (e.target as Element).closest<HTMLElement>('[data-slide]');
  if (slideButton?.dataset.slide) { safely(() => showSlide(slideButton.dataset.slide!)); return; }
  const zoom = (e.target as Element).closest<HTMLElement>('[data-zoom]');
  if (zoom) {
    const visual = zoom.parentElement?.querySelector('svg,img'); if (!visual) return;
    const clone = visual.cloneNode(true) as SVGElement | HTMLImageElement; clone.style.maxWidth = 'none'; clone.style.width = '800px'; clone.style.height = 'auto';
    $('zoom-content').replaceChildren(clone); $<HTMLInputElement>('zoom-scale').value = '100'; $<HTMLDialogElement>('diagram-viewer').showModal(); return;
  }
  const target = e.target as Element, attachment = target.closest<HTMLElement>('[data-attachment]');
  if (attachment && current?.revision) { e.preventDefault(); const session = current, resource = session.revision!.resources.find(r => r.id === attachment.dataset.attachment)!; safely(async () => { const bytes = await session.content(resource), a = document.createElement('a'); a.href = dataUrl(bytes, 'application/octet-stream'); a.download = resource.originalReference.split('/').at(-1)?.split(/[?#]/)[0] || 'attachment'; a.click(); }); return; }
  const link = target.closest<HTMLElement>('[data-document-link]');
  if (link) { e.preventDefault(); const raw = link.dataset.documentLink!, parts = raw.split('#'); safely(async () => { if (parts[0]) { const resolved = new URL(parts[0], `https://review.invalid/${activeDocument}`).pathname.slice(1); const doc = decodeURIComponent(resolved); if (!current?.revision?.documents.some(d => d.path === doc)) throw new Error('Linked document is not part of this frozen revision.'); activeDocument = doc; chrome(); await showDocument(); } if (parts[1]) { const fragment = decodeURIComponent(parts[1]); const exact = [...$('document').querySelectorAll<HTMLElement>('[data-source-bookmark]')].find(element => element.dataset.sourceBookmark === fragment); const heading = exact ?? [...$('document').querySelectorAll('h1,h2,h3,h4,h5,h6')].find(h => h.textContent?.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s/g, '-') === fragment); heading?.scrollIntoView({ block: 'start' }); } }); return; }
  const suggestionJump = target.closest<HTMLElement>('[data-suggestion-jump]');
  if (suggestionJump) { const id = suggestionJump.dataset.suggestionJump!; $<HTMLInputElement>('open-only').checked = false; $<HTMLInputElement>('discussion-search').value = ''; discussionLimit = Math.max(discussionLimit, fold(current!.events, current!.revision!.id).suggestions.findIndex(item => item.root.suggestionId === id) + 1); stateView(); document.querySelectorAll('.focused').forEach(element => element.classList.remove('focused')); const card = document.getElementById(`suggestion-${id}`); card?.scrollIntoView({ behavior: 'smooth', block: 'center' }); card?.classList.add('focused'); return; }
  const marked = target.closest<HTMLElement>('[data-thread-ids]');
  const suggested = target.closest<HTMLElement>('[data-suggestion-ids]');
  if (marked) { const id = marked.dataset.threadIds!.split(' ')[0]; $<HTMLInputElement>('open-only').checked = false; $<HTMLInputElement>('discussion-search').value = ''; discussionLimit = Math.max(discussionLimit, fold(current!.events, current!.revision!.id).threads.findIndex(t => t.root.threadId === id) + 1); stateView(); document.querySelectorAll('.focused').forEach(element => element.classList.remove('focused')); const thread = document.getElementById(`thread-${id}`); thread?.scrollIntoView({ behavior: 'smooth', block: 'center' }); thread?.classList.add('focused'); }
  else if (suggested) { const id = suggested.dataset.suggestionIds!.split(' ')[0]; $<HTMLInputElement>('open-only').checked = false; $<HTMLInputElement>('discussion-search').value = ''; discussionLimit = Math.max(discussionLimit, fold(current!.events, current!.revision!.id).suggestions.findIndex(item => item.root.suggestionId === id) + 1); stateView(); document.querySelectorAll('.focused').forEach(element => element.classList.remove('focused')); const card = document.getElementById(`suggestion-${id}`); card?.scrollIntoView({ behavior: 'smooth', block: 'center' }); card?.classList.add('focused'); }
  $('document').querySelectorAll('.selected').forEach(el => el.classList.remove('selected')); semantic = target.closest<HTMLElement>('.semantic') ?? undefined;
  semantic?.classList.add('selected'); $('selection').textContent = semantic ? `${semantic.dataset.kind} selected` : ''; updateSelectionActions();
});
$('reconnect').addEventListener('click', () => safely(async () => {
  if (!remembered) return; const api = remembered.root as FileSystemDirectoryHandle & { requestPermission(o: { mode: string }): Promise<string> };
  opening('Waiting for permission to resume this review…');
  try {
    if (await api.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Access was not granted. Use Choose review folder or Open read-only.');
    await attach(new BrowserStorage(remembered.root, remembered.reviewId, true), launcher ?? remembered);
  } catch (error) { opening(); throw error; }
}));
$('zoom-close').addEventListener('click', () => $<HTMLDialogElement>('diagram-viewer').close());
$('zoom-scale').addEventListener('input', () => { const visual = $('zoom-content').querySelector<SVGElement | HTMLImageElement>('svg,img'); if (visual) visual.style.width = `${Number($<HTMLInputElement>('zoom-scale').value) * 8}px`; });
$('document').addEventListener('keydown', event => { const target = event.target as HTMLElement; if ((event.key === 'Enter' || event.key === ' ') && target.classList.contains('semantic')) { event.preventDefault(); target.click(); } });
$('forget').addEventListener('click', () => safely(async () => { documentController?.abort(); exportController?.abort(); if (current) { for (const [key, s] of sessions) if (s === current) sessions.delete(key); } current = undefined; generation++; renderKey = ''; $('workspace').hidden = true; $('toolbar').hidden = true; $('welcome').hidden = false; remembered = undefined; $('reconnect').hidden = true; await localValue(connectionKey, null); status('Connection forgotten. Shared review files are unchanged.'); }));
for (const id of ['actor-id', 'actor-name']) {
  $(id).addEventListener('input', () => { identityGeneration++; lastStateKey = ''; stateView(); });
  $(id).addEventListener('change', () => { const actor = selectedReviewer(); if (actor) rememberReviewer(actor); });
}
document.addEventListener('selectionchange', updateSelectionActions);
try { showReviewer(JSON.parse(localStorage.getItem('omr.identity') ?? '{}')); } catch { /* Storage is optional for identity. */ }
if (launcher) {
  document.title = `${launcher.title} · Open Markdown Review`;
  $('title').textContent = launcher.title;
  $('welcome-title').textContent = `Start ${launcher.title}`;
  $('welcome-detail').innerHTML = `This launcher is bound to <strong>${esc(launcher.title)}</strong>. On first use, allow access to the folder containing this file and <strong>manifest.json</strong>. Review evidence remains in that folder; no document or comment copy is embedded here.`;
  $('connect').textContent = `Start ${launcher.title}…`;
  $('reconnect').textContent = `Resume ${launcher.title}`;
}
if (document.querySelector('meta[name="open-markdown-review-companion"][content="1"]')) $('companion-status').hidden = false;
if (rpc) { $('another').hidden = true; $('forget').hidden = true; safely(connectHost); }
else if (!window.showDirectoryPicker) { $<HTMLButtonElement>('connect').disabled = true; $<HTMLButtonElement>('read-only').disabled = true; $('compatibility').textContent = 'Direct folder access is unavailable here. Open this HTML file in a supported Edge/Chrome browser, or connect the package in VS Code.'; }
else safely(async () => {
  try { remembered = await localValue<RememberedConnection>(connectionKey); } catch { return; }
  if (!remembered) return;
  if (launcher && (remembered.reviewId !== launcher.reviewId || remembered.manifestDigest !== launcher.manifestDigest)) { remembered = undefined; await localValue(connectionKey, null); return; }
  const api = remembered.root as FileSystemDirectoryHandle & { queryPermission?(o: { mode: string }): Promise<string> };
  let permission = 'prompt'; try { permission = await api.queryPermission?.({ mode: 'readwrite' }) ?? 'prompt'; } catch { /* A visible resume remains available. */ }
  if (permission !== 'granted') { $('reconnect').hidden = false; return; }
  status(`Opening ${launcher?.title ?? 'remembered review'}…`);
  try { await attach(new BrowserStorage(remembered.root, remembered.reviewId, true), launcher ?? remembered); }
  catch (error) { $('reconnect').hidden = false; throw error; }
});
window.omrAutomation = { connect: connectHost, export: async (actor, revision, operation) => { if (!current) await connectHost(); await current!.pin(revision); return exportAudit(current!.context(actor), undefined, operation); }, session: () => current };
document.documentElement.dataset.clientReady = 'true';
window.addEventListener('message', event => {
  if (rpc && event.data?.command === 'reviewer-identity' && reviewerIdentity(event.data.reviewer)) { identityGeneration++; showReviewer(event.data.reviewer); lastRememberedReviewer = JSON.stringify(reviewerIdentity(event.data.reviewer)); return; }
  if (rpc && event.data?.command === 'source-binding') { canApply = event.data.canApply === true; lastStateKey = ''; stateView(); return; }
  if (rpc && event.data?.command === 'toolbox-action' && ['workbench', 'threads', 'suggestions', 'history', 'status'].includes(event.data.buttonId)) { $(event.data.buttonId).scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
  if (rpc && event.data?.command === 'toolbox-action' && ['comment', 'suggest', 'approve', 'reject', 'withdraw', 'export', 'refresh'].includes(event.data.buttonId)) {
    const selection = event.data.selection;
    if (selection && typeof selection.source === 'string' && typeof selection.document === 'string' && Number.isInteger(selection.start) && Number.isInteger(selection.end) && selection.start >= 0 && selection.end > selection.start && selection.end <= selection.source.length) externalAnchor = { document: selection.document, documentDigest: digest(selection.source), range: { start: pointAt(selection.source, selection.start), end: pointAt(selection.source, selection.end) }, quote: { exact: selection.source.slice(selection.start, selection.end) }, target: { kind: 'text' } };
    $(event.data.buttonId).click();
  }
});
