import { newId } from './bytes';
import type { ActionContext } from './session';
import { fold, threadWorkflowQueue } from './state';
import type { Event } from './types';

/** Retains the exact two-event intent across an interrupted append-only write. */
export function reopenFinding(ctx: ActionContext, threadId: string) {
  let prepared: Event[] | undefined, originalReason: string | undefined;
  return async (reason: string): Promise<void> => {
    if (ctx.actor.id !== ctx.session.manifest.createdBy.id) throw new Error('Only the review initiator can reopen a processed finding.');
    if (!reason.trim()) throw new Error('Explain why this finding needs more work.');
    if (prepared && reason !== originalReason) throw new Error('Reopening may be partly saved. Retry the original reason before starting another action.');
    if (!prepared) {
      await ctx.session.refresh();
      const thread = fold(ctx.session.events, ctx.revision.id).threads.find(t => t.root.threadId === threadId);
      if (!thread?.addressed || !['implemented', 'verified'].includes(threadWorkflowQueue(thread))) throw new Error('The implementation changed or the finding is already reopened. Refresh and inspect its current state.');
      const operation = newId('reopen');
      prepared = [ctx.session.makeEvent(ctx, { type: 'thread.verification.recorded', threadId, addressedEventId: thread.addressed.id, verdict: 'challenged', note: reason.trim(), verificationPredecessors: thread.verification.heads.map(e => e.id) }, `${operation}_rework`)];
      if (!thread.open) prepared.push(ctx.session.makeEvent(ctx, { type: 'thread.reopened', threadId, reason: reason.trim(), statusPredecessors: thread.status.heads.map(e => e.id) }, `${operation}_discussion`));
      originalReason = reason;
    }
    for (const event of prepared) await ctx.session.save(ctx, event);
  };
}
