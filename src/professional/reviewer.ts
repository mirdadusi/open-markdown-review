import { ActorRef, Event, Manifest, ProtocolError, REVIEWER_INVITATIONS, Reviewer } from './types';
import { ascii, stableId } from './bytes';

/** Deliberate case-insensitive mailbox matching for this self-asserted profile. */
export function reviewerEmail(value: string): string | undefined {
  const email = value.trim().toLowerCase(), parts = email.split('@');
  if (email.length > 254 || parts.length !== 2) return;
  const [local, domain] = parts;
  if (!local || local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return;
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return;
  return email;
}
export function parseReviewerEmails(value: string | readonly string[]): string[] {
  const values = typeof value === 'string' ? value.split(/[,;\s]+/) : value;
  const emails = values.filter(item => item.trim()).map(item => {
    const email = reviewerEmail(item);
    if (!email) throw new ProtocolError('invalid', `Enter a valid reviewer email address: ${item}`);
    return email;
  });
  const unique = [...new Set(emails)].sort(ascii);
  if (unique.length > 100) throw new ProtocolError('invalid', 'Enter at most 100 reviewer email addresses at once.');
  return unique;
}
export function reviewerRoster(emails: readonly string[]): NonNullable<Manifest['reviewers']> {
  return parseReviewerEmails(emails).map(email => ({ id: stableId('reviewer', email), email }));
}
export function invitationAllowed(manifest: Manifest, event: Event): event is Extract<Event, { type: 'reviewer.invited' }> {
  if (event.type !== 'reviewer.invited' || manifest.protocolVersion !== '0.6.0' || !manifest.reviewers || !manifest.requiredCapabilities.includes(REVIEWER_INVITATIONS)
    || event.actor.id !== manifest.createdBy.id || event.reviewId !== manifest.reviewId || event.schemaVersion !== manifest.protocolVersion || event.reviewerInvitationId) return false;
  const email = reviewerEmail(event.reviewer.email);
  return email === event.reviewer.email && event.reviewer.id === stableId('reviewer', email);
}
/** Callers pass admitted events. Graph admission additionally checks every invitation dependency. */
export function effectiveReviewers(manifest: Manifest, events: readonly Event[] = []): Array<Reviewer & { invitationId?: string }> {
  const members = new Map<string, Reviewer & { invitationId?: string }>((manifest.reviewers ?? []).map(r => [r.id, { ...r }]));
  for (const event of events) if (invitationAllowed(manifest, event)) {
    const previous = members.get(event.reviewer.id);
    if (!previous || previous.invitationId && ascii(event.id, previous.invitationId) < 0) members.set(event.reviewer.id, { ...event.reviewer, invitationId: event.id });
  }
  return [...members.values()].sort((a, b) => ascii(a.email, b.email));
}
export function permittedReviewer(manifest: Manifest, actor: ActorRef, events: readonly Event[] = []): boolean {
  return !manifest.reviewers || actor.id === manifest.createdBy.id || effectiveReviewers(manifest, events).some(item => item.id === actor.id);
}
export function reviewerForInput(manifest: Manifest | undefined, value: unknown, events: readonly Event[] = []): ActorRef | undefined {
  if (!manifest?.reviewers) return reviewerIdentity(value);
  if (!value || typeof value !== 'object') return;
  const candidate = value as { id?: unknown; displayName?: unknown };
  if (typeof candidate.id !== 'string') return;
  if (candidate.id.trim() === manifest.createdBy.id) return reviewerIdentity(value);
  const member = effectiveReviewers(manifest, events).find(item => item.email === reviewerEmail(candidate.id as string) || item.id === (candidate.id as string).trim());
  return member ? reviewerIdentity({ ...candidate, id: member.id }) : undefined;
}

/** A local UI preference, never inferred from the author of a received package. */
export function reviewerIdentity(value: unknown): ActorRef | undefined {
  if (!value || typeof value !== 'object') return;
  const candidate = value as { id?: unknown; displayName?: unknown };
  if (typeof candidate.id !== 'string' || candidate.displayName !== undefined && typeof candidate.displayName !== 'string') return;
  const id = candidate.id.trim(), displayName = candidate.displayName?.trim();
  if (!id || [...id].length > 128 || /[\x00-\x1f\x7f-\x9f]/.test(id)) return;
  return { id, ...(displayName ? { displayName } : {}) };
}
