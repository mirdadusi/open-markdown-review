/** Immediate, accessible feedback at the point of action, before any host I/O. */
export class FindingPreparationDialog {
  private dialog?: HTMLDialogElement;
  private timer?: ReturnType<typeof setInterval>;
  private returnFocus?: HTMLElement;
  cancelled = false;
  failed = false;
  begin(cancel: () => Promise<unknown>): void {
    this.close(); this.cancelled = false; this.failed = false; this.returnFocus = document.activeElement as HTMLElement | undefined;
    const dialog = document.createElement('dialog'); this.dialog = dialog; dialog.id = 'finding-preparation-dialog';
    dialog.setAttribute('aria-labelledby', 'finding-preparation-title');
    dialog.innerHTML = '<h2 id="finding-preparation-title">Preparing comparison…</h2><p data-phase role="status" aria-live="polite">Checking the review and saved source…</p><progress aria-label="Preparing comparison"></progress><p>Capturing a private preview. No revision or finding record is published until you inspect and confirm it.</p><small data-elapsed></small><p data-error role="alert"></p><footer><button type="button" data-cancel-preparation>Cancel preparation</button></footer>';
    const button = dialog.querySelector<HTMLButtonElement>('[data-cancel-preparation]')!;
    const request = () => {
      if (this.failed) { this.close(); return; }
      if (this.cancelled) return;
      this.cancelled = true; button.disabled = true;
      this.progress('Canceling preparation; waiting for the current file operation to stop…');
      void cancel().catch(() => this.progress('Cancellation requested. Waiting for the native preparation to finish; nothing will be published.'));
    };
    button.addEventListener('click', request); dialog.addEventListener('cancel', event => { event.preventDefault(); request(); });
    document.body.append(dialog); dialog.showModal();
    const started = performance.now(); this.timer = setInterval(() => {
      if (dialog.isConnected) dialog.querySelector('[data-elapsed]')!.textContent = `${Math.floor((performance.now() - started) / 1000)}s elapsed · shared-folder reads may take longer`;
    }, 1000);
  }
  progress(message: string): void { if (this.dialog && !this.failed) this.dialog.querySelector('[data-phase]')!.textContent = message; }
  fail(message: string): void {
    if (!this.dialog) return;
    clearInterval(this.timer); this.timer = undefined; this.failed = true;
    this.dialog.querySelector('h2')!.textContent = 'Could not prepare comparison';
    this.dialog.querySelector('[data-phase]')!.textContent = 'Preparation stopped. Nothing was published by this preparation.';
    this.dialog.querySelector('[data-error]')!.textContent = message;
    this.dialog.querySelector('progress')!.hidden = true;
    const button = this.dialog.querySelector<HTMLButtonElement>('button')!; button.disabled = false; button.textContent = 'Close';
  }
  close(): void {
    clearInterval(this.timer); this.timer = undefined;
    this.dialog?.close(); this.dialog?.remove(); this.dialog = undefined;
    if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
  }
}
