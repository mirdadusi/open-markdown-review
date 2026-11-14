import { BrowserStorage, localValue } from './browserStorage';
import { SLIDEV_ID, SlidevProfile } from './profiles/slidev';
import { renderSlide, sourceView, frozenReferenceLinks } from './profiles/slidevView';
import { ReviewSession, ActionContext } from './session';
import { JournalEntry, Storage } from './storage';
import { ActorRef, COMMENT_EDITS, Event, LIMITS, MarkdownAnchor, Payload, ProtocolError, REVIEWER_COMPLETION, REVIEWER_INVITATIONS, THREAD_ADDRESSING } from './types';
import { decode, digest, jsonBytes, newId, parseJson, pointAt, offsetAt, toBase64, fromBase64 } from './bytes';
import { companionHost } from './companionTransport';
import { fold, heads, predecessors, reviewerProgress, threadWorkflowQueue, ThreadWorkflowQueue } from './state';
import { annotate, applyAnnotationHighlights, escapeHtml as esc, renderDocument, RenderedSource, selectionAnchor } from './rendering';
import { dataUrl, populateAssets } from './assets';
import { exportAudit, ExportResult } from './export';
import { PdfExportMode, pdfExportMode, pdfDocumentList, pdfDocumentListFromRenderer, pdfOrientation, pdfOrientationFromRenderer } from './pdfProfiles';
import { documentExportPlan, DOCUMENT_EXPORT_ID_PREFIX } from './documentExportPlan';
import { effectiveReviewers, parseReviewerEmails, reviewerEmail, reviewerForInput, reviewerIdentity, reviewerRoster } from './reviewer';
import { DocumentReader } from './reader';
import { PdfTemplateOptions, PdfTemplateField, PDF_METADATA_FIELDS, selectPdfTemplate, pdfTemplateFingerprint, pdfExportFingerprint } from './pdfTemplate';
import { PdfExportDialog } from './pdfExportDialog';
import { pdfRevisionChoices } from './exportRevisions';
import { FindingPublicationDialog } from './findingPublicationDialog';
import { FindingPreparationDialog } from './findingPreparationDialog';
import { FindingScopePlan, FindingScopeChoice } from './findingScope';
import { FindingScopeDialog } from './findingScopeDialog';
import { eligibleFixRevisions, publishedFixChoices } from './publishedFixes';
import { mountPublishedFixPicker } from './publishedFixPicker';
import { findingActions } from './findingActions';
import { implementationSummary } from './implementationNote';
import { ReviewFindingsIndex } from './reviewFindings';
import { matchesFindingFilters } from './findingFilters';
import { reopenFinding } from './reopenFinding';
import type { FindingPublicationPreview, FindingPublicationResult, FindingSelection } from './findingPublication';

declare global {
  interface Window {
    acquireVsCodeApi?: () => { postMessage(message: unknown): void };
    omrHost?: (method: string, args: unknown[]) => Promise<unknown>;
    omrAutomation?: { connect(): Promise<void>; export(actor: ActorRef, revision: string, operationId: string, mode?: PdfExportMode, template?: PdfTemplateOptions): Promise<unknown>; session(): ReviewSession | undefined };
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
const companionStoppedNotice = 'Local companion stopped. Saved review files are unchanged. Close this tab; use StartReview or VS Code to reopen.';
let lastStateKey = '';
let lastChromeKey = '';
let discussionLimit = 50, historyLimit = 100;
let canApply = false, externalAnchor: MarkdownAnchor | undefined;
let canAuthorFindings = false, publicationPreparing = false;
const publicationDialog = new FindingPublicationDialog();
const preparationDialog = new FindingPreparationDialog();
let preparationRequest: { id: string; origin: string; actor: ActorRef } | undefined;
let publicationRequest: string | undefined;
const findingIndexes = new WeakMap<ReviewSession, ReviewFindingsIndex>();
function findings(session = current!) { let index = findingIndexes.get(session); if (!index) { index = new ReviewFindingsIndex(); findingIndexes.set(session, index); } return index.update(session.events); }
function snapshotLabel(id: string, session = current!) { return findings(session).labels(session.revisions.values()).get(id) ?? 'Unavailable snapshot'; }
const snapshotScopeLabel = document.createElement('label'); snapshotScopeLabel.innerHTML = 'Finding snapshots<select id="finding-snapshot-scope"><option value="all" selected>All review snapshots</option><option value="current">Displayed snapshot only</option></select>';
$('discussion-scope').closest('label')!.before(snapshotScopeLabel);
const snapshotNotice = document.createElement('p'); snapshotNotice.id = 'finding-snapshot-notice'; snapshotNotice.setAttribute('role', 'status'); $('discussion-count').after(snapshotNotice);
const viewPreferenceKey = (session: ReviewSession) => `omr.view:${session.manifest.reviewId}`;
function rememberView() { if (!current?.revision) return; try { localStorage.setItem(viewPreferenceKey(current), JSON.stringify({ revisionId: current.revision.id, snapshots: $<HTMLSelectElement>('finding-snapshot-scope').value })); } catch { /* Optional private preference only. */ } }
function resetFindingFilters() {
  for (const id of ['workflow-queue', 'discussion-status', 'decision-status']) $<HTMLSelectElement>(id).value = 'all';
  $<HTMLInputElement>('discussion-search').value = '';
}
async function showSnapshot(id: string) {
  const session = current; if (!session) return;
  await session.pin(id); await session.prepareReadingOrder();
  if (current !== session || session.pinnedRevisionId !== id) return;
  activeSlide = undefined; generation++; activeDocument = session.revision!.rootDocument;
  rememberView(); lastChromeKey = ''; lastStateKey = ''; chrome(); await showDocument();
}
const publicationButton = document.createElement('button'); publicationButton.id = 'publish-documents'; publicationButton.textContent = 'Publish updated documents…'; publicationButton.hidden = true; $('export').before(publicationButton);
const advancedPublicationButton = document.createElement('button'); advancedPublicationButton.id = 'configure-revision'; advancedPublicationButton.textContent = 'Change scope / advanced setup…'; advancedPublicationButton.hidden = true; $('workbench').append(advancedPublicationButton);
let exportBusy = false;
let exportConfiguring = false;
let exportMode: PdfExportMode = 'review';
let templateOptions: PdfTemplateOptions = {};
let templateEditedFields: PdfTemplateField['key'][] | undefined;
const exportDialog = new PdfExportDialog();
const templatePreferenceKey = (session: ReviewSession) => `omr.pdf-template:${session.manifest.reviewId}`;
const exportModePreferenceKey = (session: ReviewSession) => `omr.pdf-export-mode:${session.manifest.reviewId}`;
const exportPreferenceKey = (session: ReviewSession) => `pdf-export-preferences-v1:${session.manifest.reviewId}`;
function exportUiKey(session: ReviewSession, mode: PdfExportMode, revision: string, actor: string) {
  const fingerprint = pdfExportFingerprint(templateOptions, mode);
  return `export-ui:${mode}:${digest(`${revision}\0${actor}${fingerprint === 'Default' ? '' : `\0${fingerprint}`}`).slice(7)}`;
}
let exportController: AbortController | undefined;
let canOpenExports = false;
interface ExportNotice { kind: 'busy' | 'error' | 'success' | 'cancelled'; message: string; result?: ExportResult }
const exportNotices = new Map<string, ExportNotice>();
const exportKey = (session: ReviewSession, mode: PdfExportMode = exportMode) => `${session.storage.identity}\0${session.manifest.reviewId}\0${mode}\0${pdfExportFingerprint(templateOptions, mode)}`;
function exportNotice() { return current ? exportNotices.get(exportKey(current)) : undefined; }
function showExportNotice(session: ReviewSession, notice: ExportNotice, key = exportKey(session)) {
  exportNotices.set(key, notice);
  if (current === session && exportKey(session) === key) { renderExportNotice(); status(notice.message, notice.kind === 'error'); }
}
function renderExportNotice() {
  const notice = exportNotice(), result = notice?.result;
  $('export-result').hidden = !notice; $('export-result').dataset.kind = notice?.kind ?? '';
  $('export-result-title').textContent = notice?.kind === 'error' ? 'PDF export failed' : notice?.kind === 'success' ? 'PDF export saved' : notice?.kind === 'cancelled' ? 'PDF export cancelled' : exportMode === 'clean' ? 'Creating clean PDF' : 'Creating review PDF';
  $('export-result-message').textContent = notice?.message ?? '';
  $('export-result-path').textContent = result ? `Review folder: ${result.pdfPath}${result.inventoryPath ? `\nAudit inventory: ${result.inventoryPath}` : ''}` : '';
  $('open-export').hidden = !result || !canOpenExports; $('reveal-export').hidden = !result || !canOpenExports;
  $('download-export').hidden = !result || canOpenExports;
  $<HTMLButtonElement>('dismiss-export-result').disabled = notice?.kind === 'busy';
}
let identityGeneration = 0, canRememberReviewer = false, lastRememberedReviewer = '';
let identitySave: Promise<unknown> = Promise.resolve();
function status(message: string, error = false) { $('status').textContent = companionStopped ? companionStoppedNotice : message; $('status').classList.toggle('error', !companionStopped && error); }
function toast(message: string) { $('toast').textContent = message; $('toast').classList.add('visible'); setTimeout(() => $('toast').classList.remove('visible'), 4500); }
function report(error: unknown) { status(error instanceof Error ? error.message : String(error), true); }
const safely = (work: () => Promise<unknown>) => { void work().catch(error => { if (!(error instanceof ProtocolError && error.code === 'cancelled') && !(error instanceof DOMException && error.name === 'AbortError')) report(error); }); };
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
function identity(): ActorRef { const actor = selectedReviewer(); if (!actor) { $('actor-id').focus(); throw new Error(current?.manifest.reviewers ? 'Enter the email address you were invited with. If it is not listed, contact the review initiator.' : 'Enter a reviewer ID first (1–128 characters, no control characters). It will be written to each event.'); } rememberReviewer(actor); return actor; }
function context(): ActionContext { if (!current) throw new Error('Open a review first.'); return current.context(identity()); }
function isReviewCreator(actor = selectedReviewer()): boolean { return !!current && !!actor && actor.id === current.manifest.createdBy.id; }
function feedbackLocked(revisionId = current?.revision?.id): boolean {
  const actor = selectedReviewer();
  if (!current?.revision || !actor) return true;
  if (!current.manifest.requiredCapabilities.includes(REVIEWER_COMPLETION)) return false;
  const completion = current.events.filter(e => e.revisionId === revisionId && e.actor.id === actor.id && 'completionPredecessors' in e);
  return heads(completion).some(e => e.type === 'review.completed');
}
function descendantRevisions(fromRevisionId: string, document: string) {
  return current ? eligibleFixRevisions(current.revisions.values(), fromRevisionId, document).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id)) : [];
}
const workflowLabel: Record<ThreadWorkflowQueue, string> = {
  conflict: 'Conflict', 'needs-decision': 'Needs decision', 'accepted-not-implemented': 'Change required',
  implemented: 'Implemented', challenged: 'Reopened · change required', verified: 'Implemented', disposed: 'No change planned'
};
function updateSelectionActions() {
  const actions = $('selection-actions'), selection = document.getSelection();
  const textSelected = !!selection && !selection.isCollapsed && $('document').contains(selection.anchorNode) && $('document').contains(selection.focusNode);
  const page = reader.pageFor(selection?.anchorNode ?? semantic ?? null), endPage = reader.pageFor(selection?.focusNode ?? semantic ?? null);
  const writable = !!current?.revision && current.storage.writable && !feedbackLocked() && !$<HTMLDialogElement>('composer').open && (!textSelected || page === endPage);
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
  if (!current || companionStopped) return;
  const key = `${current.storage.identity}:${activeDocument}:${activeSlide}:${current.pinnedRevisionId}:${findings().version}:${[...current.revisions.keys()].join(',')}:${[...sessions.keys()].join(',')}`;
  if (key === lastChromeKey) { progress(); return; }
  lastChromeKey = key;
  $('title').textContent = current.manifest.title; $('welcome').hidden = true; $('toolbar').hidden = false; $('workspace').hidden = false;
  $('reviews').innerHTML = [...sessions.entries()].map(([key, session]) => `<option value="${esc(key)}" ${session === current ? 'selected' : ''}>${esc(session.manifest.title)}</option>`).join('');
  const labels = findings().labels(current.revisions.values());
  $('revisions').innerHTML = `${!current.revision ? '<option value="">Choose a snapshot…</option>' : ''}${[...current.revisions.values()].map(r => `<option value="${r.id}" title="${r.id}" ${r.id === current!.pinnedRevisionId ? 'selected' : ''}>${esc(labels.get(r.id)!)}${current!.heads.some(h => h.id === r.id) ? current!.heads.length === 1 ? ' · latest' : ' · branch head' : ''}</option>`).join('')}`;
  const revision = current.revision;
  if (revision) {
    const profile = presentation();
    if (profile && activeSlide === undefined) { activeSlide = profile.slides[0].id; activeDocument = profile.slides[0].document; }
    if (!revision.documents.some(d => d.path === activeDocument)) activeDocument = revision.rootDocument;
    $('documents').innerHTML = (profile ? `<li><h3>Slides</h3></li>${profile.slides.map(s => `<li><button data-slide="${s.id}" class="${s.id === activeSlide ? 'active' : ''}">${s.number}. ${esc(s.title)}</button></li>`).join('')}<li><h3>Frozen source files</h3></li>` : '') + current.readingPaths().map(path => `<li><button data-document="${esc(path)}" class="${!activeSlide && path === activeDocument ? 'active' : ''}">${esc(path)}</button></li>`).join('');
  }
  const locked = feedbackLocked();
  for (const id of ['comment', 'suggest', 'approve', 'reject', 'withdraw', 'export']) $<HTMLButtonElement>(id).disabled = (id === 'export' ? !current.revisions.size : !revision) || !current.storage.writable || (id === 'export' ? exportBusy || exportConfiguring : locked);
  progress(); updateSelectionActions();
}
function stateView() {
  if (!current?.revision) return;
  const discussion = $<HTMLSelectElement>('discussion-status').value, decision = $<HTMLSelectElement>('decision-status').value;
  const query = $<HTMLInputElement>('discussion-search').value.trim().toLocaleLowerCase();
  const scope = $<HTMLSelectElement>('discussion-scope').value === 'document' ? 'document' : 'all';
  const workflow = $<HTMLSelectElement>('workflow-queue').value;
  const allSnapshots = $<HTMLSelectElement>('finding-snapshot-scope').value !== 'current', index = findings();
  const reviewer = selectedReviewer(), creator = isReviewCreator(reviewer);
  const identityInput = $<HTMLInputElement>('actor-id'), emailEntry = !!current.manifest.reviewers && !creator;
  $('actor-id-label').textContent = emailEntry ? 'Your reviewer email' : creator && current.manifest.reviewers ? 'Initiator ID' : 'Reviewer ID';
  identityInput.type = emailEntry ? 'email' : 'text'; identityInput.maxLength = emailEntry ? 254 : 128; identityInput.autocomplete = emailEntry ? 'email' : 'username'; identityInput.placeholder = emailEntry ? 'Your invited work email' : 'Your stable reviewer ID';
  $('identity-help').textContent = emailEntry ? 'Use an email listed by the initiator. Email ownership is self-asserted.' : 'Identity is self-asserted, not a Windows login.';
  const entered = identityInput.value.trim();
  identityInput.setAttribute('aria-invalid', String(!!entered && !reviewer));
  identityInput.setAttribute('aria-describedby', 'identity-help reviewer-guidance-text');
  $('reviewer-guidance').dataset.state = reviewer ? 'ready' : entered ? 'invalid' : 'needed';
  const email = reviewer && effectiveReviewers(current.manifest, current.events).find(r => r.id === reviewer.id)?.email;
  $('reviewer-guidance-text').textContent = reviewer ? `Reviewing as ${email ?? reviewer.displayName ?? reviewer.id}` : emailEntry ? entered ? reviewerEmail(entered) ? 'This email is not on the reviewer list. Check your invitation or contact the initiator.' : 'Enter the complete email address from your invitation (name@example.com).' : 'Before commenting, enter the email address you were invited with.' : 'Before commenting, enter your reviewer ID.';
  $('set-reviewer').textContent = reviewer ? 'Change identity' : emailEntry ? 'Enter reviewer email' : 'Enter reviewer ID';
  const stateKey = `${current.storage.identity}:${current.revision.id}:${activeDocument}:${reviewer?.id ?? ''}:${scope}:${allSnapshots}:${workflow}:${discussion}:${decision}:${query}:${discussionLimit}:${historyLimit}:${renderKey}:${current.events.map(e => e.id).join(',')}`;
  if (stateKey === lastStateKey) return;
  lastStateKey = stateKey;
  const focused = document.activeElement as HTMLElement | null;
  const restoreFocus = focused?.closest('#threads, #suggestions') && focused instanceof HTMLButtonElement ? { action: focused.dataset.action, thread: focused.dataset.thread, suggestion: focused.dataset.suggestion } : undefined;
  const state = index.state(current.revision.id);
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
  const completionLocks = new Map<string, boolean>(), descendants = new Map<string, ReturnType<typeof descendantRevisions>>();
  const lockedFor = (revision: string) => { if (!completionLocks.has(revision)) completionLocks.set(revision, feedbackLocked(revision)); return completionLocks.get(revision)!; };
  const candidatesFor = (revision: string, document: string) => { const key = `${revision}:${document}`; if (!descendants.has(key)) descendants.set(key, descendantRevisions(revision, document)); return descendants.get(key)!; };
  publicationButton.hidden = !canAuthorFindings || !creator || !addressingEnabled;
  publicationButton.disabled = !current.storage.writable || publicationPreparing;
  advancedPublicationButton.hidden = !canAuthorFindings || !creator;
  advancedPublicationButton.disabled = !current.storage.writable || publicationPreparing;
  const workflowMatches = (queue: ThreadWorkflowQueue) => workflow === 'all' || workflow === queue || workflow === 'implemented' && queue === 'verified' || workflow === 'creator-action' && ['conflict', 'needs-decision', 'accepted-not-implemented', 'challenged'].includes(queue);
  const visibleThreads = allSnapshots ? index.threads : state.threads, visibleSuggestions = allSnapshots ? index.suggestions : state.suggestions;
  const matchingThreads = visibleThreads.filter(t => (scope === 'all' || t.root.anchor.document === activeDocument) && workflowMatches(threadWorkflowQueue(t)) && matchesFindingFilters(t, discussion, decision) && (!query || JSON.stringify(t).toLocaleLowerCase().includes(query)));
  const matchingSuggestions = visibleSuggestions.filter(s => (scope === 'all' || s.root.anchor.document === activeDocument) && matchesFindingFilters(s, discussion, decision) && (!query || JSON.stringify(s).toLocaleLowerCase().includes(query)));
  const ownStance = reviewer ? state.stances.find(stance => stance.actor === reviewer.id) : undefined;
  const activeStance = !!ownStance?.heads.some(event => event.type === 'review.approved' || event.type === 'review.rejected');
  const stanceLabel = !reviewer ? 'enter reviewer ID' : ownStance?.conflict ? 'conflicted' : ownStance?.heads.every(event => event.type === 'review.approved') ? 'approved' : ownStance?.heads.every(event => event.type === 'review.rejected') ? 'rejected' : ownStance?.heads.every(event => event.type === 'review.withdrawn') ? 'withdrawn' : 'not set';
  $('stance-status').textContent = `Your status: ${stanceLabel}`;
  $<HTMLButtonElement>('approve').hidden = activeStance; $<HTMLButtonElement>('reject').hidden = activeStance; $<HTMLButtonElement>('withdraw').hidden = !activeStance;
  const queueCounts = visibleThreads.reduce((counts, thread) => { const queue = threadWorkflowQueue(thread); counts[queue] = (counts[queue] ?? 0) + 1; return counts; }, {} as Partial<Record<ThreadWorkflowQueue, number>>);
  const commentView = (comment: ReturnType<typeof fold>['comments'] extends Map<string, infer C> ? C : never, thread: typeof visibleThreads[number]) => {
    const queue = threadWorkflowQueue(thread), editable = comment.original.actor.id === reviewer?.id && thread.open && !lockedFor(thread.root.revisionId) && !['implemented', 'verified'].includes(queue);
    const enabled = current!.manifest.requiredCapabilities.includes(COMMENT_EDITS);
    const history = comment.edits.history.length ? `<details class="comment-history"><summary>${comment.edits.conflict ? 'Conflicting edits — all versions' : 'Edited · view history'}</summary><p><strong>Original</strong></p><p>${esc(comment.original.body.text)}</p>${comment.edits.history.map(e => e.type === 'comment.edited' ? `<div><strong>${esc(e.actor.displayName ?? e.actor.id)} · ${esc(e.occurredAt)}</strong><p>${esc(e.body.text)}</p></div>` : '').join('')}</details>` : '';
    const text = comment.edits.conflict ? `<p role="alert">Conflicting edits. The author must reconcile these versions.</p>${comment.edits.heads.map(e => e.type === 'comment.edited' ? `<blockquote>${esc(e.body.text)}</blockquote>` : '').join('')}` : `<p class="comment-body">${esc(comment.body.text)}</p>`;
    const lockedReason = comment.original.actor.id !== reviewer?.id || editable ? '' : ['implemented', 'verified'].includes(queue) ? 'This finding is implemented. The initiator must Reopen finding before wording can be corrected.' : !thread.open ? 'The initiator must reopen this closed discussion before wording can be corrected.' : 'Your review of this snapshot is finished. Open original context, then Reopen my review to correct wording.';
    return `${text}${history}${editable ? `<button class="comment-edit" data-action="${enabled ? 'edit-comment' : 'correct-comment'}" data-thread="${thread.root.threadId}" data-comment="${comment.original.commentId}" ${!current!.storage.writable ? 'disabled' : ''}>${enabled ? comment.edits.conflict ? 'Reconcile my edits…' : 'Edit my comment…' : 'Add correction…'}</button>` : lockedReason ? `<p class="role-note comment-edit-lock">${lockedReason}</p>` : ''}`;
  };
  $('summary').innerHTML = `<h2>Displayed snapshot</h2><p>${esc(snapshotLabel(current.revision.id))}</p><p><strong>Your review status: ${esc(stanceLabel)}</strong><br>${state.stances.filter(s => !s.conflict && s.heads[0]?.type === 'review.approved').length} current approvals</p><p><strong>Finding processing · ${allSnapshots ? 'all snapshots' : 'displayed snapshot'}</strong><br>${queueCounts['needs-decision'] ?? 0} need decisions<br>${queueCounts['accepted-not-implemented'] ?? 0} accepted, not implemented<br>${(queueCounts.implemented ?? 0) + (queueCounts.verified ?? 0)} implemented<br>${queueCounts.challenged ?? 0} reopened for changes</p><p class="role-note">${creator ? 'Record a published fix to finish processing. Reopen a finding only if more work is needed.' : `Only ${esc(current.manifest.createdBy.displayName ?? current.manifest.createdBy.id)} can decide, record implementation or reopen findings.`}</p>`;
  $('threads').innerHTML = matchingThreads.slice(0, discussionLimit).map(t => {
    const queue = threadWorkflowQueue(t), candidates = candidatesFor(t.root.revisionId, t.root.anchor.document);
    const accepted = !t.decision.conflict && t.decision.heads.some(event => event.type === 'thread.decided' && event.decision === 'accepted');
    const actions = findingActions({ queue, open: t.open, creator, locked: lockedFor(t.root.revisionId), native: canAuthorFindings, canEdit: canApply, addressing: addressingEnabled, accepted,
      addressed: !!t.addressed, otherRevision: candidates.some(r => r.id !== t.addressed?.toRevisionId), verificationConflict: t.verification.conflict });
    const buttons = (items: typeof actions.primary) => items.map(item => `<button data-action="${item.action}" data-thread="${esc(t.root.threadId)}" ${publicationPreparing && ['publish-fix', 'record-addressed'].includes(item.action) ? 'disabled' : ''}>${item.label}</button>`).join('');
    const primaryActions = `<div class="buttons" data-primary-actions>${buttons(actions.primary)}</div>`;
    const moreActions = actions.more.length ? `<details class="finding-more"><summary>More actions</summary><p>Discussion controls and intentional corrections. Preparing a replacement still requires inspection and confirmation.</p><div class="buttons">${buttons(actions.more)}</div></details>` : '';
    const nextAction = addressingEnabled && creator && accepted && !t.addressed ? `<div class="finding-next"><strong>Next action</strong><p>${canAuthorFindings ? canApply ? 'Edit the working source, then publish and record the outcome. You may update complete documents or multiple files; the original highlight does not limit the change.' : 'Choose Edit source, edit and save, then inspect the publication diff. VS Code uses a verified open workspace or asks you to choose the source folder.' : 'Continue in VS Code to edit source and publish updated documents. This browser can record an already published fix, but cannot author a revision.'}</p>${!canAuthorFindings ? '<p>In VS Code: open this review → Creator workbench → this finding.</p>' : ''}${!candidates.length ? '<p>No descendant snapshot is available to record yet. Acceptance and discussion closure alone do not implement the change.</p>' : ''}</div>` : '';
    const completedNext = t.addressed ? `<div class="finding-next"><strong>${queue === 'implemented' || queue === 'verified' ? 'Processing finished' : 'Next action'}</strong><p>${queue === 'implemented' || queue === 'verified' ? 'The published fix is recorded. No verification step is required. Inspect it for reference, or reopen the finding if more work is needed.' : queue === 'challenged' ? 'This finding was reopened for changes. Prepare and record a replacement fix to finish processing again.' : 'Reconcile the conflicting records before recording another implementation.'}</p></div>` : '';
    const closedNotice = t.open ? '' : `<p class="closed-notice">${queue === 'implemented' || queue === 'verified' ? 'Discussion closed.' : 'Closed: replies and decisions are locked until the review creator reopens this thread.'}</p>`;
    const addressed = t.addressed ? `<div class="addressing"><strong>Implemented in ${esc(snapshotLabel(t.addressed.toRevisionId))}</strong><p>${esc(t.addressed.summary)}</p><details><summary>Implementation evidence</summary><small>${esc(t.addressed.sourceDigestBefore)} → ${esc(t.addressed.sourceDigestAfter)}</small></details></div>` : '';
    const verification = t.verification.heads.map(event => event.type === 'thread.verification.recorded' ? `<p class="verification ${event.verdict}"><strong>${esc(event.verdict)}</strong> by ${esc(event.actor.displayName ?? event.actor.id)}${event.note ? ` · ${esc(event.note)}` : ''}</p>` : '').join('');
    return `<article class="thread ${t.open ? '' : 'closed'}" data-finding-revision="${t.root.revisionId}" id="thread-${t.root.threadId}"><h3>${esc(t.root.actor.displayName ?? t.root.actor.id)} <span class="badge">Discussion: ${t.open ? 'open' : 'closed'}</span> <span class="badge" data-change-state="${queue}">Change: ${esc(workflowLabel[queue])}</span></h3><p class="finding-origin">${esc(snapshotLabel(t.root.revisionId))}${t.root.revisionId !== current!.revision!.id ? ' · From another snapshot' : ''}</p><button data-action="locate" data-thread="${t.root.threadId}">Open original context · ${esc(t.root.anchor.document)}:${t.root.anchor.range.start.line + 1}</button><blockquote>${esc(t.root.anchor.quote.exact)}</blockquote>${commentView(t.comment, t)}${t.replies.map(e => `<div class="reply"><strong>${esc(e.actor.displayName ?? e.actor.id)}</strong>${commentView(index.state(t.root.revisionId).comments.get(e.commentId)!, t)}</div>`).join('')}<p class="badge">${t.decision.heads.map(e => e.type === 'thread.decided' ? esc(e.decision + (e.reason ? ': ' + e.reason : '')) : '').join(' / ')}</p>${addressed}${verification}${closedNotice}${nextAction}${completedNext}${primaryActions}${moreActions}</article>`;
  }).join('') || '<p>No matching comments.</p>';
  $('suggestions').innerHTML = matchingSuggestions.slice(0, discussionLimit).map(s => `<article class="suggestion" data-finding-revision="${s.root.revisionId}" id="suggestion-${s.root.suggestionId}"><h3>${esc(s.root.operation.kind)} · ${esc(s.status)}</h3><p class="finding-origin">${esc(snapshotLabel(s.root.revisionId))}${s.root.revisionId !== current!.revision!.id ? ' · From another snapshot' : ''}</p><button data-suggestion="${s.root.suggestionId}" data-action="locate">Open original context · ${esc(s.root.anchor.document)}:${s.root.anchor.range.start.line + 1}</button><blockquote>${s.root.operation.kind === 'insert' ? esc(s.root.anchor.quote.exact) : `<del>${esc(s.root.anchor.quote.exact)}</del>`}${s.root.operation.kind !== 'delete' ? `<ins>${esc(s.root.operation.replacement)}</ins>` : ''}</blockquote><p>${esc(s.root.rationale.text)}</p><div class="buttons">${s.open && !feedbackLocked(s.root.revisionId) ? `<button data-suggestion="${s.root.suggestionId}" data-action="accept-suggestion">Accept</button><button data-suggestion="${s.root.suggestionId}" data-action="reject-suggestion">Reject</button>` : ''}</div></article>`).join('') || '<p>No suggested edits.</p>';
  $('history').innerHTML = state.current.slice(-historyLimit).reverse().map(e => `<div class="history-item"><strong>${esc(e.type)}</strong><br>${esc(e.actor.displayName ?? e.actor.id)} · ${esc(e.occurredAt)}<details><summary>Full event and reasons</summary><pre>${esc(JSON.stringify(e, null, 2))}</pre></details></div>`).join('');
  $('more-discussions').hidden = Math.max(matchingThreads.length, matchingSuggestions.length) <= discussionLimit;
  const profile = presentation();
  if (profile) for (const finding of [...matchingThreads.slice(0, discussionLimit).map(item => ({ anchor: item.root.anchor, selector: `[data-action="locate"][data-thread="${item.root.threadId}"]` })), ...matchingSuggestions.slice(0, discussionLimit).map(item => ({ anchor: item.root.anchor, selector: `[data-action="locate"][data-suggestion="${item.root.suggestionId}"]` }))]) {
    const target = finding.anchor.target, start = finding.anchor.document === activeDocument ? offsetAt(source, finding.anchor.range.start) : -1;
    const slide = target?.kind === 'image' ? profile.slides.find(s => s.previewResourceId === target.resourceId) : profile.slides.find(s => s.document === finding.anchor.document && start >= 0 && s.range.start <= start && s.range.end > start);
    const button = document.querySelector<HTMLButtonElement>(finding.selector);
    if (slide && button && button.closest<HTMLElement>('[data-finding-revision]')?.dataset.findingRevision === current.revision.id) { button.textContent = `Open original context · Slide ${slide.number} · ${slide.title}`; button.title = `${slide.document}:${finding.anchor.range.start.line + 1}`; }
  }
  $('more-history').hidden = state.current.length <= historyLimit;
  const scopeLabel = `${scope === 'all' ? 'across all review documents' : `on ${activeDocument}`} · ${allSnapshots ? 'all snapshots' : 'displayed snapshot only'}`;
  $('discussion-count').textContent = `${matchingThreads.length} comments · ${matchingSuggestions.length} edits ${scopeLabel}${workflow !== 'all' ? ` · queue: ${workflow}` : ''}${discussion !== 'all' ? ` · discussion: ${discussion}` : ''}${decision !== 'all' ? ` · decision: ${decision === 'undecided' ? 'no decision' : decision}` : ''}${query ? ' matching search' : ''}`;
  const elsewhere = [...index.threads, ...index.suggestions].filter(item => item.root.revisionId !== current!.revision!.id).length;
  snapshotNotice.textContent = allSnapshots ? `${elsewhere} finding(s) belong to other snapshots. Original context opens the exact reviewed text; comments are never moved to newer text.` : `${elsewhere} finding(s) on other snapshots are hidden by this view.`;
  if (!allSnapshots || scope !== 'all' || workflow !== 'all' || discussion !== 'all' || decision !== 'all' || query) { const reset = document.createElement('button'); reset.textContent = 'Show all findings'; reset.id = 'show-all-findings'; reset.onclick = () => { $<HTMLSelectElement>('finding-snapshot-scope').value = 'all'; $<HTMLSelectElement>('discussion-scope').value = 'all'; resetFindingFilters(); discussionLimit = 50; rememberView(); lastStateKey = ''; stateView(); }; snapshotNotice.append(' ', reset); }
  annotateReadingPages();
  for (const section of document.querySelectorAll<HTMLElement>('.thread .buttons, .suggestion .buttons')) for (const button of section.querySelectorAll<HTMLButtonElement>('button')) button.disabled = !current.storage.writable || publicationPreparing && ['publish-fix', 'record-addressed'].includes(button.dataset.action ?? '');
  if (canApply) for (const suggestion of visibleSuggestions.filter(s => s.status === 'accepted')) {
    const actions = $('suggestions').querySelector<HTMLElement>(`[data-suggestion="${suggestion.root.suggestionId}"]`)?.parentElement;
    if (actions) { const button = document.createElement('button'); button.dataset.suggestion = suggestion.root.suggestionId; button.dataset.action = 'apply-suggestion'; button.textContent = 'Apply to source…'; actions.append(button); }
  }
  if (restoreFocus) {
    const target = [...document.querySelectorAll<HTMLButtonElement>('#threads button, #suggestions button')].find(b => b.dataset.action === restoreFocus.action && b.dataset.thread === restoreFocus.thread && b.dataset.suggestion === restoreFocus.suggestion);
    target?.focus({ preventScroll: true });
  }
  updateSelectionActions();
}
function readingOffset() { return $('toolbar').offsetHeight + 12; }
let continuousReading = true;
try { continuousReading = localStorage.getItem('omr.continuous-reading') !== 'false'; } catch { /* Optional private preference. */ }
$<HTMLInputElement>('continuous-reading').checked = continuousReading;
const reader = new DocumentReader<{ text: string; render: RenderedSource }>($('document'), {
  offset: readingOffset,
  hold: () => $<HTMLDialogElement>('composer').open || publicationDialog.open || !!document.querySelector<HTMLDialogElement>('#fix-inspection')?.open || !!document.getSelection()?.toString(),
  load: async (selected, signal) => {
    const session = current!, revision = session.revision!, profile = presentation(), slide = profile?.slides.find(s => s.id === activeSlide);
    const doc = revision.documents.find(d => d.path === selected)!;
    const text = decode(await session.content(doc)); signal.throwIfAborted();
    const render = slide && profile ? renderSlide(profile, slide, text) : profile ? sourceView(text) : renderDocument(text, selected, revision);
    const body = document.createElement('article'); body.innerHTML = render.html;
    if (profile) body.insertAdjacentHTML('beforeend', frozenReferenceLinks(revision, selected));
    await populateAssets(body, revision, c => session.content(c), { signal }); signal.throwIfAborted();
    for (const figure of body.querySelectorAll<HTMLElement>('[data-diagram-id]')) { const zoom = document.createElement('button'); zoom.dataset.zoom = figure.dataset.diagramId; zoom.textContent = 'Zoom diagram'; figure.append(zoom); }
    return { body, value: { text, render } };
  },
  active: page => { activeDocument = page.path; source = page.value.text; rendered = page.value.render; semantic = undefined; renderKey = `${current?.storage.identity}:${current?.revision?.id}:${page.path}:${activeSlide}`; lastStateKey = ''; },
  mounted: () => annotateReadingPages(),
  changed: () => { chrome(); stateView(); readerNavigation(); }
});
function annotateReadingPages() {
  if (!current?.revision) return;
  const state = fold(current.events, current.revision.id), ranges = { comments: [] as Range[], edits: [] as Range[] };
  for (const page of reader.mounted) annotate(page.body, page.value.render, page.value.text, state.current, page.path, ranges);
  applyAnnotationHighlights(ranges);
}
function readerNavigation() {
  const paths = current?.readingPaths() ?? [], index = paths.indexOf(activeDocument);
  $('reading-position').textContent = `${index + 1} / ${paths.length}`;
  $('reading-position').title = activeDocument;
  $('reading-position').setAttribute('aria-label', `Document ${index + 1} of ${paths.length}: ${activeDocument}`);
  $<HTMLButtonElement>('reading-back').disabled = !reader.canGoBack;
  $<HTMLButtonElement>('reading-previous').disabled = index <= 0;
  $<HTMLButtonElement>('reading-next').disabled = index < 0 || index >= paths.length - 1;
  $<HTMLInputElement>('continuous-reading').disabled = !!presentation() || paths.length < 2;
  $('continuous-help').textContent = presentation() ? 'Slide decks use slide navigation.' : 'Scroll between documents. This does not finish your review.';
  $<HTMLInputElement>('continuous-reading').title = $('continuous-help').textContent!;
}
async function showDocument(top = true) {
  const session = current, revision = session?.revision;
  if (!session || !revision || !activeDocument) return;
  const selected = activeDocument, key = `${session.storage.identity}:${revision.id}:${activeSlide ?? ''}`;
  await session.prepareReadingOrder(revision);
  if (current !== session || session.revision?.id !== revision.id || activeDocument !== selected) return;
  reader.configure(key, [...session.readingPaths(revision)], continuousReading && !presentation());
  status(`Loading ${selected}…`);
  try { await reader.navigate(selected, { top }); progress(); }
  catch (error) {
    if (current === session && current.revision?.id === revision.id) {
      const prior = reader.mounted.find(page => page.path === reader.activePath);
      if (prior) { activeDocument = prior.path; source = prior.value.text; rendered = prior.value.render; chrome(); stateView(); readerNavigation(); }
    }
    throw error;
  }
}
async function activate(session: ReviewSession) {
  const previous = current, previousReviewer = selectedReviewer(); if (previousReviewer) cacheReviewer(previousReviewer);
  $<HTMLSelectElement>('finding-snapshot-scope').value = 'all';
  $<HTMLSelectElement>('discussion-scope').value = 'all'; $<HTMLSelectElement>('workflow-queue').value = 'all';
  resetFindingFilters();
  try {
    const saved = JSON.parse(localStorage.getItem(viewPreferenceKey(session)) ?? 'null');
    if (saved && typeof saved.revisionId === 'string' && session.revisions.has(saved.revisionId)) await session.pin(saved.revisionId);
    if (saved?.snapshots === 'current') $<HTMLSelectElement>('finding-snapshot-scope').value = 'current';
  } catch { /* Private display preferences cannot invalidate review evidence. */ }
  generation++; lastChromeKey = ''; discussionLimit = 50; historyLimit = 100; current = session; renderKey = ''; lastStateKey = ''; activeSlide = undefined; activeDocument = session.revision?.rootDocument ?? '';
  if (!rpc || previous && previous !== session || !$<HTMLInputElement>('actor-id').value.trim()) {
    let saved: unknown; try { saved = JSON.parse(localStorage.getItem(`omr.identity:${session.manifest.reviewId}`) ?? 'null'); } catch { /* Optional preference. */ }
    if (saved) showReviewer(saved);
    else if (previous && previous !== session) { $<HTMLInputElement>('actor-id').value = ''; $<HTMLInputElement>('actor-name').value = ''; }
  }
  const reviewer = selectedReviewer(); if (reviewer) showReviewer(reviewer);
  templateOptions = {}; templateEditedFields = undefined;
  try { const saved = localStorage.getItem(templatePreferenceKey(session)); if (saved) { const value = parseJson<PdfTemplateOptions>(new TextEncoder().encode(saved), 98304); selectPdfTemplate(value); templateOptions = value; } } catch { /* An unavailable presentation preference must not block opening a review. */ }
  try { const savedMode = localStorage.getItem(exportModePreferenceKey(session)); exportMode = savedMode ? pdfExportMode(savedMode) : 'review'; } catch { exportMode = 'review'; }
  try {
    const record = await session.storage.journalGet(exportPreferenceKey(session));
    if (current !== session) return;
    if (record) {
      const saved = parseJson<{ kind: string; reviewId: string; options: PdfTemplateOptions; mode: PdfExportMode; editedFields?: PdfTemplateField['key'][] }>(new Uint8Array(record.bytes), 98304);
      if (saved.kind !== 'omr-pdf-export-preferences/1' || saved.reviewId !== session.manifest.reviewId || !saved.options || typeof saved.options !== 'object' || Array.isArray(saved.options)) throw new Error('Stale export preferences.');
      selectPdfTemplate(saved.options); const mode = pdfExportMode(saved.mode);
      templateOptions = saved.options; exportMode = mode;
      if (Array.isArray(saved.editedFields) && saved.editedFields.every(key => PDF_METADATA_FIELDS.includes(key)) && new Set(saved.editedFields).size === saved.editedFields.length) templateEditedFields = saved.editedFields;
    }
  } catch { /* Private preferences are optional, not review evidence. */ }
  if (!exportNotices.has(exportKey(session, 'review'))) {
    const selected = selectPdfTemplate(templateOptions);
    const latest = [...session.events].filter((event): event is Extract<Event, { type: 'export.created' }> => event.type === 'export.created' && pdfDocumentListFromRenderer(event.renderer.pdfEngine) === pdfDocumentList(templateOptions) && pdfOrientationFromRenderer(event.renderer.pdfEngine) === pdfOrientation(templateOptions.orientation) && (selected ? event.renderer.pdfEngine.includes(`omr-pdf-template-v1=${selected.digest}`) : !event.renderer.pdfEngine.includes('omr-pdf-template-v1='))).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id))[0];
    if (latest) exportNotices.set(exportKey(session, 'review'), { kind: 'success', message: `Latest archived PDF is in this review's exports folder (${latest.occurredAt}).`, result: { profile: 'review', operationId: latest.operationId, pdf: latest.pdf, pdfPath: latest.pdf.path, inventoryPath: latest.inventory.path, event: latest } });
  }
  await restoreCleanExport(session); await session.prepareReadingOrder();
  if (current !== session) return;
  renderExportNotice(); chrome(); await showDocument(false); schedulePoll();
}
async function restoreCleanExport(session: ReviewSession) {
  if (exportNotices.has(exportKey(session, 'clean')) || !session.revision) return;
  const actor = selectedReviewer(); if (!actor) return;
  const pointer = await session.storage.journalGet(exportUiKey(session, 'clean', session.revision.id, actor.id));
  if (!pointer?.acknowledged) return;
  try {
    const { operationId } = parseJson<{ operationId: string }>(new Uint8Array(pointer.bytes));
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(operationId)) return;
    const record = await session.storage.journalGet(`document-export-plan:${operationId}`); if (!record) return;
    const plan = documentExportPlan(new Uint8Array(record.bytes), { reviewId: session.manifest.reviewId, revisionId: session.revision.id, actorId: actor.id }, operationId);
    if ((plan.templateDigest ?? 'Default') !== pdfTemplateFingerprint(templateOptions) || (plan.includeDocumentList ?? false) !== pdfDocumentList(templateOptions, 'clean') || pdfOrientation(plan.orientation) !== pdfOrientation(templateOptions.orientation)) return;
    exportNotices.set(exportKey(session, 'clean'), { kind: 'success', message: 'Latest clean document PDF is in this review’s exports folder. It is not a review audit archive.', result: { profile: 'clean', operationId, pdf: plan.pdf, pdfPath: plan.pdf.path } });
  } catch { /* A stale private pointer is not review evidence; explicit export verifies/reports failures. */ }
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
  if (companionStopped) return;
  if (polling || publicationPreparing || !current) { schedulePoll(); return; }
  const session = current, before = new Set(session.events.map(event => event.id)); polling = true;
  try {
    await session.refresh();
    if (current === session && !companionStopped) {
      const arrived = session.events.filter(event => !before.has(event.id));
      chrome(); stateView();
      const completion = arrived.filter(event => event.type === 'review.completed' || event.type === 'review.reopened');
      if (completion.length) toast(completion.map(event => `${effectiveReviewers(session.manifest, session.events).find(r => r.id === event.actor.id)?.email ?? event.actor.displayName ?? event.actor.id} ${event.type === 'review.completed' ? 'finished' : 'reopened'} their review of ${event.revisionId}.`).join(' '));
      else if (arrived.length) toast(`${arrived.length} new review event${arrived.length === 1 ? '' : 's'} received from the shared folder.`);
    }
  } finally { polling = false; schedulePoll(); }
}
let composerDetailCleanup: (() => void) | undefined;
interface ComposeOptions { title: string; label: string; required?: boolean; choices?: string[]; choiceLabels?: ReadonlyMap<string, string>; choiceLabel?: string; choicePrompt?: string; submitLabel?: string; replacement?: boolean; initialText?: string; submit: (text: string, choice: string, replacement: string) => Promise<void> }
function compose(ctx: ActionContext, options: ComposeOptions) {
  const dialog = $<HTMLDialogElement>('composer'); if (dialog.open) throw new Error('Finish or cancel the current draft first.');
  composerDetailCleanup?.(); composerDetailCleanup = undefined;
  document.getElementById('published-fix-summary')?.remove();
  $('composer-title').textContent = options.title; $('composer-context').textContent = `${ctx.session.manifest.title} · ${snapshotLabel(ctx.revision.id, ctx.session)} · ${ctx.actor.id}. This action stays on this revision.`; $('composer-context').title = ctx.revision.id;
  $('body-label').textContent = options.label; $<HTMLTextAreaElement>('body').value = options.initialText ?? ''; $<HTMLTextAreaElement>('body').required = !!options.required;
  $('choice-label').hidden = !options.choices; $('choice-label').firstChild!.textContent = options.choiceLabel ?? 'Action';
  $('choice').innerHTML = (options.choicePrompt ? `<option value="" disabled selected>${esc(options.choicePrompt)}</option>` : '') + (options.choices ?? []).map(c => `<option value="${esc(c)}">${esc(options.choiceLabels?.get(c) ?? c)}</option>`).join('');
  $<HTMLSelectElement>('choice').required = !!options.choicePrompt;
  $('replacement-label').hidden = !options.replacement; $<HTMLTextAreaElement>('replacement').value = ''; $('composer-error').textContent = '';
  $<HTMLButtonElement>('save').textContent = options.submitLabel ?? 'Save event';
  dialog.showModal(); (options.choicePrompt ? $('choice') : $('body')).focus();
  dialog.querySelector('form')!.onsubmit = async event => {
    event.preventDefault(); const save = $<HTMLButtonElement>('save'); if (save.disabled) return;
    save.disabled = true; save.textContent = 'Saving…'; $('composer-error').textContent = '';
    try {
      await options.submit($<HTMLTextAreaElement>('body').value, $<HTMLSelectElement>('choice').value, $<HTMLTextAreaElement>('replacement').value);
      dialog.close(); toast(`Saved to ${ctx.session.manifest.title} · ${snapshotLabel(ctx.revision.id, ctx.session)}`); if (current === ctx.session) { chrome(); stateView(); }
    } catch (error) { $('composer-error').textContent = `${error instanceof Error ? error.message : String(error)} Your draft is still here.`; }
    finally { save.disabled = false; save.textContent = options.submitLabel ?? 'Save event'; }
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
  const ctx = context();
  if (feedbackLocked()) throw new Error('Enter your reviewer identity and reopen your review before adding feedback.');
  if (!rendered) throw new Error('Wait for the document to finish rendering.');
  const selection = document.getSelection(), hasTextSelection = !!selection && !selection.isCollapsed && $('document').contains(selection.anchorNode) && $('document').contains(selection.focusNode);
  const page = reader.pageFor(hasTextSelection ? selection!.anchorNode : semantic ?? null) ?? reader.mounted.find(p => p.path === activeDocument);
  if (hasTextSelection && page !== reader.pageFor(selection!.focusNode)) throw new Error('Select content within one document at a time.');
  if (!page) throw new Error('Wait for the selected document to finish rendering.');
  const anchor = externalAnchor ?? selectionAnchor(page.body, page.value.render, page.value.text, page.path, ctx.revision, hasTextSelection ? undefined : semantic); externalAnchor = undefined;
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
async function completion(type: 'review.completed' | 'review.reopened', ctx = context()) {
  await ctx.session.refresh();
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
  $('composer-context').textContent += ` Finishing records this revision and the verified review history. Your comments and review decision stay as recorded; use Reopen my review to add further feedback. Finishing does not approve the revision.`;
}
async function stance(type: 'review.approved' | 'review.rejected' | 'review.withdrawn') {
  const ctx = context(), state = fold(ctx.session.events, ctx.revision.id), stanceHeads = state.register(`stance:${ctx.revision.id}:${ctx.actor.id}`).heads, observed = stanceHeads.map(e => e.id);
  const active = stanceHeads.some(event => event.type === 'review.approved' || event.type === 'review.rejected');
  if (type === 'review.withdrawn' && !active) throw new Error('You have no active approval or rejection to withdraw.');
  if (type !== 'review.withdrawn' && active) throw new Error('Withdraw your current review decision before approving or rejecting again.');
  let confirmedFrontier: string | undefined, prepared: Event | undefined, preparedText: string | undefined;
  compose(ctx, { title: type === 'review.approved' ? 'Approve pinned revision' : type === 'review.rejected' ? 'Reject pinned revision' : 'Withdraw your review decision', label: 'Reason / note', required: type !== 'review.approved', submit: async text => {
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
  if (!current) throw new Error('Open a review first.');
  const origin = current.events.find(e => e.type === 'comment.created' && e.threadId === button.dataset.thread || e.type === 'suggestion.created' && e.suggestionId === button.dataset.suggestion)?.revisionId;
  const ctx = current.context(identity(), origin), state = findings().state(ctx.revision.id), thread = state.threads.find(t => t.root.threadId === button.dataset.thread), suggestion = state.suggestions.find(s => s.root.suggestionId === button.dataset.suggestion), action = button.dataset.action;
  if (action === 'locate' && (thread || suggestion)) {
    if (current.revision?.id !== ctx.revision.id) await showSnapshot(ctx.revision.id);
    const anchor = (thread ?? suggestion)!.root.anchor;
    activeDocument = anchor.document;
    const target = anchor.target, profile = presentation();
    const slides = profile?.slides.filter(s => s.document === activeDocument) ?? [];
    const start = offsetAt(decode(await ctx.session.content(ctx.revision.documents.find(d => d.path === activeDocument)!)), anchor.range.start);
    activeSlide = (target?.kind === 'image' ? slides.find(s => s.previewResourceId === target.resourceId) : slides.find(s => s.id === activeSlide && s.range.start <= start && s.range.end > start) ?? slides.find(s => s.range.start <= start && s.range.end > start))?.id ?? '';
    generation++; chrome(); await showDocument();
    const element = thread ? $('document').querySelector<HTMLElement>(`[data-thread-ids~="${thread.root.threadId}"]`) : $('document').querySelector<HTMLElement>(`[data-suggestion-jump="${suggestion!.root.suggestionId}"]`) ?? $('document').querySelector<HTMLElement>(`[data-suggestion-ids~="${suggestion!.root.suggestionId}"]`);
    if (element) { const details = element.closest('details'); if (details) details.open = true; window.scrollBy({ top: element.getBoundingClientRect().top - readingOffset() - 32, behavior: 'instant' }); }
    else toast('The finding anchor cannot be located in this rendering. Its exact source quote remains in the discussion.'); return;
  }
  if (thread) {
    const threadId = thread.root.threadId;
    if (action === 'edit-comment' || action === 'correct-comment') {
      const comment = state.comments.get(button.dataset.comment ?? '');
      if (!comment || comment.original.threadId !== threadId || comment.original.actor.id !== ctx.actor.id) throw new Error('Only the author can edit or correct this comment.');
      if (!thread.open || feedbackLocked(ctx.revision.id) || ['implemented', 'verified'].includes(threadWorkflowQueue(thread))) throw new Error('Reopen the discussion/finding and your review before editing or correcting a comment.');
      const editing = action === 'edit-comment';
      if (editing && !ctx.session.manifest.requiredCapabilities.includes(COMMENT_EDITS)) throw new Error('This review does not declare comment editing; add a correction reply instead.');
      eventComposer(ctx, { title: editing ? 'Edit my comment' : 'Add a correction', label: editing ? 'Updated wording' : 'Correction (original remains unchanged)', required: true, initialText: comment.body.text }, text => editing
        ? { type: 'comment.edited', threadId, commentId: comment.original.commentId, body: { format: 'markdown', text }, editPredecessors: comment.edits.heads.map(e => e.id) }
        : { type: 'comment.replied', threadId, commentId: newId('comment'), inReplyTo: comment.original.commentId, body: { format: 'markdown', text: `Correction to comment ${comment.original.commentId}:\n\n${text}` } });
      $('composer-context').textContent += editing ? ' Original text and all edits remain in the audit history. This does not move the anchor or change finding decisions.' : ' This older review keeps its immutable protocol capabilities; this saves a normal correction reply, not an edit.';
      return;
    }
    if ((action === 'reply' || action === 'decide') && !thread.open) throw new Error('This comment thread is closed. The review creator must reopen it first.');
    if ((action === 'decide' || action === 'resolve' || action === 'reopen' || action === 'reopen-finding' || action === 'reveal-source' || action === 'record-addressed' || action === 'link-source' || action === 'publish-fix') && !isReviewCreator(ctx.actor)) throw new Error(`Only the review initiator (${ctx.session.manifest.createdBy.id}) can decide, process, close or reopen findings.`);
    if (action === 'reply') eventComposer(ctx, { title: 'Reply to comment', label: 'Reply', required: true }, text => ({ type: 'comment.replied', threadId, commentId: newId('comment'), inReplyTo: thread.root.commentId, body: { format: 'markdown', text } }));
    if (action === 'decide') eventComposer(ctx, { title: 'Decide comment', label: 'Reason (required unless accepted)', choices: ['accepted', 'rejected', 'wont-fix', 'duplicate'] }, (text, decision) => ({ type: 'thread.decided', threadId, decision: decision as 'accepted', reason: text, decisionPredecessors: thread.decision.heads.map(e => e.id) }));
    if (action === 'resolve') {
      eventComposer(ctx, { title: 'Close discussion', label: 'Resolution note' }, note => ({ type: 'thread.resolved', threadId, note, statusPredecessors: thread.status.heads.map(e => e.id) }));
      if (threadWorkflowQueue(thread) === 'accepted-not-implemented') $('composer-context').textContent += ' This closes the conversation. The accepted change still needs to be published and recorded.';
    }
    if (action === 'reopen') eventComposer(ctx, { title: 'Reopen concern', label: 'Reason', required: true }, reason => ({ type: 'thread.reopened', threadId, reason, statusPredecessors: thread.status.heads.map(e => e.id) }));
    if (action === 'reopen-finding') compose(ctx, { title: 'Reopen finding', label: 'Why is more work needed?', required: true, submit: reopenFinding(ctx, threadId) });
    if (action === 'reveal-source') {
      if (!rpc || !canApply && !canAuthorFindings) throw new Error('Open this review in VS Code to edit its working source.');
      const result = await rpc('revealSource', [ctx.revision.id, threadId]) as { confidence?: string };
      toast(result.confidence === 'position' ? 'Opened the last known source position. Reconcile the missing quote explicitly.' : 'Opened and selected the finding in the linked source workspace.'); return;
    }
    if (action === 'link-source') {
      if (!rpc || !canAuthorFindings) throw new Error('Source linking is available only in VS Code.');
      const value = await rpc('linkFindingSource', [ctx.revision.id, ctx.actor]) as { canApply: boolean }; canApply = value.canApply; lastStateKey = ''; stateView(); return;
    }
    if (action === 'publish-fix') { await publishFindings(threadId, ctx.revision.id); return; }
    if (action === 'reopen-for-verification') { await completion('review.reopened', ctx); return; }
    if (action === 'record-addressed') {
      if (!ctx.session.manifest.requiredCapabilities.includes(THREAD_ADDRESSING)) throw new Error('This review does not declare thread-addressing-v1.');
      const revisions = publishedFixChoices(ctx.session.revisions.values(), ctx.session.events, ctx.revision.id, thread.root.anchor.document);
      if (!revisions.length) throw new Error('Publish a descendant review revision before recording implementation evidence.');
      eventComposer(ctx, { title: 'Record a published fix', label: 'Implementation note (optional)', choiceLabel: 'Published snapshot', choiceLabels: new Map(revisions.map(revision => [revision.id, revision.label])), ...(revisions.length > 1 ? { choicePrompt: 'Choose the snapshot containing this fix…' } : {}), submitLabel: 'Record fix', choices: revisions.map(revision => revision.id) }, (summary, toRevisionId) => {
        const target = ctx.session.revisions.get(toRevisionId), document = target?.documents.find(item => item.path === thread.root.anchor.document);
        if (!target || !document) throw new Error('The selected revision no longer contains this document.');
        return { type: 'thread.addressed', threadId, toRevisionId, document: thread.root.anchor.document, sourceDigestBefore: thread.root.anchor.documentDigest, sourceDigestAfter: document.digest, summary: implementationSummary(summary, toRevisionId, document.path), decisionIds: thread.decision.heads.map(event => event.id), addressingPredecessors: thread.addressing.heads.map(event => event.id) };
      });
      const detail = document.createElement('section'); $('body-label').before(detail);
      composerDetailCleanup = mountPublishedFixPicker(detail, $<HTMLSelectElement>('choice'), revisions, id => inspectFix(ctx, threadId, id));
      $('composer').scrollTop = 0; $('choice').focus({ preventScroll: true });
    }
    if (action === 'verify-addressing') {
      if (!thread.addressed) throw new Error('No current published implementation is available to verify.');
      eventComposer(ctx, { title: 'Verify published outcome', label: 'Verification note (required when challenged)', choices: ['verified', 'challenged'] }, (note, verdict) => ({ type: 'thread.verification.recorded', threadId, addressedEventId: thread.addressed!.id, verdict: verdict as 'verified' | 'challenged', ...(note.trim() ? { note } : {}), verificationPredecessors: thread.verification.heads.map(event => event.id) }));
    }
    if (action === 'open-addressed') {
      if (!thread.addressed) throw new Error('No addressed revision is recorded.');
      await inspectFix(ctx, threadId); return;
    }
  }
  if (suggestion && action === 'apply-suggestion') { if (!rpc || !canApply) throw new Error('Source application is an author-only capability.'); await rpc('applySuggestion', [ctx.revision.id, suggestion.root.suggestionId, newId('apply')]); await ctx.session.refresh(); if (current === ctx.session) stateView(); return; }
  if (suggestion) eventComposer(ctx, { title: action === 'accept-suggestion' ? 'Accept suggested edit' : 'Reject suggested edit', label: 'Reason / note', required: action !== 'accept-suggestion' }, text => action === 'accept-suggestion' ? { type: 'suggestion.accepted', suggestionId: suggestion.root.suggestionId, note: text, decisionPredecessors: suggestion.decision.heads.map(e => e.id) } : { type: 'suggestion.rejected', suggestionId: suggestion.root.suggestionId, reason: text, decisionPredecessors: suggestion.decision.heads.map(e => e.id) });
}
async function publishFindings(threadId?: string, originId?: string) {
  if (publicationPreparing || publicationDialog.open) return;
  if (!rpc || !canAuthorFindings) throw new Error('Publish updated documents in VS Code or the authoring CLI. Participant browsers cannot author source revisions.');
  const ctx = current!.context(identity(), originId), viewId = current!.revision?.id; if (!isReviewCreator(ctx.actor)) throw new Error('Only the initiator can publish and record fixes.');
  const unchanged = () => current === ctx.session && current.revision?.id === viewId && JSON.stringify(selectedReviewer()) === JSON.stringify(ctx.actor);
  publicationPreparing = true; publicationButton.disabled = true;
  try {
    const prepare = async (scope?: FindingScopeChoice) => {
      const request = { id: newId('prepare'), origin: ctx.revision.id, actor: ctx.actor }; preparationRequest = request;
      preparationDialog.begin(() => rpc!('cancelFindingPreparation', [request.origin, request.actor, request.id]));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (preparationDialog.cancelled) throw new ProtocolError('cancelled', 'Preparation cancelled before it started.');
      status('Checking saved documents and references privately. Nothing is published until confirmation…');
      return await rpc!('prepareFindingPublication', [ctx.revision.id, ctx.actor, request.id, ...(scope ? [scope] : [])]) as FindingPublicationPreview | FindingScopePlan;
    };
    let prepared = await prepare();
    if ('kind' in prepared && prepared.kind === 'finding-scope-v1') {
      if (preparationDialog.cancelled || !unchanged()) throw new ProtocolError('cancelled', 'Scope discovery cancelled or its review context changed.');
      preparationRequest = undefined; preparationDialog.close();
      const scope = await new FindingScopeDialog().show(prepared);
      if (!scope || !unchanged()) throw new ProtocolError('cancelled', 'Document scope was not confirmed. Nothing was published.');
      prepared = await prepare(scope);
    }
    if ('kind' in prepared) throw new Error('Source scope changed; cancel and inspect the documents again.');
    const preview = prepared;
    if (preparationDialog.cancelled) {
      if (!preview.pending) await rpc('discardFindingPublication', [ctx.revision.id, ctx.actor, preview.operationId]);
      throw new ProtocolError('cancelled', 'Preparation cancelled. No review evidence was published.');
    }
    if (!unchanged()) throw new Error('Review, revision or identity changed during preparation. Return to the original finding before continuing.');
    preparationRequest = undefined; preparationDialog.close();
    const result = await publicationDialog.show(preview, threadId, async selections => {
      if (!unchanged()) throw new Error('The original review context changed. Return to it before publishing or retrying.');
      const requestId = newId('publish'); publicationRequest = requestId;
      let saved: FindingPublicationResult;
      try { saved = await rpc('finishFindingPublication', [ctx.revision.id, ctx.actor, { operationId: preview.operationId, selections, requestId }]) as FindingPublicationResult; }
      finally { if (publicationRequest === requestId) publicationRequest = undefined; }
      // Keep the progress dialog until admitted state is reflected in the finding.
      // This also avoids a second network-folder scan immediately after closing.
      publicationDialog.progress('Refreshing the verified review and finding state…');
      await ctx.session.refresh();
      if (current === ctx.session) { lastChromeKey = ''; lastStateKey = ''; chrome(); stateView(); }
      return saved;
    }, async () => { await rpc('discardFindingPublication', [ctx.revision.id, ctx.actor, preview.operationId]); }, async () => {
      return await rpc('retireFindingPublication', [ctx.revision.id, ctx.actor, preview.operationId]) === true;
    });
    if (!result) await ctx.session.refresh();
    if (current === ctx.session) {
      lastChromeKey = ''; lastStateKey = ''; chrome(); stateView();
      if (result) {
        let notice = document.getElementById('finding-publication-result');
        if (!notice) { notice = document.createElement('p'); notice.id = 'finding-publication-result'; notice.setAttribute('role', 'status'); $('workbench').append(notice); }
        notice.textContent = `Published ${snapshotLabel(result.revisionId)}. ${result.records.filter(r => r.saved).length} of ${result.records.length} selected findings recorded as implemented. The displayed snapshot is unchanged. No verification step is required.`;
      }
      if (threadId) document.getElementById(`thread-${threadId}`)?.scrollIntoView({ block: 'nearest' });
    }
  } catch (error) {
    if (!(error instanceof ProtocolError && error.code === 'cancelled') && !(error instanceof DOMException && error.name === 'AbortError')) preparationDialog.fail(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    preparationRequest = undefined; if (!preparationDialog.failed) preparationDialog.close();
    publicationPreparing = false; publicationButton.disabled = false;
    lastStateKey = ''; stateView();
  }
}
async function inspectFix(ctx: ActionContext, threadId: string, previewRevisionId?: string) {
  const thread = fold(ctx.session.events, ctx.revision.id).threads.find(t => t.root.threadId === threadId), addressed = thread?.addressed;
  if (!thread || !previewRevisionId && !addressed) throw new Error('No implementation is recorded.');
  if (previewRevisionId && !eligibleFixRevisions(ctx.session.revisions.values(), ctx.revision.id, thread.root.anchor.document).some(revision => revision.id === previewRevisionId)) throw new Error('Choose a verified descendant snapshot containing the original document.');
  const target = ctx.session.revisions.get(previewRevisionId ?? addressed!.toRevisionId); if (!target) throw new Error('The recorded revision is not locally verified yet. Refresh first.');
  const returnFocus = document.activeElement as HTMLElement | null;
  const selectedDocument = previewRevisionId ? thread.root.anchor.document : addressed!.document;
  const dialog = document.createElement('dialog'); dialog.id = 'fix-inspection'; dialog.setAttribute('aria-labelledby', 'fix-inspection-title');
  const paths = [...new Set([...target.documents.map(d => d.path), ...ctx.revision.documents.map(d => d.path)])];
  dialog.innerHTML = `<h2 id="fix-inspection-title">${previewRevisionId ? 'Preview published snapshot' : 'Inspect published fix'}</h2><p>${previewRevisionId ? 'Read-only comparison. This does not record implementation or change the displayed snapshot. Return to the picker and explicitly record the fix if appropriate.' : 'The original finding and recorded implementation remain on their exact frozen snapshots. Inspection does not change review state.'}</p><blockquote>${esc(thread.root.anchor.quote.exact)}</blockquote>${!previewRevisionId ? `<p>${esc(addressed!.summary)}</p>` : ''}<div class="inspection-controls"><label>Inspect document<select id="fix-document">${paths.map(path => `<option value="${esc(path)}" ${path === selectedDocument ? 'selected' : ''}>${esc(path)}${ctx.revision.documents.find(p => p.path === path)?.digest !== target.documents.find(p => p.path === path)?.digest ? ' · Changed' : ''}</option>`).join('')}</select></label><label>View<select id="fix-view"><option value="rendered">Rendered</option><option value="source">Source</option></select></label></div><div class="publication-diff"><section><h3>Original · ${esc(snapshotLabel(ctx.revision.id, ctx.session))}</h3><article class="markdown-body" data-original></article></section><section><h3>${previewRevisionId ? 'Selected snapshot' : 'Implementation'} · ${esc(snapshotLabel(target.id, ctx.session))}</h3><article class="markdown-body" data-implementation></article></section></div><p id="fix-loading" role="status"></p><p id="fix-error" role="alert"></p><footer><button data-close class="primary">${previewRevisionId ? 'Back to snapshot selection' : 'Back to finding'}</button></footer>`;
  document.body.append(dialog); const selector = dialog.querySelector<HTMLSelectElement>('#fix-document')!, mode = dialog.querySelector<HTMLSelectElement>('#fix-view')!;
  let renderGeneration = 0, controller: AbortController | undefined;
  const load = async () => {
    controller?.abort(); const control = new AbortController(); controller = control;
    const gen = ++renderGeneration, chosen = selector.value, view = mode.value;
    dialog.querySelector('#fix-error')!.textContent = '';
    dialog.querySelector('#fix-loading')!.textContent = view === 'source' ? 'Loading verified source…' : 'Rendering verified documents, diagrams and frozen images…';
    dialog.dataset.ready = 'false'; dialog.setAttribute('aria-busy', 'true');
    for (const pane of dialog.querySelectorAll('[data-original], [data-implementation]')) pane.textContent = 'Loading verified document and frozen resources…';
    try {
      await Promise.all(([[ctx.revision, '[data-original]'], [target, '[data-implementation]']] as const).map(async ([revision, container]) => {
        const doc = revision.documents.find(d => d.path === chosen), body = document.createElement('article');
        const text = doc ? decode(await ctx.session.content(doc)) : ''; control.signal.throwIfAborted();
        const profile = ctx.session.profiles.get(revision.id)?.get(SLIDEV_ID) as SlidevProfile | undefined;
        if (!doc) body.textContent = 'Not in this snapshot.';
        else if (view === 'source') { const pre = document.createElement('pre'); pre.textContent = text; body.append(pre); }
        else {
          body.innerHTML = profile
            ? `<p>Frozen presentation evidence; this comparison does not run the presentation project.</p>${profile.slides.filter(s => s.document === chosen).map(s => `<figure><img data-resource="${esc(s.previewResourceId)}" alt="${esc(s.title)}"><figcaption>Slide ${s.number}: ${esc(s.title)}</figcaption></figure>`).join('')}${sourceView(text).html}`
            : renderDocument(text, chosen, revision).html;
          await populateAssets(body, revision, item => ctx.session.content(item), { signal: control.signal });
        }
        control.signal.throwIfAborted();
        if (gen === renderGeneration && dialog.isConnected) dialog.querySelector(container)!.replaceChildren(...body.childNodes);
      }));
      if (gen === renderGeneration && dialog.isConnected) { dialog.dataset.ready = 'true'; dialog.setAttribute('aria-busy', 'false'); dialog.querySelector('#fix-loading')!.textContent = ''; }
    } catch (error) {
      if (gen === renderGeneration && !control.signal.aborted && dialog.isConnected) { dialog.setAttribute('aria-busy', 'false'); dialog.querySelector('#fix-loading')!.textContent = ''; dialog.querySelector('#fix-error')!.textContent = error instanceof Error ? error.message : String(error); }
    }
  };
  const close = () => { renderGeneration++; controller?.abort(); dialog.close(); dialog.remove(); (returnFocus?.isConnected ? returnFocus : document.querySelector<HTMLButtonElement>(`[data-thread="${threadId}"][data-action="open-addressed"]`))?.focus({ preventScroll: true }); };
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); }); dialog.querySelector('[data-close]')!.addEventListener('click', close);
  selector.addEventListener('change', () => { void load(); }); mode.addEventListener('change', () => { void load(); });
  dialog.addEventListener('click', event => {
    const link = (event.target as Element).closest<HTMLElement>('[data-document-link], [data-attachment], .blocked-reference'); if (!link) return;
    event.preventDefault(); event.stopPropagation();
    const raw = link.dataset.documentLink; if (!raw) return;
    try {
      const [relative, fragment] = raw.split('#'), doc = relative ? decodeURIComponent(new URL(relative, `https://review.invalid/${selector.value}`).pathname.slice(1)) : selector.value;
      if (!paths.includes(doc)) throw new Error('Linked document is not part of these frozen snapshots.');
      selector.value = doc; void load().then(() => {
        if (fragment && dialog.isConnected) { const pane = dialog.querySelector(link.closest('[data-original]') ? '[data-original]' : '[data-implementation]')!;
          const id = decodeURIComponent(fragment), heading = [...pane.querySelectorAll<HTMLElement>('[data-source-bookmark], h1,h2,h3,h4,h5,h6')].find(h => h.dataset.sourceBookmark === id || h.textContent?.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s/g, '-') === id);
          heading?.scrollIntoView({ block: 'nearest' }); }
      });
    } catch (error) { dialog.querySelector('#fix-error')!.textContent = error instanceof Error ? error.message : String(error); }
  });
  dialog.showModal(); await load();
}
publicationButton.addEventListener('click', () => safely(() => publishFindings()));
advancedPublicationButton.addEventListener('click', () => safely(async () => {
  const ctx = context(); if (!rpc || !canAuthorFindings || !isReviewCreator(ctx.actor)) throw new Error('Advanced authoring is available only to the initiator in VS Code.');
  await rpc('configureFindingRevision', [ctx.revision.id, ctx.actor]);
}));
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
  const metadata = await rpc('info', []) as { identity: string; writable: boolean; companion?: boolean; binaryEncoding?: 'base64'; canApply?: boolean; canAuthorFindings?: boolean; canRememberReviewer?: boolean; canNotifyReady?: boolean; canOpenExports?: boolean; reviewer?: ActorRef };
  canApply = !!metadata.canApply;
  canAuthorFindings = metadata.canAuthorFindings === true && !metadata.companion;
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
    journalGet: async o => { const value = await rpc('journalGet', [o]) as (Omit<JournalEntry, 'bytes'> & { bytes: number[] | string }) | null; return value ? { ...value, bytes: compact ? fromBase64(value.bytes as string) : new Uint8Array(value.bytes as number[]) } : undefined; },
    journalPut: async (o, e) => { await rpc('journalPut', [o, { ...e, bytes: compact ? toBase64(new Uint8Array(e.bytes)) : Array.from(e.bytes) }]); }
  };
  $('companion-status').hidden = !metadata.companion;
  await attach(storage);
  if (metadata.canNotifyReady) await rpc('toolboxReady', []);
}
async function configureExport() {
  if (exportBusy || exportConfiguring || exportDialog.open) return;
  exportConfiguring = true;
  const trigger = $<HTMLButtonElement>('export'), label = trigger.textContent; trigger.disabled = true; trigger.textContent = 'Loading snapshots…';
  try {
    if (!current) throw new Error('Open a review first.');
    const ctx = { session: current, actor: identity() }, viewId = current.pinnedRevisionId;
    const unchanged = () => current === ctx.session && current.pinnedRevisionId === viewId && JSON.stringify(selectedReviewer()) === JSON.stringify(ctx.actor);
    status('Loading verified snapshots for PDF export…');
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await ctx.session.refresh();
    if (!unchanged()) throw new Error('Review, snapshot or reviewer changed while loading PDF options. Open Export PDF again.');
    trigger.textContent = label;
    const result = await exportDialog.show({ mode: exportMode, options: templateOptions, editedFields: templateEditedFields, reviewTitle: ctx.session.manifest.title, revisions: pdfRevisionChoices(ctx.session.revisions.values(), ctx.session.events) });
    if (!result) return;
    if (!unchanged()) throw new Error('Review, revision or reviewer changed while PDF options were open. Open Export PDF again to confirm the new selection.');
    templateOptions = result.options; templateEditedFields = result.editedFields; exportMode = result.mode; $<HTMLButtonElement>('export').disabled = true;
    const noticeKey = exportKey(ctx.session);
    showExportNotice(ctx.session, { kind: 'busy', message: 'Preparing the confirmed PDF options…' }, noticeKey);
    try { localStorage.setItem(templatePreferenceKey(ctx.session), JSON.stringify(templateOptions)); localStorage.setItem(exportModePreferenceKey(ctx.session), exportMode); } catch { /* Current export still works without persistent browser storage. */ }
    try {
      await ctx.session.storage.journalPut(exportPreferenceKey(ctx.session), { path: 'exports', bytes: jsonBytes({ kind: 'omr-pdf-export-preferences/1', reviewId: ctx.session.manifest.reviewId, options: templateOptions, mode: exportMode, editedFields: templateEditedFields }), acknowledged: true });
      if (!unchanged()) throw new Error('Review selection changed before export started. Open Export PDF again.');
      const selected = ctx.session.context(ctx.actor, result.revisionId);
      await exportFromToolbox(selected);
    } catch (error) {
      if (exportNotices.get(noticeKey)?.kind === 'busy') showExportNotice(ctx.session, { kind: 'error', message: error instanceof Error ? error.message : String(error) }, noticeKey);
      throw error;
    }
  } finally { trigger.textContent = label; exportConfiguring = false; lastChromeKey = ''; chrome(); }
}
async function exportFromToolbox(ctx: ActionContext) {
  if (exportBusy) return;
  const mode = exportMode, options = templateOptions, key = exportUiKey(ctx.session, mode, ctx.revision.id, ctx.actor.id);
  const noticeKey = exportKey(ctx.session), notify = (notice: ExportNotice) => showExportNotice(ctx.session, notice, noticeKey);
  let pointer: JournalEntry | undefined;
  exportBusy = true; exportController = new AbortController(); $<HTMLButtonElement>('export').disabled = true; $<HTMLButtonElement>('cancel-operation').hidden = false;
  notify({ kind: 'busy', message: mode === 'clean' ? 'Preparing a clean document PDF without review information.' : 'Preparing the review PDF with native comments. It will be saved in this review folder.' });
  try {
    // The pointer is private recovery metadata, not another source of review state.
    // A reload/retry uses the same captured plan after an uncertain publication.
    const prior = await ctx.session.storage.journalGet(key);
    const operationId = prior && !prior.acknowledged ? parseJson<{ operationId: string }>(new Uint8Array(prior.bytes)).operationId : newId('export');
    pointer = { path: 'exports', bytes: Array.from(jsonBytes({ operationId })), acknowledged: false };
    await ctx.session.storage.journalPut(key, pointer);
    notify({ kind: 'busy', message: mode === 'clean' ? 'Verifying and rendering the frozen documents only…' : 'Verifying every document and adding native PDF comments and replies…' });
    const result = await exportAudit(ctx, undefined, operationId, { signal: exportController.signal, progress: message => notify({ kind: 'busy', message }) }, mode, options);
    await ctx.session.storage.journalPut(key, { ...pointer, acknowledged: true });
    notify({ kind: 'success', message: `${snapshotLabel(ctx.revision.id, ctx.session)}: ${mode === 'clean' ? 'Clean document PDF saved without review comments or review metadata. It is not a review audit archive.' : 'Review PDF and audit inventory saved. Open the comments panel in a compatible PDF reader to see findings and replies.'}`, result });
    toast(`Saved ${result.pdfPath}${result.inventoryPath ? ' and its audit inventory' : ''}.`);
    if (current === ctx.session) stateView();
  } catch (error) {
    if (error instanceof ProtocolError && error.code === 'cancelled') { if (pointer) await ctx.session.storage.journalPut(key, { ...pointer, acknowledged: true }); notify({ kind: 'cancelled', message: 'Export cancelled before publication. Review evidence is unchanged.' }); toast('Export cancelled before publication. Review evidence is unchanged.'); return; }
    const message = `Export did not finish. Click Export again to resume the same export safely. ${String(error)}`;
    notify({ kind: 'error', message }); throw new Error(message);
  }
  finally { exportBusy = false; exportController = undefined; $<HTMLButtonElement>('cancel-operation').hidden = true; lastChromeKey = ''; chrome(); }
}
$('dismiss-export-result').addEventListener('click', () => { if (!current || exportNotice()?.kind === 'busy') return; exportNotices.delete(exportKey(current)); renderExportNotice(); progress(); });
$('stop-companion').addEventListener('click', () => safely(async () => {
  if (!rpc || exportBusy || !confirm('Stop the local companion? Wait for pending saves to finish first. Saved review files will remain in the shared folder.')) return;
  await rpc('stop', []); companionStopped = true; if (nextPoll) clearTimeout(nextPoll);
  reader.cancel();
  $<HTMLButtonElement>('stop-companion').disabled = true;
  $('workspace').hidden = true; $('toolbar').hidden = true;
  status(companionStoppedNotice);
}));
for (const [id, method] of [['open-export', 'openExport'], ['reveal-export', 'revealExport']] as const) $(id).addEventListener('click', () => safely(async () => { const result = exportNotice()?.result; if (rpc && canOpenExports && result) await rpc(method, [result.event?.id ?? DOCUMENT_EXPORT_ID_PREFIX + result.operationId]); }));
$('download-export').addEventListener('click', () => safely(async () => {
  const session = current, result = exportNotice()?.result;
  if (!session || !result) return;
  const pdf = result.pdf, bytes = await session.storage.read(pdf.path, Math.max(1, pdf.byteLength));
  if (bytes.length !== pdf.byteLength || digest(bytes) !== pdf.digest) throw new Error('The archived PDF changed or is incomplete. No download was started.');
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const filename = result.profile === 'clean' ? session.revision!.rootDocument.split('/').at(-1)!.replace(/\.md$/i, '') : session.manifest.title;
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${filename.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'Document'}-${result.profile === 'clean' ? 'document' : 'archive'}.pdf`;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}));
for (const [id, fn] of Object.entries({ connect: () => choose(), another: () => choose(), 'read-only': () => choose(true), refresh, comment: async () => comment(), suggest: async () => comment(true), approve: () => stance('review.approved'), reject: () => stance('review.rejected'), withdraw: () => stance('review.withdrawn'), 'finish-review': () => completion('review.completed'), 'reopen-review': () => completion('review.reopened'), 'add-reviewers': addReviewers, export: configureExport })) $(id).addEventListener('click', () => safely(fn));
$('selection-comment').addEventListener('click', () => safely(async () => comment()));
$('selection-suggest').addEventListener('click', () => safely(async () => comment(true)));
$('cancel').addEventListener('click', () => { $<HTMLDialogElement>('composer').close(); updateSelectionActions(); });
$('composer').addEventListener('close', () => { if ($<HTMLDialogElement>('composer').open) return; composerDetailCleanup?.(); composerDetailCleanup = undefined; document.getElementById('published-fix-summary')?.remove(); });
$('cancel-operation').addEventListener('click', () => exportController?.abort());
for (const id of ['discussion-status', 'decision-status']) $(id).addEventListener('change', () => { discussionLimit = 50; stateView(); });
$('workflow-queue').addEventListener('change', () => { discussionLimit = 50; lastStateKey = ''; stateView(); });
$('discussion-scope').addEventListener('change', () => { discussionLimit = 50; lastStateKey = ''; stateView(); });
$('discussion-search').addEventListener('input', () => { discussionLimit = 50; stateView(); });
$('more-discussions').addEventListener('click', () => { discussionLimit += 50; stateView(); });
$('more-history').addEventListener('click', () => { historyLimit += 100; stateView(); });
$('documents').addEventListener('click', e => { const button = (e.target as Element).closest<HTMLElement>('[data-document],[data-slide]'); if (button) safely(async () => { if (button.dataset.slide) return showSlide(button.dataset.slide); activeSlide = ''; generation++; activeDocument = button.dataset.document!; chrome(); await showDocument(); }); });
$('set-reviewer').addEventListener('click', () => { $('actor-id').focus(); $('actor-id').scrollIntoView({ block: 'center' }); });
$('reading-back').addEventListener('click', () => safely(() => reader.back()));
for (const [id, delta] of [['reading-previous', -1], ['reading-next', 1]] as const) $(id).addEventListener('click', () => safely(async () => {
  if (!current?.revision) return;
  const paths = current.readingPaths(), target = paths[paths.indexOf(activeDocument) + delta];
  if (target) { activeDocument = target; activeSlide = ''; await showDocument(); }
}));
$('continuous-reading').addEventListener('change', () => safely(async () => {
  const position = reader.position(); continuousReading = $<HTMLInputElement>('continuous-reading').checked;
  try { localStorage.setItem('omr.continuous-reading', String(continuousReading)); } catch { /* Private preference only. */ }
  await showDocument(); if (position) await reader.navigate(position.path, { remember: false, offset: position.offset });
}));
$('reviews').addEventListener('change', () => safely(() => activate(sessions.get($<HTMLSelectElement>('reviews').value)!)));
$('revisions').addEventListener('change', () => safely(() => showSnapshot($<HTMLSelectElement>('revisions').value)));
$('finding-snapshot-scope').addEventListener('change', () => { rememberView(); discussionLimit = 50; lastStateKey = ''; stateView(); });
for (const id of ['threads', 'suggestions']) $(id).addEventListener('click', e => { const button = (e.target as Element).closest<HTMLButtonElement>('button[data-action]'); if (button) safely(() => action(button)); });
$('document').addEventListener('click', e => {
  const readerButton = (e.target as Element).closest<HTMLElement>('[data-reader-document]');
  if (readerButton?.dataset.readerDocument) { safely(async () => { activeDocument = readerButton.dataset.readerDocument!; activeSlide = ''; await showDocument(); }); return; }
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
  // VS Code's webview also handles href="#" at window level, even after
  // preventDefault(), and would reset our completed section jump to the top.
  if (link) { e.preventDefault(); e.stopPropagation(); const raw = link.dataset.documentLink!, parts = raw.split('#'), origin = reader.pageFor(link)?.path ?? activeDocument; safely(async () => {
    const doc = parts[0] ? decodeURIComponent(new URL(parts[0], `https://review.invalid/${origin}`).pathname.slice(1)) : origin;
    if (!current?.revision?.documents.some(d => d.path === doc)) throw new Error('Linked document is not part of this frozen revision.');
    activeDocument = doc; activeSlide = ''; await showDocument();
    if (parts[1]) { const fragment = decodeURIComponent(parts[1]), body = reader.mounted.find(page => page.path === doc)!.body;
      const exact = [...body.querySelectorAll<HTMLElement>('[data-source-bookmark]')].find(element => element.dataset.sourceBookmark === fragment);
      const heading = exact ?? [...body.querySelectorAll('h1,h2,h3,h4,h5,h6')].find(h => h.textContent?.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s/g, '-') === fragment);
      if (heading) { for (const details of [heading.closest('details')]) if (details) details.open = true; window.scrollBy({ top: heading.getBoundingClientRect().top - readingOffset(), behavior: 'instant' }); }
      else toast('This heading is not present in the frozen document. Showing the document beginning.');
    }
  }); return; }
  const suggestionJump = target.closest<HTMLElement>('[data-suggestion-jump]');
  if (suggestionJump) { const id = suggestionJump.dataset.suggestionJump!; resetFindingFilters(); discussionLimit = Math.max(discussionLimit, fold(current!.events, current!.revision!.id).suggestions.findIndex(item => item.root.suggestionId === id) + 1); stateView(); document.querySelectorAll('.focused').forEach(element => element.classList.remove('focused')); const card = document.getElementById(`suggestion-${id}`); card?.scrollIntoView({ behavior: 'smooth', block: 'center' }); card?.classList.add('focused'); return; }
  const marked = target.closest<HTMLElement>('[data-thread-ids]');
  const suggested = target.closest<HTMLElement>('[data-suggestion-ids]');
  if (marked) { const id = marked.dataset.threadIds!.split(' ')[0]; resetFindingFilters(); discussionLimit = Math.max(discussionLimit, fold(current!.events, current!.revision!.id).threads.findIndex(t => t.root.threadId === id) + 1); stateView(); document.querySelectorAll('.focused').forEach(element => element.classList.remove('focused')); const thread = document.getElementById(`thread-${id}`); thread?.scrollIntoView({ behavior: 'smooth', block: 'center' }); thread?.classList.add('focused'); }
  else if (suggested) { const id = suggested.dataset.suggestionIds!.split(' ')[0]; resetFindingFilters(); discussionLimit = Math.max(discussionLimit, fold(current!.events, current!.revision!.id).suggestions.findIndex(item => item.root.suggestionId === id) + 1); stateView(); document.querySelectorAll('.focused').forEach(element => element.classList.remove('focused')); const card = document.getElementById(`suggestion-${id}`); card?.scrollIntoView({ behavior: 'smooth', block: 'center' }); card?.classList.add('focused'); }
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
$('forget').addEventListener('click', () => safely(async () => { reader.cancel(); exportController?.abort(); if (current) { for (const [key, s] of sessions) if (s === current) sessions.delete(key); } current = undefined; generation++; renderKey = ''; $('workspace').hidden = true; $('toolbar').hidden = true; $('welcome').hidden = false; remembered = undefined; $('reconnect').hidden = true; await localValue(connectionKey, null); status('Connection forgotten. Shared review files are unchanged.'); }));
for (const id of ['actor-id', 'actor-name']) {
  $(id).addEventListener('input', () => { identityGeneration++; lastStateKey = ''; stateView(); });
  $(id).addEventListener('change', () => { const actor = selectedReviewer(); if (actor) rememberReviewer(actor); });
}
document.addEventListener('selectionchange', updateSelectionActions);
new ResizeObserver(() => document.documentElement.style.setProperty('--review-toolbar-height', `${$('toolbar').offsetHeight + 12}px`)).observe($('toolbar'));
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
window.omrAutomation = { connect: connectHost, export: async (actor, revision, operation, mode = 'review', template = {}) => { if (!current) await connectHost(); await current!.pin(revision); return exportAudit(current!.context(actor), undefined, operation, undefined, pdfExportMode(mode), template); }, session: () => current };
document.documentElement.dataset.clientReady = 'true';
window.addEventListener('message', event => {
  if (rpc && publicationRequest && event.data?.command === 'finding-preparation-progress' && event.data.requestId === publicationRequest && typeof event.data.message === 'string') { publicationDialog.progress(event.data.message.slice(0, 4096)); return; }
  if (rpc && preparationRequest && event.data?.command === 'finding-preparation-progress' && event.data.requestId === preparationRequest.id && typeof event.data.message === 'string' && !preparationDialog.cancelled) { preparationDialog.progress(event.data.message.slice(0, 4096)); return; }
  if (canAuthorFindings && event.data?.command === 'toolbox-action' && event.data.buttonId === 'publication') { safely(() => publishFindings()); return; }
  if (rpc && event.data?.command === 'reviewer-identity' && reviewerIdentity(event.data.reviewer)) { identityGeneration++; showReviewer(event.data.reviewer); lastRememberedReviewer = JSON.stringify(reviewerIdentity(event.data.reviewer)); return; }
  if (rpc && event.data?.command === 'source-binding') { canApply = event.data.canApply === true; lastStateKey = ''; stateView(); return; }
  if (rpc && event.data?.command === 'toolbox-action' && ['workbench', 'threads', 'suggestions', 'history', 'status'].includes(event.data.buttonId)) { $(event.data.buttonId).scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
  if (rpc && event.data?.command === 'toolbox-action' && ['comment', 'suggest', 'approve', 'reject', 'withdraw', 'export', 'refresh'].includes(event.data.buttonId)) {
    const selection = event.data.selection;
    if (selection && typeof selection.source === 'string' && typeof selection.document === 'string' && Number.isInteger(selection.start) && Number.isInteger(selection.end) && selection.start >= 0 && selection.end > selection.start && selection.end <= selection.source.length) externalAnchor = { document: selection.document, documentDigest: digest(selection.source), range: { start: pointAt(selection.source, selection.start), end: pointAt(selection.source, selection.end) }, quote: { exact: selection.source.slice(selection.start, selection.end) }, target: { kind: 'text' } };
    $(event.data.buttonId).click();
  }
});
