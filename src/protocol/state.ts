import {
  CommentCreatedEvent,
  CommentRepliedEvent,
  ReviewEvent,
  ReviewSuggestion,
  ReviewState,
  ReviewThread,
  SuggestionAcceptedEvent,
  SuggestionAppliedEvent,
  SuggestionRejectedEvent,
  ThreadDecidedEvent,
  ThreadResolvedEvent,
} from "./types";

export function compareEvents(a: ReviewEvent, b: ReviewEvent): number {
  const time = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
  if (time) return time;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Deterministically folds immutable events into current state. Thread
 * resolution and decisions are monotonic assertions. Conflicts are retained.
 * Timestamps affect display ordering, never the semantic result.
 */
export function buildReviewState(input: readonly ReviewEvent[]): ReviewState {
  const seen = new Set<string>();
  const events = [...input]
    .sort(compareEvents)
    .filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    });

  const threads = new Map<string, ReviewThread>();
  const danglingEvents: ReviewEvent[] = [];
  const danglingIds = new Set<string>();
  const retainDangling = (event: ReviewEvent) => {
    if (!danglingIds.has(event.id)) danglingEvents.push(event);
    danglingIds.add(event.id);
  };
  const revisionEvents = events.filter((event) => event.type === "revision.created");
  const publishedRevisionIds = new Set(revisionEvents.map((event) => event.revisionId));

  const threadRoots = new Map<string, CommentCreatedEvent[]>();
  for (const event of events) if (event.type === "comment.created") {
    threadRoots.set(event.threadId, [...(threadRoots.get(event.threadId) ?? []), event]);
  }
  for (const [threadId, roots] of threadRoots) {
    if (roots.length !== 1 || !publishedRevisionIds.has(roots[0].revisionId)) {
      roots.forEach(retainDangling);
      continue;
    }
    threads.set(threadId, {
      id: threadId,
      revisionId: roots[0].revisionId,
      root: roots[0],
      replies: [],
      decisionConflicts: [],
    });
  }

  const suggestions = new Map<string, ReviewSuggestion>();
  const suggestionRoots = new Map<string, Array<Extract<ReviewEvent, { type: "suggestion.created" }>>>();
  for (const event of events) if (event.type === "suggestion.created") {
    suggestionRoots.set(event.suggestionId, [...(suggestionRoots.get(event.suggestionId) ?? []), event]);
  }
  for (const [suggestionId, roots] of suggestionRoots) {
    if (roots.length !== 1 || !publishedRevisionIds.has(roots[0].revisionId)) {
      roots.forEach(retainDangling);
      continue;
    }
    suggestions.set(suggestionId, {
      id: suggestionId,
      revisionId: roots[0].revisionId,
      created: roots[0],
      status: "open",
      decisionConflicts: [],
    });
  }

  for (const event of events) {
    if (event.type === "comment.replied") {
      const thread = threads.get(event.threadId);
      if (thread && thread.revisionId === event.revisionId) {
        thread.replies.push(event as CommentRepliedEvent);
      } else {
        retainDangling(event);
      }
    } else if (event.type === "thread.resolved") {
      const thread = threads.get(event.threadId);
      if (thread && thread.revisionId === event.revisionId && !thread.resolved) {
        thread.resolved = event as ThreadResolvedEvent;
      } else if (!thread || thread.revisionId !== event.revisionId) {
        retainDangling(event);
      }
    } else if (event.type === "thread.decided") {
      const thread = threads.get(event.threadId);
      if (thread && thread.revisionId === event.revisionId) {
        if (!thread.decision) thread.decision = event as ThreadDecidedEvent;
        else if (thread.decision.decision !== event.decision) thread.decisionConflicts.push(event as ThreadDecidedEvent);
      } else {
        retainDangling(event);
      }
    } else if (event.type === "suggestion.accepted" || event.type === "suggestion.rejected") {
      const suggestion = suggestions.get(event.suggestionId);
      if (!suggestion || suggestion.revisionId !== event.revisionId) {
        retainDangling(event);
        continue;
      }
      if (event.type === "suggestion.accepted") {
        if (!suggestion.accepted && !suggestion.rejected) suggestion.accepted = event as SuggestionAcceptedEvent;
        else if (suggestion.rejected) suggestion.decisionConflicts.push(event as SuggestionAcceptedEvent);
      } else if (!suggestion.accepted && !suggestion.rejected) {
        suggestion.rejected = event as SuggestionRejectedEvent;
      } else if (suggestion.accepted) {
        suggestion.decisionConflicts.push(event as SuggestionRejectedEvent);
      }
    } else if (event.type === "suggestion.applied") {
      const suggestion = suggestions.get(event.suggestionId);
      if (suggestion && suggestion.revisionId === event.revisionId && !suggestion.applied) {
        suggestion.applied = event as SuggestionAppliedEvent;
      } else if (!suggestion || suggestion.revisionId !== event.revisionId) {
        retainDangling(event);
      }
    }
  }

  for (const suggestion of suggestions.values()) {
    suggestion.status = suggestion.decisionConflicts.length || (suggestion.applied && (!suggestion.accepted || suggestion.rejected))
      ? "conflicted"
      : suggestion.applied
        ? "applied"
        : suggestion.accepted
          ? "accepted"
          : suggestion.rejected
            ? "rejected"
            : "open";
  }

  for (const event of events) {
    if ((event.type === "review.approved" || event.type === "review.rejected" || event.type === "export.created")
      && !publishedRevisionIds.has(event.revisionId)) retainDangling(event);
  }

  const latestRevisionId = revisionEvents.at(-1)?.revisionId;
  const unresolvedThreads = [...threads.values()]
    .filter((thread) => (thread.decisionConflicts.length > 0 || (!thread.resolved && !thread.decision)) && (!latestRevisionId || thread.revisionId === latestRevisionId))
    .sort((a, b) => compareEvents(a.root, b.root));
  const openSuggestions = [...suggestions.values()]
    .filter((suggestion) => (suggestion.status === "open" || suggestion.status === "conflicted") && (!latestRevisionId || suggestion.revisionId === latestRevisionId))
    .sort((a, b) => compareEvents(a.created, b.created));

  return {
    threads,
    unresolvedThreads,
    approvals: events.filter((event): event is Extract<ReviewEvent, { type: "review.approved" }> => event.type === "review.approved" && publishedRevisionIds.has(event.revisionId)),
    rejections: events.filter((event): event is Extract<ReviewEvent, { type: "review.rejected" }> => event.type === "review.rejected" && publishedRevisionIds.has(event.revisionId)),
    suggestions,
    openSuggestions,
    revisionEvents,
    latestRevisionId,
    exports: events.filter((event): event is Extract<ReviewEvent, { type: "export.created" }> => event.type === "export.created" && publishedRevisionIds.has(event.revisionId)),
    danglingEvents,
  };
}
