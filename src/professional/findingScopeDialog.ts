import { FindingScopeChoice, FindingScopePlan, findingScopeProblems } from './findingScope';
import { escapeHtml as esc } from './html';

/** Author-only scope choice. Selection never publishes evidence or changes source. */
export class FindingScopeDialog {
  async show(plan: FindingScopePlan): Promise<FindingScopeChoice | undefined> {
    const returnFocus = document.activeElement as HTMLElement | null, dialog = document.createElement('dialog');
    dialog.id = 'finding-scope-dialog'; dialog.setAttribute('aria-labelledby', 'finding-scope-title');
    const row = (doc: FindingScopePlan['documents'][number]) => `<label class="scope-document"><input type="checkbox" data-scope-path="${esc(doc.path)}" ${doc.inReview ? 'checked' : ''} ${doc.path === plan.rootDocument ? 'disabled' : ''}><span>${esc(doc.path)}<small>${!doc.available ? 'Missing/unavailable source — restore it or explicitly remove it from scope.' : doc.inReview ? doc.path === plan.rootDocument ? 'Root document · kept in scope' : 'Existing scope' : 'New referenced Markdown · not included until selected'}${doc.referencedBy.length ? `<br>Referenced by: ${doc.referencedBy.map(esc).join(', ')}` : ''}</small></span></label>`;
    dialog.innerHTML = `<form><h2 id="finding-scope-title">Confirm documents for this fix</h2><p>${esc(plan.reviewTitle)} · Scope changes apply only to the new snapshot. Existing comments and snapshots remain intact.</p><p>New Markdown references were found, or an existing source/link needs attention. Select the new files you want reviewers to receive. Dependencies are not selected automatically.</p>
      <h3>Newly referenced Markdown</h3>${plan.documents.some(doc => !doc.inReview && doc.available) ? '<button type="button" data-scope-include-references>Include all available referenced files</button>' : ''}${plan.documents.filter(doc => !doc.inReview).map(row).join('') || '<p>No new linked Markdown files.</p>'}
      <details data-existing-scope ${plan.documents.some(doc => doc.inReview && !doc.available) ? 'open' : ''}><summary>Existing review scope (${plan.documents.filter(doc => doc.inReview).length})</summary><p>Uncheck only documents you intend to remove from the new snapshot. Files are never deleted from source or previous snapshots. Findings on removed documents are preserved but cannot be recorded as implemented by this publication.</p>${plan.documents.filter(doc => doc.inReview).map(row).join('')}</details>
      <p data-scope-count role="status" aria-live="polite"></p><div data-scope-problems role="alert"></div><p>Links are checked against saved source files, not external websites. Images, Mermaid and attachments are captured during the comparison step. This step does not publish anything.</p>
      <footer><button type="button" data-scope-cancel>Cancel</button><button type="submit" class="primary" data-scope-continue>Prepare comparison</button></footer></form>`;
    document.body.append(dialog);
    const paths = () => [...dialog.querySelectorAll<HTMLInputElement>('[data-scope-path]:checked')].map(input => input.dataset.scopePath!);
    const update = () => {
      const selected = paths(), problems = findingScopeProblems(plan, selected), added = selected.filter(file => !plan.documents.find(doc => doc.path === file)!.inReview).length, removed = plan.documents.filter(doc => doc.inReview && !selected.includes(doc.path)).length;
      dialog.querySelector('[data-scope-count]')!.textContent = `${selected.length} documents · ${added} added · ${removed} removed`;
      dialog.querySelector('[data-scope-problems]')!.innerHTML = problems.length ? `<p>Resolve these before preparing:</p><ul>${problems.slice(0, 20).map(problem => `<li>${esc(problem)}</li>`).join('')}</ul>${problems.length > 20 ? `<p>${problems.length - 20} more link problems.</p>` : ''}` : '<p>All local Markdown document links are included.</p>';
      dialog.querySelector<HTMLButtonElement>('[data-scope-continue]')!.disabled = !!problems.length;
    };
    dialog.addEventListener('change', update); update(); dialog.showModal();
    dialog.querySelector('[data-scope-include-references]')?.addEventListener('click', () => {
      for (const input of dialog.querySelectorAll<HTMLInputElement>('[data-scope-path]')) if (plan.documents.some(doc => doc.path === input.dataset.scopePath && !doc.inReview && doc.available)) input.checked = true;
      update();
    });
    return new Promise(resolve => {
      const finish = (choice?: FindingScopeChoice) => { dialog.close(); dialog.remove(); returnFocus?.focus({ preventScroll: true }); resolve(choice); };
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
      dialog.querySelector('[data-scope-cancel]')!.addEventListener('click', () => finish());
      dialog.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); const selected = paths(); if (!findingScopeProblems(plan, selected).length) finish({ planDigest: plan.digest, documents: selected, parents: [...plan.parents] }); });
    });
  }
}
