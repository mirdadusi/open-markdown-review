import type { ThreadWorkflowQueue } from './state';

export interface FindingAction { action: string; label: string }
export interface FindingActionContext {
  queue: ThreadWorkflowQueue; open: boolean; creator: boolean; locked: boolean;
  native: boolean; canEdit: boolean; addressing: boolean; accepted: boolean;
  addressed: boolean; otherRevision: boolean;
  verificationConflict?: boolean;
}
/** Presentation only. Shared causal records/roles remain independently validated. */
export function findingActions(c: FindingActionContext): { primary: FindingAction[]; more: FindingAction[] } {
  const primary: FindingAction[] = [], more: FindingAction[] = [];
  const needsFix = c.queue === 'accepted-not-implemented' || c.queue === 'challenged';
  const done = c.addressed && (c.queue === 'implemented' || c.queue === 'verified');
  if (c.open && !c.locked && !done) primary.push({ action: 'reply', label: 'Reply' });
  if (c.creator) {
    if (done && c.open) primary.push({ action: 'resolve', label: 'Close discussion…' });
    if (c.open && !done) (!c.addressed ? primary : more).push({ action: 'decide', label: 'Decide' });
    if (!done) (!c.addressed ? primary : more).push(c.open ? { action: 'resolve', label: 'Close discussion…' } : { action: 'reopen', label: 'Reopen discussion' });
    if (c.canEdit || c.native) (needsFix ? primary : more).push({ action: 'reveal-source', label: needsFix ? 'Edit source' : 'Open working source' });
    if (c.addressing && c.accepted && c.native && c.queue !== 'conflict' && !done)
      (needsFix ? primary : more).push({ action: 'publish-fix', label: c.addressed ? 'Prepare replacement fix…' : 'Publish and record fix…' });
    if (c.addressing && c.accepted && c.otherRevision && c.queue !== 'conflict' && !done)
      (!c.addressed && !c.native ? primary : more).push({ action: 'record-addressed', label: c.addressed ? 'Record replacement fix…' : 'Record published fix…' });
  }
  if (c.addressed) {
    primary.push({ action: 'open-addressed', label: 'Inspect published fix' });
    if (c.creator && c.addressing && c.accepted && done) primary.push({ action: 'reopen-finding', label: 'Reopen finding…' });
    if (c.addressing && c.accepted && c.queue === 'conflict' && c.verificationConflict)
      more.push(c.locked ? { action: 'reopen-for-verification', label: 'Reopen my review to reconcile' } : { action: 'verify-addressing', label: 'Reconcile verification…' });
  }
  return { primary, more };
}
