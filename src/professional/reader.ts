/** Disposable client view state. Never writes documents, protocol events or completion. */
export interface ReadingPosition { path: string; offset: number }
interface Page<T> { path: string; section: HTMLElement; body: HTMLElement; value: T }
export interface ReaderOptions<T> {
  load(path: string, signal: AbortSignal): Promise<{ body: HTMLElement; value: T }>;
  active(page: Page<T>): void;
  mounted(pages: readonly Page<T>[]): void;
  changed(): void;
  offset(): number;
  hold(): boolean;
}
export function readingOrder(paths: readonly string[], root: string): string[] {
  return [root, ...paths.filter(path => path !== root)];
}
export class DocumentReader<T> {
  private pages: Page<T>[] = [];
  private paths: string[] = [];
  private key = '';
  private epoch = 0;
  private controller?: AbortController;
  private busy = false;
  private failed = new Set<string>();
  private history: ReadingPosition[] = [];
  private frame = 0;
  activePath = '';
  continuous = true;
  constructor(private host: HTMLElement, private options: ReaderOptions<T>) {
    window.addEventListener('scroll', () => this.schedule(), { passive: true });
    window.addEventListener('resize', () => this.schedule(), { passive: true });
  }
  configure(key: string, paths: string[], continuous: boolean) {
    if (key !== this.key || continuous !== this.continuous) {
      this.cancel(); this.pages = []; if (key !== this.key) this.history = []; this.activePath = ''; this.failed.clear();
      this.host.replaceChildren(); this.key = key;
    }
    this.paths = paths; this.continuous = continuous;
  }
  cancel() { this.epoch++; this.controller?.abort(); this.controller = undefined; this.busy = false; }
  position(): ReadingPosition | undefined {
    const page = this.pages.find(page => page.path === this.activePath);
    return page && { path: page.path, offset: page.section.getBoundingClientRect().top - this.options.offset() };
  }
  get canGoBack() { return this.history.length > 0; }
  get mounted() { return this.pages as readonly Page<T>[]; }
  pageFor(node: Node | null) { return this.pages.find(page => !!node && page.body.contains(node)); }
  async back() {
    const position = this.history.pop();
    if (position) await this.navigate(position.path, { remember: false, offset: position.offset });
  }
  async navigate(path: string, { remember = true, top = true, offset = 0 } = {}) {
    if (!this.paths.includes(path)) throw new Error('Document is outside this frozen revision.');
    const previous = this.position();
    this.cancel(); const epoch = this.epoch, controller = new AbortController(); this.controller = controller;
    let page = this.pages.find(item => item.path === path);
    if (!page) {
      this.busy = true;
      try {
        page = await this.load(path, controller.signal);
        if (epoch !== this.epoch) return;
        this.pages = [page]; this.host.replaceChildren(page.section);
      } finally { if (epoch === this.epoch) this.busy = false; }
    }
    if (epoch !== this.epoch) return;
    if (remember && top && previous) { this.history.push(previous); if (this.history.length > 50) this.history.shift(); }
    this.activePath = path; this.failed.delete(path);
    this.options.active(page); this.options.mounted(this.pages); this.options.changed();
    if (top) this.align(page.section, offset);
    this.schedule();
  }
  private align(element: HTMLElement, offset = 0) {
    window.scrollBy({ top: element.getBoundingClientRect().top - this.options.offset() - offset, behavior: 'instant' });
  }
  private async load(path: string, signal: AbortSignal): Promise<Page<T>> {
    const { body, value } = await this.options.load(path, signal);
    const section = document.createElement('section'); section.dataset.readingDocument = path; section.className = 'reading-document'; section.setAttribute('aria-label', path);
    const heading = document.createElement('div'); heading.className = 'document-boundary'; heading.textContent = `${this.paths.indexOf(path) + 1} / ${this.paths.length} · ${path}`;
    const footer = document.createElement('footer'); footer.className = 'document-end';
    const next = this.paths[this.paths.indexOf(path) + 1];
    if (next) {
      const button = document.createElement('button'); button.dataset.readerDocument = next; button.textContent = `Next: ${next}`; footer.append(button);
      const hint = document.createElement('small'); hint.textContent = this.continuous ? 'Keep scrolling to continue. Reading does not finish your review.' : 'Open the next document, or enable continuous reading.'; footer.append(hint);
    } else footer.textContent = 'End of review documents. Use Finish my review when your review is complete.';
    body.dataset.readingBody = ''; section.append(heading, body, footer);
    return { path, body, value, section };
  }
  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; void this.update(); });
  }
  private async update() {
    if (!this.pages.length || this.busy || this.options.hold()) return;
    const offset = this.options.offset() + 48;
    const visible = this.pages.filter(page => page.section.getBoundingClientRect().top <= offset).at(-1) ?? this.pages[0];
    if (visible.path !== this.activePath) { this.activePath = visible.path; this.options.active(visible); this.options.changed(); }
    if (!this.continuous) return;
    const first = this.pages[0], last = this.pages.at(-1)!;
    // Only load a neighbour when the reading column itself reaches the viewport.
    const next = this.paths[this.paths.indexOf(last.path) + 1], previous = this.paths[this.paths.indexOf(first.path) - 1];
    if (next && (this.pages.length < 3 || this.activePath !== first.path) && last.section.getBoundingClientRect().bottom < window.innerHeight + 400 && !this.failed.has(next)) await this.extend(next, false);
    else if (previous && (this.pages.length < 3 || this.activePath !== last.path) && first.section.getBoundingClientRect().top > this.options.offset() - 400 && !this.failed.has(previous)) await this.extend(previous, true);
  }
  private async extend(path: string, prepend: boolean) {
    this.busy = true; const epoch = this.epoch, controller = new AbortController(); this.controller = controller;
    const neighbour = prepend ? this.pages[0] : this.pages.at(-1)!;
    const notice = document.createElement('p'); notice.className = 'reader-loading'; notice.setAttribute('role', 'status'); notice.textContent = `Loading ${path}…`;
    neighbour.section.append(notice);
    try {
      const page = await this.load(path, controller.signal);
      if (epoch !== this.epoch) return;
      // A user can start selecting while an adjacent document is loading. Do not
      // disturb that selection or draft; retry on the next intentional scroll.
      if (this.options.hold()) return;
      const anchor = this.pages.find(item => item.path === this.activePath) ?? neighbour;
      const top = anchor.section.getBoundingClientRect().top;
      if (prepend) { this.pages.unshift(page); this.host.prepend(page.section); }
      else { this.pages.push(page); this.host.append(page.section); }
      // At most three rendered documents, plus one in-flight load. No unbounded
      // DOM/image/Mermaid cache, including on a slow synchronized share.
      while (this.pages.length > 3) {
        const removed = prepend ? this.pages.pop()! : this.pages.shift()!; removed.section.remove();
      }
      notice.remove(); this.options.mounted(this.pages);
      window.scrollBy({ top: anchor.section.getBoundingClientRect().top - top, behavior: 'instant' });
    } catch (error) {
      if (epoch !== this.epoch || controller.signal.aborted) return;
      this.failed.add(path); notice.textContent = `Could not load ${path}. ${error instanceof Error ? error.message : String(error)} `;
      const retry = document.createElement('button'); retry.dataset.readerDocument = path; retry.textContent = 'Retry / open document'; notice.append(retry);
    } finally {
      if (!this.failed.has(path)) notice.remove();
      if (epoch === this.epoch) { this.busy = false; this.schedule(); }
    }
  }
}
