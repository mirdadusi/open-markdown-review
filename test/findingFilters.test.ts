import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesFindingFilters } from '../src/professional/findingFilters';
import type { Event } from '../src/professional/types';

test('decision and discussion filters are independent, including closed undecided findings and conflicts', () => {
  const finding = (open: boolean, decisions: string[], conflict = false) => ({ open, decision: { conflict, heads: decisions.map(decision => ({ type: 'thread.decided', decision }) as Event) } });
  assert.equal(matchesFindingFilters(finding(false, []), 'closed', 'undecided'), true);
  assert.equal(matchesFindingFilters(finding(false, []), 'open', 'undecided'), false);
  assert.equal(matchesFindingFilters(finding(true, ['accepted']), 'open', 'undecided'), false);
  assert.equal(matchesFindingFilters(finding(true, ['accepted']), 'open', 'accepted'), true);
  for (const decision of ['accepted', 'rejected', 'deferred', 'duplicate']) assert.equal(matchesFindingFilters(finding(false, [decision]), 'closed', decision), true);
  const conflict = finding(true, ['accepted', 'rejected'], true);
  assert.equal(matchesFindingFilters(conflict, 'all', 'accepted'), false);
  assert.equal(matchesFindingFilters(conflict, 'all', 'undecided'), false);
  assert.equal(matchesFindingFilters(conflict, 'all', 'conflict'), true);
  const edit = { open: false, decision: { conflict: false, heads: [{ type: 'suggestion.accepted' } as Event] } };
  assert.equal(matchesFindingFilters(edit, 'closed', 'accepted'), true);
  assert.equal(matchesFindingFilters(edit, 'closed', 'rejected'), false);
});
