import { fold, threadWorkflowQueue, type ThreadWorkflowQueue } from './state';
import type { Event } from './types';
import type { PdfReviewState } from './pdfComments';

type ReviewState = ReturnType<typeof fold>;
type Status = { subject: string; native?: { value: PdfReviewState; event: Event } };
const decisionLabels = { accepted: 'Accepted', rejected: 'Rejected', 'wont-fix': 'Won’t fix', duplicate: 'Duplicate' };
const implementationLabels: Partial<Record<ThreadWorkflowQueue, string>> = {
  'accepted-not-implemented': 'Implementation pending', implemented: 'Implemented', verified: 'Verified', challenged: 'Implementation challenged',
};

/** Project the captured state, not a replay of workflow events into the comments pane. */
export function pdfThreadStatus(thread: ReviewState['threads'][number]): Status {
  const queue = threadWorkflowQueue(thread);
  const decision = thread.decision.heads[0], lifecycle = thread.status.heads[0], verification = thread.verification.heads[0];
  const disposition = !thread.decision.conflict && decision?.type === 'thread.decided' ? decision.decision : undefined;
  const subject = ['Review comment', thread.status.conflict ? 'Discussion conflict' : thread.open ? 'Open' : 'Closed',
    disposition ? decisionLabels[disposition] : thread.decision.conflict ? 'Decision conflict' : 'No decision',
    queue === 'conflict' ? 'Unresolved conflict' : implementationLabels[queue]].filter(Boolean).join(' · ');
  if (queue === 'conflict') return { subject }; // Never pick a winner for a conflicted register.
  if (disposition === 'rejected') return { subject, native: { value: 'Rejected', event: decision } };
  if (disposition === 'wont-fix' || disposition === 'duplicate') return { subject, native: { value: 'Cancelled', event: decision } };
  if (queue === 'challenged' && verification) return { subject, native: { value: 'None', event: verification } };
  // Closing a discussion is not proof that an accepted change was implemented.
  if (!thread.open && queue !== 'accepted-not-implemented' && lifecycle) return { subject, native: { value: 'Completed', event: lifecycle } };
  if (disposition === 'accepted') return { subject, native: { value: 'Accepted', event: decision } };
  if (lifecycle?.type === 'thread.reopened') return { subject, native: { value: 'None', event: lifecycle } };
  return { subject }; // An untouched open comment has PDF’s default Review state (None).
}

export function pdfSuggestionStatus(suggestion: ReviewState['suggestions'][number]): Status {
  const { status } = suggestion;
  const subject = `Suggested edit · ${status[0].toUpperCase() + status.slice(1)}`;
  const event = status === 'applied' ? suggestion.applications[0] : suggestion.decision.heads[0];
  if (!event || status === 'conflicted' || status === 'open') return { subject };
  return { subject, native: { value: status === 'applied' ? 'Completed' : status === 'accepted' ? 'Accepted' : 'Rejected', event } };
}
