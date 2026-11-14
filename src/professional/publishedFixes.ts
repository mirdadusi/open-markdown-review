import { ascii } from './bytes';
import { ReviewFindingsIndex } from './reviewFindings';
import { threadWorkflowQueue } from './state';
import type { Event, Revision } from './types';

export interface PublishedFixChoice {
  id: string; name: string; label: string; publishedAt: string; author: string;
  parents: string[]; head: boolean; latest: boolean; originalDocumentChanged: boolean;
  changes: Array<{ path: string; kind: 'Added' | 'Modified' | 'Removed' }>;
  resourceChanges: number; policyChanged: boolean;
  fixes: Array<{ threadId: string; document: string; quote: string; comment?: string; author?: string; summary: string; status: string }>;
}
/** Eligibility is ancestry, not a timestamp, numbering label or a branch default. */
export function eligibleFixRevisions(revisions: Iterable<Revision>, origin: string, document: string): Revision[] {
  const items = [...revisions], children = new Map<string, string[]>();
  for (const revision of items) for (const parent of revision.parents) { const group = children.get(parent) ?? []; group.push(revision.id); children.set(parent, group); }
  const descendants = new Set<string>(), pending = [...(children.get(origin) ?? [])];
  while (pending.length) { const id = pending.pop()!; if (id === origin || descendants.has(id)) continue; descendants.add(id); pending.push(...(children.get(id) ?? [])); }
  return items.filter(revision => descendants.has(revision.id) && revision.documents.some(doc => doc.path === document));
}
export function publishedFixChoices(revisions: Iterable<Revision>, events: readonly Event[], origin: string, document: string, locale?: string): PublishedFixChoice[] {
  const items = [...revisions].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  const byId = new Map(items.map(revision => [revision.id, revision])), ordinals = new Map(items.map((revision, index) => [revision.id, index + 1]));
  const parents = new Set(items.flatMap(revision => revision.parents)), heads = items.filter(revision => !parents.has(revision.id));
  const index = new ReviewFindingsIndex().update(events), threads = new Map(index.threads.map(thread => [thread.root.threadId, thread]));
  const currentRecords = new Set([...threads.values()].flatMap(thread => thread.addressed ? [thread.addressed.id] : []));
  const headRecords = new Set([...threads.values()].flatMap(thread => thread.addressing.heads.map(head => head.id)));
  const records = new Map<string, Array<Extract<Event, { type: 'thread.addressed' }>>>();
  for (const event of events) if (event.type === 'thread.addressed') { const group = records.get(event.toRevisionId) ?? []; group.push(event); records.set(event.toRevisionId, group); }
  return eligibleFixRevisions(items, origin, document).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id)).map(revision => {
    const previous = revision.parents.map(id => byId.get(id)).filter((item): item is Revision => !!item);
    const current = new Map(revision.documents.map(doc => [doc.path, doc])), old = previous.map(parent => new Map(parent.documents.map(doc => [doc.path, doc])));
    const changes: PublishedFixChoice['changes'] = [];
    for (const doc of revision.documents) {
      if (old.every(parent => !parent.has(doc.path))) changes.push({ path: doc.path, kind: 'Added' });
      else if (old.some(parent => parent.get(doc.path)?.digest !== doc.digest)) changes.push({ path: doc.path, kind: 'Modified' });
    }
    for (const file of new Set(previous.flatMap(parent => parent.documents.map(doc => doc.path)))) if (!current.has(file)) changes.push({ path: file, kind: 'Removed' });
    changes.sort((a, b) => ascii(a.path, b.path));
    const resourceMaps = previous.map(parent => new Map(parent.resources.map(resource => [resource.id, resource.digest]))), resourceIds = new Set(revision.resources.map(resource => resource.id));
    const resourceChanges = revision.resources.filter(resource => resourceMaps.some(parent => parent.get(resource.id) !== resource.digest)).length + [...new Set(previous.flatMap(parent => parent.resources.map(resource => resource.id)))].filter(id => !resourceIds.has(id)).length;
    const policyChanged = previous.some(parent => parent.policy.digest !== revision.policy.digest);
    const fixes: PublishedFixChoice['fixes'] = [], seen = new Set<string>();
    const group = records.get(revision.id) ?? [], superseded = new Set(group.flatMap(event => event.addressingPredecessors));
    const rank = (event: typeof group[number]) => currentRecords.has(event.id) ? 0 : headRecords.has(event.id) ? 1 : !superseded.has(event.id) ? 2 : 3;
    // Causal heads, not clocks, select the current implementation wording.
    for (const event of [...group].sort((a, b) => rank(a) - rank(b) || Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || ascii(a.id, b.id))) {
      if (seen.has(event.threadId)) continue; seen.add(event.threadId);
      const thread = threads.get(event.threadId), queue = thread ? threadWorkflowQueue(thread) : undefined;
      const concurrent = !!thread && !thread.addressed && headRecords.has(event.id);
      const status = queue === 'conflict' ? 'Finding state conflict' : concurrent ? 'Concurrent implementation records' : thread?.addressed?.id !== event.id ? 'Historical implementation record' : queue === 'challenged' ? 'Later reopened for changes' : queue === 'disposed' ? 'Finding disposition changed' : 'Implemented';
      const fallback = `Implementation recorded in published snapshot ${revision.id} for ${event.document}.`;
      fixes.push({ threadId: event.threadId, document: event.document, quote: thread?.root.anchor.quote.exact ?? 'Original finding unavailable', comment: thread?.comment.body.text, author: thread?.root.actor.displayName || thread?.root.actor.id, summary: event.summary === fallback ? `Implementation recorded for ${event.document}.` : event.summary, status });
    }
    const name = `Snapshot ${ordinals.get(revision.id)}`, publishedAt = new Date(revision.createdAt).toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const summary = (['Added', 'Modified', 'Removed'] as const).map(kind => { const count = changes.filter(change => change.kind === kind).length; return count ? `${count} ${kind.toLowerCase()}` : ''; }).filter(Boolean);
    if (resourceChanges) summary.push(`${resourceChanges} resource change${resourceChanges === 1 ? '' : 's'}`); if (policyChanged) summary.push('policy changed');
    const head = !parents.has(revision.id), latest = head && heads.length === 1;
    return { id: revision.id, name, label: `${name} · ${publishedAt} · ${summary.join(', ') || 'No document/resource changes'}${fixes.length ? ` · ${fixes.length} recorded fix${fixes.length === 1 ? '' : 'es'}` : ''}${latest ? ' · latest' : head ? ' · branch head' : ''}`,
      publishedAt, author: revision.createdBy.displayName || revision.createdBy.id, parents: revision.parents.map(id => `Snapshot ${ordinals.get(id) ?? '?'}`), head, latest, changes, resourceChanges, policyChanged, fixes,
      originalDocumentChanged: byId.get(origin)?.documents.find(doc => doc.path === document)?.digest !== current.get(document)?.digest };
  });
}
