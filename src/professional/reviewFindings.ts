import { fold } from './state';
import type { Event, Revision } from './types';

/** Derived view only: original records/anchors are never copied to a later revision. */
export class ReviewFindingsIndex {
  version = 0;
  private key = '';
  private states = new Map<string, ReturnType<typeof fold>>();
  private lastEvents?: readonly Event[];
  private labelKey = ''; private labelCache = new Map<string, string>();
  update(events: readonly Event[]): this {
    if (events === this.lastEvents) return this; this.lastEvents = events;
    const key = events.map(event => event.id).join(',');
    if (key === this.key) return this; this.key = key; this.version++;
    const groups = new Map<string, Event[]>();
    for (const event of events) { const group = groups.get(event.revisionId) ?? []; group.push(event); groups.set(event.revisionId, group); }
    // Each admitted event is folded only in its own group, not once per snapshot.
    this.states = new Map([...groups].map(([id, group]) => [id, fold(group, id)])); return this;
  }
  state(revision: string) { return this.states.get(revision) ?? fold([], revision); }
  get threads() { return [...this.states.values()].flatMap(state => state.threads); }
  get suggestions() { return [...this.states.values()].flatMap(state => state.suggestions); }
  count(revision: string) { const state = this.state(revision); return state.threads.length + state.suggestions.length; }
  labels(revisions: Iterable<Revision>): Map<string, string> {
    const items = [...revisions], key = `${this.key}:${items.map(r => r.id).join(',')}`;
    if (key !== this.labelKey) { this.labelKey = key; this.labelCache = snapshotLabels(items, this); } return this.labelCache;
  }
}
export function snapshotLabels(revisions: Iterable<Revision>, index: ReviewFindingsIndex, locale?: string): Map<string, string> {
  const items = [...revisions].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  return new Map(items.map((revision, i) => [revision.id, `Snapshot ${i + 1} · ${new Date(revision.createdAt).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })} · ${index.count(revision.id)} finding${index.count(revision.id) === 1 ? '' : 's'}`]));
}
