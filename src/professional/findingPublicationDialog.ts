import type { FindingPublicationPreview, FindingPublicationResult, FindingSelection } from './findingPublication';
import { escapeHtml as esc } from './rendering';

/** Shared presentation; only an explicitly capable native host may supply authoring. */
export class FindingPublicationDialog {
  private dialog?: HTMLDialogElement;
  private timer?: ReturnType<typeof setInterval>;
  progress(message: string): void {
    const phase = this.dialog?.querySelector<HTMLElement>('[data-publication-phase]');
    if (phase && this.dialog?.getAttribute('aria-busy') === 'true') phase.textContent = message;
  }
  get open() { return !!this.dialog?.open; }
  async show(preview: FindingPublicationPreview, initialThread: string | undefined,
    submit: (selections: FindingSelection[]) => Promise<FindingPublicationResult>,
    discard: () => Promise<void>, retire?: () => Promise<boolean>): Promise<FindingPublicationResult | undefined> {
    if (this.open) throw new Error('Finish or cancel the current publication first.');
    const returnFocus = document.activeElement as HTMLElement | null;
    const dialog = document.createElement('dialog'); this.dialog = dialog; dialog.id = 'finding-publication-dialog';
    dialog.setAttribute('aria-labelledby', 'finding-publication-title');
    // A retry must replay the exact persisted intent, including omitted notes and order.
    let confirmed = preview.preparedSelections?.map(selection => ({ ...selection }));
    const saved = new Set(preview.pending?.records.filter(record => record.saved).map(record => record.threadId));
    const complete = (finding: FindingPublicationPreview['findings'][number]) => {
      if (saved.has(finding.threadId)) return true;
      if (confirmed?.some(selection => selection.threadId === finding.threadId)) return false;
      return finding.workflow === 'implemented' || finding.workflow === 'verified' || finding.workflow === undefined && finding.addressed;
    };
    const active = preview.findings.filter(finding => !complete(finding));
    const activeById = new Map(active.map(finding => [finding.threadId, finding]));
    const groups = new Map<string, typeof active>();
    for (const finding of active) { const group = groups.get(finding.document) ?? []; group.push(finding); groups.set(finding.document, group); }
    const firstChanged = preview.documents.findIndex(document => document.changed);
    dialog.innerHTML = `<form><h2 id="finding-publication-title">Publish updated documents</h2><p>Inspect the complete document changes, then select the findings this revision addresses. Changes are not limited to the original highlighted text.</p>
      <details data-publication-context><summary>Publication details</summary><dl><dt>Review</dt><dd>${esc(preview.reviewTitle)}</dd><dt>Original finding snapshot</dt><dd>${esc(preview.originRevisionId)}</dd><dt>Parent snapshot(s)</dt><dd>${preview.parents.map(esc).join(', ')}</dd><dt>Source → review folder</dt><dd>${esc(preview.sourceRoot)} → ${esc(preview.destination)}</dd></dl></details>
      <p class="closed-notice">Comments, decisions and past completion records are preserved. The new snapshot has its own participant progress. Existing HTML and companions are not upgraded by this operation.</p>
      <section aria-label="Changed documents"><h3>Document changes</h3><p>${preview.documents.filter(d => d.change === 'added').length} added · ${preview.documents.filter(d => d.change === 'removed').length} removed · ${preview.documents.filter(d => d.changed && d.change !== 'added' && d.change !== 'removed').length} modified. ${preview.scopeConfirmed ? 'Document scope explicitly confirmed.' : 'Existing scope retained.'}</p>${preview.removedFindingCount ? `<p class="closed-notice">${preview.removedFindingCount} finding(s) belong to documents removed from this snapshot. Their original discussions are preserved; this publication cannot record them as implemented.</p>` : ''}${preview.documents.map((d, index) => `<details data-diff-index="${index}" ${index === firstChanged ? 'open' : ''}><summary>${esc(d.path)} · ${d.change === 'added' ? 'Added' : d.change === 'removed' ? 'Removed' : d.changed ? 'Modified' : 'Unchanged'}</summary><p><small>${esc(d.beforeDigest ?? 'Not in parent snapshot')} → ${esc(d.afterDigest ?? 'Not in new snapshot')}</small></p><div data-diff-content>${d.changed ? '' : '<p>Unchanged: the exact document digest matches the parent snapshot. Inspect the complete source in the native editor if needed.</p>'}</div></details>`).join('')}</section>
      <details data-resource-list><summary>Frozen images and attachments (${preview.resources.length})</summary><div data-resource-content></div><p>Resources are captured bytes, not live remote content.</p></details>
      <fieldset><legend>Findings addressed by this publication</legend><p>Select only the unfinished findings this revision addresses. You may change multiple documents; publishing without selecting a finding is also allowed.</p>
      <label>Search unfinished findings<input type="search" data-finding-search placeholder="Document, quoted text, comment or author"></label><p data-selection-count role="status" aria-live="polite"></p>
      <div data-active-findings>${[...groups].map(([document, findings]) => `<details data-finding-group ${findings.some(f => confirmed?.some(s => s.threadId === f.threadId) || f.threadId === initialThread) ? 'open' : ''}><summary>${esc(document)} · <span data-group-count>${findings.length}</span> unfinished</summary>${findings.map(f => {
        const selected = confirmed ? confirmed.some(s => s.threadId === f.threadId) : f.threadId === initialThread;
        const note = confirmed?.find(s => s.threadId === f.threadId)?.summary ?? '';
        return `<section class="publication-finding" data-finding="${esc(f.threadId)}"><label><input type="checkbox" data-selected ${selected ? 'checked' : ''} ${confirmed ? 'disabled' : ''}><span><span class="publication-quote">${esc(f.quote)}</span><small>${esc(f.author ?? '')}${f.author ? ' · ' : ''}Discussion ${f.open === undefined ? 'status retained' : f.open ? 'open' : 'closed'}${f.workflow === 'challenged' ? ' · Reopened finding' : ''}</small></span></label>${f.body ? `<p class="publication-excerpt">${esc(f.body)}</p>` : ''}<div data-note ${selected ? '' : 'hidden'}>${!preview.documents.find(d => d.path === f.document)?.changed ? '<p>The anchored document is unchanged. Check how changes elsewhere address this finding.</p>' : ''}<label>Implementation note (optional)<input data-summary value="${esc(note)}" maxlength="32768" ${confirmed ? 'readonly' : ''}></label><small>If left blank, the record identifies the published snapshot and document without adding an explanation.</small></div></section>`;
      }).join('')}</details>`).join('')}</div><p data-no-findings hidden>No unfinished findings match. Selected findings remain visible.</p>
      <details data-completed-findings><summary>Already implemented (<span data-completed-count></span>)</summary><p>These findings are not selected again. Use Reopen finding if a further change is needed. Discussion status is independent.</p><div data-completed-content></div><button type="button" data-more-completed hidden>Show more implemented findings</button></details></fieldset>
      <p id="publication-outcome" role="status" aria-live="polite"></p><p id="publication-error" role="alert"></p><footer><button type="button" data-cancel>Cancel</button><button type="submit" class="primary" data-publish>${preview.pending ? 'Retry pending records' : 'Publish revision and record selected fixes'}</button></footer></form>`;
    document.body.append(dialog);
    for (const details of dialog.querySelectorAll<HTMLDetailsElement>('[data-diff-index]')) {
      const populate = () => {
        if (!details.open || details.dataset.loaded) return;
        const d = preview.documents[Number(details.dataset.diffIndex)]; details.dataset.loaded = 'true';
        if (d.changed) details.querySelector('[data-diff-content]')!.innerHTML = `${d.truncated ? '<p class="closed-notice">Preview shortened to 64 KiB per side. Inspect the complete document in the native editor before confirming these exact hashes.</p>' : ''}<div class="publication-diff"><section><h4>Parent snapshot</h4><pre>${esc(d.before)}</pre></section><section><h4>Saved source to publish</h4><pre>${esc(d.after)}</pre></section></div>`;
      };
      details.addEventListener('toggle', populate); populate();
    }
    const resources = dialog.querySelector<HTMLDetailsElement>('[data-resource-list]')!;
    resources.addEventListener('toggle', () => {
      if (!resources.open || resources.dataset.loaded) return; resources.dataset.loaded = 'true';
      resources.querySelector('[data-resource-content]')!.innerHTML = `<ul>${preview.resources.map(r => `<li>${esc(r.document)} · ${esc(r.reference)} · ${r.removed ? 'Removed from this snapshot' : r.changed ? 'Changed' : 'Unchanged'}<br><small>${esc(r.digest)}</small></li>`).join('')}</ul>`;
    });
    const completed = dialog.querySelector<HTMLDetailsElement>('[data-completed-findings]')!;
    let completedLimit = 50;
    const renderCompleted = () => {
      const list = preview.findings.filter(complete);
      completed.hidden = !list.length; dialog.querySelector('[data-completed-count]')!.textContent = String(list.length);
      if (completed.open) completed.querySelector('[data-completed-content]')!.innerHTML = list.slice(0, completedLimit).map(f => `<p class="publication-completed"><strong>${esc(f.quote)}</strong><small>${esc(f.document)} · Implemented · Discussion ${f.open === undefined ? 'status retained' : f.open ? 'open' : 'closed'}</small></p>`).join('');
      completed.querySelector<HTMLButtonElement>('[data-more-completed]')!.hidden = !completed.open || list.length <= completedLimit;
    };
    completed.addEventListener('toggle', renderCompleted);
    completed.querySelector('[data-more-completed]')!.addEventListener('click', () => { completedLimit += 50; renderCompleted(); });
    const filter = () => {
      const query = dialog.querySelector<HTMLInputElement>('[data-finding-search]')!.value.trim().toLowerCase();
      let count = 0, visible = 0;
      for (const group of dialog.querySelectorAll<HTMLDetailsElement>('[data-finding-group]')) {
        let shown = 0;
        for (const row of group.querySelectorAll<HTMLElement>('[data-finding]')) {
          const selected = row.querySelector<HTMLInputElement>('[data-selected]')!.checked, finding = activeById.get(row.dataset.finding!)!;
          if (selected) count++;
          row.querySelector<HTMLElement>('[data-note]')!.hidden = !selected;
          row.hidden = saved.has(finding.threadId) || !selected && ![finding.document, finding.quote, finding.body ?? '', finding.author ?? ''].join(' ').toLowerCase().includes(query);
          if (!row.hidden) shown++;
        }
        group.hidden = !shown; group.querySelector('[data-group-count]')!.textContent = String(shown);
        if (query && shown) group.open = true;
        visible += shown;
      }
      dialog.querySelector('[data-selection-count]')!.textContent = `${count} selected${confirmed ? ' · confirmed selection retained for retry' : ''}.`;
      dialog.querySelector<HTMLElement>('[data-no-findings]')!.hidden = !!visible;
      renderCompleted();
    };
    dialog.querySelector('[data-finding-search]')!.addEventListener('input', filter);
    dialog.querySelector('[data-active-findings]')!.addEventListener('change', filter); filter();
    return new Promise(resolve => {
      let busy = false, result: FindingPublicationResult | undefined;
      const form = dialog.querySelector('form')!, error = dialog.querySelector<HTMLElement>('#publication-error')!, outcome = dialog.querySelector<HTMLElement>('#publication-outcome')!, publish = dialog.querySelector<HTMLButtonElement>('[data-publish]')!;
      const progress = document.createElement('section'); progress.className = 'publication-progress'; progress.hidden = true;
      progress.innerHTML = '<strong>Publishing revision</strong><p data-publication-phase role="status" aria-live="polite"></p><progress aria-label="Publishing revision"></progress><small data-publication-elapsed></small><p>Keep this window open. Publication may already be visible to other reviewers; an interrupted action must retry the same saved intent.</p>';
      form.querySelector('footer')!.before(progress);
      const finish = () => { clearInterval(this.timer); this.timer = undefined; dialog.close(); dialog.remove(); this.dialog = undefined; returnFocus?.focus({ preventScroll: true }); resolve(result); };
      const cancel = async () => {
        if (busy) return;
        try { if (!preview.pending) await discard(); finish(); }
        catch (e) { error.textContent = e instanceof Error ? e.message : String(e); }
      };
      const manual = document.createElement('button'); manual.type = 'button'; manual.textContent = 'Keep revision; manage pending findings manually…'; manual.hidden = !preview.pending || !retire;
      form.querySelector('footer')!.before(manual);
      manual.addEventListener('click', () => {
        if (busy || !retire) return; busy = true; manual.disabled = true;
        void retire().then(accepted => { if (accepted) finish(); }).catch(e => { error.textContent = e instanceof Error ? e.message : String(e); }).finally(() => { busy = false; manual.disabled = false; });
      });
      dialog.addEventListener('cancel', event => { event.preventDefault(); void cancel(); });
      dialog.querySelector('[data-cancel]')!.addEventListener('click', () => { void cancel(); });
      form.addEventListener('submit', event => {
        event.preventDefault(); if (busy) return;
        confirmed ??= [...form.querySelectorAll<HTMLElement>('[data-finding]')].filter(el => el.querySelector<HTMLInputElement>('[data-selected]')!.checked).map(el => ({ threadId: el.dataset.finding!, summary: el.querySelector<HTMLInputElement>('[data-summary]')!.value }));
        busy = true; error.textContent = ''; outcome.textContent = preview.pending ? 'Retrying only the pending records for the published snapshot…' : 'Publishing the confirmed snapshot, then recording selected fixes…';
        dialog.setAttribute('aria-busy', 'true'); progress.hidden = false; this.progress(outcome.textContent);
        publish.textContent = preview.pending ? 'Retrying records…' : 'Publishing…'; manual.disabled = true;
        const started = performance.now();
        this.timer = setInterval(() => { progress.querySelector('[data-publication-elapsed]')!.textContent = `${Math.floor((performance.now() - started) / 1000)}s elapsed · shared-folder operations may take longer`; }, 1000);
        progress.scrollIntoView({ block: 'nearest' });
        for (const input of form.querySelectorAll<HTMLInputElement>('[data-selected], [data-summary]')) { input.readOnly = true; if (input.type === 'checkbox') input.disabled = true; }
        publish.disabled = true; dialog.querySelector<HTMLButtonElement>('[data-cancel]')!.disabled = true;
        // Let the browser paint the immediate busy state before native work starts.
        void new Promise<void>(resolve => requestAnimationFrame(() => resolve())).then(() => submit(confirmed!.map(selection => ({ ...selection })))).then(value => {
          result = value; preview.pending = value;
          if (value.records.every(r => r.saved)) { finish(); return; }
          for (const record of value.records) if (record.saved) saved.add(record.threadId);
          filter();
          outcome.textContent = `Revision published: ${value.revisionId}. ${value.records.filter(r => r.saved).length} of ${value.records.length} finding records saved. Retry creates no additional revision.`;
          error.textContent = value.records.filter(r => !r.saved).map(r => `${r.threadId}: ${r.error}`).join('\n');
          publish.textContent = 'Retry pending records'; manual.hidden = !retire;
        }).catch(e => { error.textContent = e instanceof Error ? e.message : String(e); outcome.textContent = 'Your exact publication intent is retained on this device. Retry it, or cancel before publication and prepare again.'; })
          .finally(() => { clearInterval(this.timer); this.timer = undefined; busy = false; dialog.setAttribute('aria-busy', 'false'); progress.hidden = true; manual.disabled = false; publish.disabled = false; publish.textContent = preview.pending ? 'Retry pending records' : 'Retry publication'; dialog.querySelector<HTMLButtonElement>('[data-cancel]')!.disabled = false; });
      });
      if (preview.pending) outcome.textContent = `Already published: ${preview.pending.revisionId}. Retry only pending finding records; no additional revision will be published.`;
      dialog.showModal();
    });
  }
}
