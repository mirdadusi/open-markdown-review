import { ascii } from './bytes';
import { Event, Policy, PolicyResult, Revision, Diagnostic, LIMITS } from './types';
export function registerKey(e: Event): string | undefined {
  if (e.type === 'thread.resolved' || e.type === 'thread.reopened') return `status:${e.threadId}`;
  if (e.type === 'thread.decided') return `decision:${e.threadId}`;
  if (e.type === 'suggestion.accepted' || e.type === 'suggestion.rejected') return `suggestion:${e.suggestionId}`;
  if ('stancePredecessors' in e) return `stance:${e.revisionId}:${e.actor.id}`;
  return undefined;
}
export function predecessors(e: Event): string[] {
  return 'statusPredecessors' in e ? e.statusPredecessors : 'decisionPredecessors' in e ? e.decisionPredecessors : 'stancePredecessors' in e ? e.stancePredecessors : [];
}
export const registerValue = (e: Event): string => e.type === 'thread.decided' ? e.decision : e.type;
export function heads(events: readonly Event[]): Event[] {
  const superseded = new Set(events.flatMap(predecessors)); return events.filter(e => !superseded.has(e.id));
}
export const conflicted = (events: readonly Event[]): boolean => new Set(heads(events).map(registerValue)).size > 1;
export function dependencies(e: Event, all: readonly Event[], revisions: ReadonlyMap<string, Revision>): string[] {
  const result = [...predecessors(e)];
  if (e.type !== 'revision.created') result.push(...all.filter(p => p.type === 'revision.created' && p.revisionId === e.revisionId).map(p => p.id));
  else for (const parent of revisions.get(e.revisionId)?.parents ?? []) result.push(...all.filter(p => p.type === 'revision.created' && p.revisionId === parent).map(p => p.id));
  if ('threadId' in e && e.type !== 'comment.created') result.push(...all.filter(p => p.type === 'comment.created' && p.threadId === e.threadId).map(p => p.id));
  if ('suggestionId' in e && e.type !== 'suggestion.created') result.push(...all.filter(p => p.type === 'suggestion.created' && p.suggestionId === e.suggestionId).map(p => p.id));
  if (e.type === 'comment.replied' && e.inReplyTo) result.push(...all.filter(p => 'commentId' in p && p.commentId === e.inReplyTo).map(p => p.id));
  if (e.type === 'suggestion.applied') result.push(...e.acceptanceIds);
  return [...new Set(result)];
}
/** Order-independent graph admission. Missing dependencies stay pending, never become approvals. */
export function admit(events: readonly Event[], revisions: ReadonlyMap<string, Revision>, receiptDependencies = new Map<string, string[]>()) {
  const errors = new Map<string, string>(); const byId = new Map(events.map(e => [e.id, e]));
  const bad = (e: Event, why: string) => { errors.set(e.id, why); };
  const unique = (key: (e: Event) => string | undefined) => {
    const seen = new Map<string, Event>();
    for (const e of events) { const k = key(e); if (k === undefined) continue; const old = seen.get(k); if (old) { bad(old, `Identity collision: ${k}`); bad(e, `Identity collision: ${k}`); } else seen.set(k, e); }
  };
  unique(e => e.id); unique(e => JSON.stringify([e.actor.id, e.operationId]));
  unique(e => e.type === 'revision.created' ? e.revisionId : undefined);
  unique(e => e.type === 'comment.created' ? e.threadId : undefined);
  unique(e => e.type === 'suggestion.created' ? e.suggestionId : undefined);
  unique(e => 'commentId' in e ? e.commentId : undefined);
  const publications = new Map(events.filter(e => e.type === 'revision.created').map(e => [e.revisionId, e]));
  const threadRoots = new Map(events.filter((e): e is Extract<Event, { type: 'comment.created' }> => e.type === 'comment.created').map(e => [e.threadId, e]));
  const suggestionRoots = new Map(events.filter((e): e is Extract<Event, { type: 'suggestion.created' }> => e.type === 'suggestion.created').map(e => [e.suggestionId, e]));
  const comments = new Map(events.filter((e): e is Extract<Event, { type: 'comment.created' | 'comment.replied' }> => 'commentId' in e).map(e => [e.commentId, e]));
  for (const e of events) {
    const publication = publications.get(e.revisionId), revision = revisions.get(e.revisionId);
    if (!publication || !revision) bad(e, 'Missing revision publication/descriptor.');
    else {
      if (publication.revisionDigest !== e.revisionDigest) bad(e, 'Revision digest differs from publication.');
      if (e.type === 'revision.created' && revision.parents.some(p => !publications.has(p))) bad(e, 'Missing revision parent.');
    }
    for (const p of predecessors(e)) { const parent = byId.get(p); if (!parent || parent.id === e.id || parent.reviewId !== e.reviewId || parent.revisionId !== e.revisionId || registerKey(parent) !== registerKey(e)) bad(e, 'Missing or incompatible causal predecessor.'); }
    if ('threadId' in e && e.type !== 'comment.created') {
      const root = threadRoots.get(e.threadId);
      if (!root || root.revisionId !== e.revisionId) bad(e, 'Missing or ambiguous thread root.');
      if (e.type === 'comment.replied' && e.inReplyTo) { const p = comments.get(e.inReplyTo); if (!p || p.threadId !== e.threadId || p.revisionId !== e.revisionId || p.id === e.id) bad(e, 'Reply parent is outside this thread.'); }
    }
    if ('suggestionId' in e && e.type !== 'suggestion.created') {
      const root = suggestionRoots.get(e.suggestionId);
      if (!root || root.revisionId !== e.revisionId) bad(e, 'Missing suggestion root.');
      if (e.type === 'suggestion.applied') {
        if (root?.type === 'suggestion.created' && root.anchor.document !== e.document) bad(e, 'Application document differs.');
        if (e.acceptanceIds.some(id => { const p = byId.get(id); return p?.type !== 'suggestion.accepted' || p.suggestionId !== e.suggestionId || p.revisionId !== e.revisionId; })) bad(e, 'Application has invalid acceptance evidence.');
      }
    }
  }
  const colors = new Map<string, number>();
  const graphDepth = new Map<string, number>();
  const dependencyIndex = new Map(events.map(e => {
    const result = [...predecessors(e), ...(receiptDependencies.get(e.id) ?? [])];
    if (e.type !== 'revision.created') { const p = publications.get(e.revisionId); if (p) result.push(p.id); }
    else for (const parent of revisions.get(e.revisionId)?.parents ?? []) { const p = publications.get(parent); if (p) result.push(p.id); }
    if ('threadId' in e && e.type !== 'comment.created') { const p = threadRoots.get(e.threadId); if (p) result.push(p.id); }
    if ('suggestionId' in e && e.type !== 'suggestion.created') { const p = suggestionRoots.get(e.suggestionId); if (p) result.push(p.id); }
    if (e.type === 'comment.replied' && e.inReplyTo) { const p = comments.get(e.inReplyTo); if (p) result.push(p.id); }
    if (e.type === 'suggestion.applied') result.push(...e.acceptanceIds);
    return [e.id, result] as const;
  }));
  const deps = (e: Event) => dependencyIndex.get(e.id)!;
  const visit = (e: Event, depth: number): void => {
    if (depth > LIMITS.depth) { bad(e, 'Causal depth exceeds limit.'); return; }
    if (colors.get(e.id) === 1) { bad(e, 'Causal cycle.'); return; }
    if (colors.get(e.id) === 2) return;
    colors.set(e.id, 1);
    let longest = 0;
    for (const id of deps(e)) { const p = byId.get(id); if (!p) { bad(e, 'Missing dependency.'); continue; } visit(p, depth + 1); longest = Math.max(longest, (graphDepth.get(id) ?? 0) + 1); if (errors.has(id)) bad(e, `Invalid dependency: ${id}`); }
    graphDepth.set(e.id, longest); if (longest > LIMITS.depth) bad(e, 'Causal depth exceeds limit.');
    colors.set(e.id, 2);
  };
  for (const e of events) visit(e, 0);
  // A cycle may mark a parent after an earlier dependent completed; close transitively.
  let changed = true;
  while (changed) { changed = false; for (const e of events) if (!errors.has(e.id) && deps(e).some(id => errors.has(id))) { bad(e, 'Invalid dependency.'); changed = true; } }
  return { events: events.filter(e => !errors.has(e.id)).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || ascii(a.id, b.id)), diagnostics: [...errors].map(([id, message]): Diagnostic => ({ code: 'event.graph', severity: 'error', path: id, message })) };
}
export function fold(events: readonly Event[], revisionId: string) {
  const current = events.filter(e => e.revisionId === revisionId);
  const registers = new Map<string, Event[]>();
  const replies = new Map<string, Extract<Event, { type: 'comment.replied' }>[]>();
  const applicationsBySuggestion = new Map<string, Extract<Event, { type: 'suggestion.applied' }>[]>();
  for (const e of current) {
    const key = registerKey(e); if (key) { const list = registers.get(key) ?? []; list.push(e); registers.set(key, list); }
    if (e.type === 'comment.replied') { const list = replies.get(e.threadId) ?? []; list.push(e); replies.set(e.threadId, list); }
    if (e.type === 'suggestion.applied') { const list = applicationsBySuggestion.get(e.suggestionId) ?? []; list.push(e); applicationsBySuggestion.set(e.suggestionId, list); }
  }
  const register = (key: string) => { const history = registers.get(key) ?? []; return { history, heads: heads(history), conflict: conflicted(history) }; };
  const threads = current.filter((e): e is Extract<Event, { type: 'comment.created' }> => e.type === 'comment.created').map(root => {
    const status = register(`status:${root.threadId}`), decision = register(`decision:${root.threadId}`);
    return { root, status, decision, open: status.conflict || decision.conflict || !status.heads.length || status.heads.some(e => e.type === 'thread.reopened'), replies: replies.get(root.threadId) ?? [] };
  });
  const suggestions = current.filter((e): e is Extract<Event, { type: 'suggestion.created' }> => e.type === 'suggestion.created').map(root => {
    const decision = register(`suggestion:${root.suggestionId}`), applications = applicationsBySuggestion.get(root.suggestionId) ?? [];
    const applicationConflict = new Set(applications.map(e => `${e.sourceDigestBefore}:${e.sourceDigestAfter}`)).size > 1 || (applications.length > 0 && decision.heads.some(e => e.type === 'suggestion.rejected'));
    const status = decision.conflict || applicationConflict ? 'conflicted' : applications.length ? 'applied' : decision.heads[0]?.type === 'suggestion.rejected' ? 'rejected' : decision.heads.length ? 'accepted' : 'open';
    return { root, decision, applications, status, open: !['applied', 'rejected'].includes(status) };
  });
  const stances = [...registers.keys()].filter(k => k.startsWith('stance:')).map(k => ({ actor: registers.get(k)![0].actor.id, ...register(k) }));
  return { threads, suggestions, stances, current, register };
}
export function policyResult(policy: Policy, events: readonly Event[], revision: string): PolicyResult {
  if (policy.mode === 'assertions-only') return 'not-evaluated';
  const state = fold(events, revision), stances = state.stances.filter(s => policy.eligibleActorIds.includes(s.actor));
  if (stances.some(s => s.conflict) || state.threads.some(t => t.status.conflict || t.decision.conflict) || state.suggestions.some(s => s.status === 'conflicted')) return 'conflicted';
  const approvals = stances.filter(s => s.heads.length && s.heads.every(e => e.type === 'review.approved')).length;
  return approvals >= policy.minimumApprovals && (!policy.blockOnRejection || !stances.some(s => s.heads.some(e => e.type === 'review.rejected'))) && (!policy.requireResolvedThreads || !state.threads.some(t => t.open)) && (!policy.requireClosedSuggestions || !state.suggestions.some(s => s.open)) ? 'satisfied' : 'unsatisfied';
}
