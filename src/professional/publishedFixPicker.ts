import type { PublishedFixChoice } from './publishedFixes';
import { escapeHtml as esc } from './html';

const excerpt = (value: string) => { const text = value.replace(/\s+/g, ' ').trim(), shortened = text.slice(0, 220).replace(/[\uD800-\uDBFF]$/, ''); return text.length > shortened.length ? `${shortened}…` : text; };
/** Derived selection details only: no document reads until explicit preview. */
export function mountPublishedFixPicker(host: HTMLElement, select: HTMLSelectElement, choices: readonly PublishedFixChoice[], inspect: (id: string) => Promise<void>): () => void {
  host.id = 'published-fix-summary'; host.setAttribute('aria-live', 'polite');
  let disposed = false;
  const update = () => {
    if (disposed) return;
    const choice = choices.find(item => item.id === select.value);
    if (!choice) { host.innerHTML = '<p>Choose the snapshot that already contains this fix. Previewing and selecting do not record implementation.</p>'; return; }
    host.innerHTML = `<h3>${esc(choice.name)}</h3><p>${esc(choice.publishedAt)} · Published by ${esc(choice.author)}${choice.latest ? ' · Latest snapshot' : choice.head ? ' · Branch head' : ''}</p>
      <p>Changes compared with ${choice.parents.map(esc).join(', ')}${choice.parents.length > 1 ? ' (differences from any parent)' : ''}:</p>
      ${choice.changes.length ? `<ul>${choice.changes.slice(0, 8).map(change => `<li>${change.kind}: ${esc(change.path)}</li>`).join('')}</ul>${choice.changes.length > 8 ? `<details><summary>${choice.changes.length - 8} more changed documents</summary><ul>${choice.changes.slice(8).map(change => `<li>${change.kind}: ${esc(change.path)}</li>`).join('')}</ul></details>` : ''}` : '<p>No Markdown document changes.</p>'}
      ${choice.resourceChanges ? `<p>${choice.resourceChanges} image/attachment change${choice.resourceChanges === 1 ? '' : 's'}.</p>` : ''}${choice.policyChanged ? '<p>Review policy changed.</p>' : ''}
      ${!choice.originalDocumentChanged ? '<p>The original finding document is unchanged from its reviewed snapshot. Check whether the fix is elsewhere in this publication.</p>' : ''}
      <details data-recorded-fixes><summary>Recorded fixes (${choice.fixes.length})</summary><div data-fix-records></div><button type="button" data-more-fix-records hidden>Show more recorded fixes</button></details>
      <button type="button" data-preview-snapshot>Preview selected snapshot…</button><p data-preview-error role="alert"></p>
      <details data-snapshot-audit><summary>Audit identifier</summary><code>${esc(choice.id)}</code></details>`;
    host.querySelector<HTMLButtonElement>('[data-preview-snapshot]')!.addEventListener('click', async event => {
      const button = event.currentTarget as HTMLButtonElement; button.disabled = true;
      try { await inspect(choice.id); } catch (error) { if (host.isConnected && select.value === choice.id) host.querySelector('[data-preview-error]')!.textContent = error instanceof Error ? error.message : String(error); }
      finally { button.disabled = false; }
    });
    const records = host.querySelector<HTMLDetailsElement>('[data-recorded-fixes]')!; let limit = 20;
    const renderRecords = () => {
      if (!records.open) return;
      records.querySelector('[data-fix-records]')!.innerHTML = choice.fixes.length ? choice.fixes.slice(0, limit).map(fix => `<div class="snapshot-fix"><strong>${esc(excerpt(fix.comment || fix.quote))}</strong>${fix.comment ? `<p>Quoted text: ${esc(excerpt(fix.quote))}</p>` : ''}<p>${esc(excerpt(fix.summary))}</p><small>${fix.author ? `${esc(fix.author)} · ` : ''}${esc(fix.document)} · ${esc(fix.status)}</small></div>`).join('') : '<p>No implementation records reference this snapshot yet. That does not mean its documents contain no fixes.</p>';
      records.querySelector<HTMLButtonElement>('[data-more-fix-records]')!.hidden = choice.fixes.length <= limit;
    };
    records.addEventListener('toggle', renderRecords); records.querySelector('[data-more-fix-records]')!.addEventListener('click', () => { limit += 20; renderRecords(); });
  };
  select.addEventListener('change', update); update();
  return () => { disposed = true; select.removeEventListener('change', update); };
}
