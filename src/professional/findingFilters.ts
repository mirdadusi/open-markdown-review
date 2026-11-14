import type { Event } from './types';

export type DiscussionFilter = 'all' | 'open' | 'closed';
export type DecisionFilter = 'all' | 'undecided' | 'accepted' | 'rejected' | 'deferred' | 'duplicate' | 'conflict';
interface FilterableFinding { open: boolean; decision: { heads: readonly Event[]; conflict: boolean } }
/** Independent projections: a closed discussion can still have no decision. */
export function matchesFindingFilters(finding: FilterableFinding, discussion: string, decision: string): boolean {
  if (discussion === 'open' && !finding.open || discussion === 'closed' && finding.open) return false;
  if (decision === 'all') return true;
  if (decision === 'undecided') return finding.decision.heads.length === 0;
  if (decision === 'conflict') return finding.decision.conflict;
  return !finding.decision.conflict && finding.decision.heads.length > 0 && finding.decision.heads.every(event =>
    event.type === 'thread.decided' ? event.decision === decision
      : event.type === 'suggestion.accepted' ? decision === 'accepted'
        : event.type === 'suggestion.rejected' && decision === 'rejected');
}
