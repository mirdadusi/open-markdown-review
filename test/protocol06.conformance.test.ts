import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest, jsonBytes, parseJson } from '../src/professional/bytes';
import { NativeStorage } from '../src/professional/nativeStorage';
import { ReviewSession } from '../src/professional/session';
import { Event, LIMITS, ProtocolError } from '../src/professional/types';
import { fold, threadWorkflowQueue } from '../src/professional/state';

const fixture = path.resolve('protocol/fixtures/v0.6/conformant-core');
const journal = () => path.join(os.tmpdir(), `omr-v06-conformance-journal-${crypto.randomUUID()}`);

async function eventRecords(root = fixture): Promise<Array<{ file: string; event: Event }>> {
  const result = [];
  for (const file of await readdir(path.join(root, 'events'))) {
    const bytes = await readFile(path.join(root, 'events', file));
    assert.equal(file, `${digest(bytes).slice(7)}.json`, `Fixture event filename must bind exact bytes: ${file}`);
    result.push({ file, event: parseJson<Event>(bytes, LIMITS.event) });
  }
  return result;
}

/** A deliberately small oracle that does not call the production fold. */
function independentSummary(events: readonly Event[], revisionId: string) {
  const selected = events.filter(event => event.revisionId === revisionId);
  const root = selected.find((event): event is Extract<Event, { type: 'comment.created' }> => event.type === 'comment.created')!;
  const leaves = <T extends Event>(items: T[], predecessors: (item: T) => string[]) => {
    const superseded = new Set(items.flatMap(predecessors)); return items.filter(item => !superseded.has(item.id));
  };
  const statuses = selected.filter((event): event is Extract<Event, { type: 'thread.resolved' | 'thread.reopened' }> => (event.type === 'thread.resolved' || event.type === 'thread.reopened') && event.threadId === root.threadId);
  const decisions = selected.filter((event): event is Extract<Event, { type: 'thread.decided' }> => event.type === 'thread.decided' && event.threadId === root.threadId);
  const addressing = selected.filter((event): event is Extract<Event, { type: 'thread.addressed' }> => event.type === 'thread.addressed' && event.threadId === root.threadId);
  const addressed = leaves(addressing, item => item.addressingPredecessors)[0];
  const verification = selected.filter((event): event is Extract<Event, { type: 'thread.verification.recorded' }> => event.type === 'thread.verification.recorded' && event.addressedEventId === addressed?.id);
  const suggestion = selected.find((event): event is Extract<Event, { type: 'suggestion.created' }> => event.type === 'suggestion.created')!;
  return {
    open: leaves(statuses, item => item.statusPredecessors).some(item => item.type === 'thread.reopened') || leaves(statuses, item => item.statusPredecessors).length === 0,
    decision: leaves(decisions, item => item.decisionPredecessors).map(item => item.decision),
    addressedRevision: addressed?.toRevisionId,
    verification: leaves(verification, item => item.verificationPredecessors).map(item => item.verdict),
    suggestionApplied: selected.some(event => event.type === 'suggestion.applied' && event.suggestionId === suggestion.suggestionId),
    stances: selected.filter(event => event.type.startsWith('review.')).map(event => `${event.actor.id}:${event.type}`).sort()
  };
}

test('checked-in 0.6 core fixture passes exact-byte audit and an independent state oracle', async () => {
  const storage = new NativeStorage(fixture, journal()), session = new ReviewSession(storage); await session.open();
  assert.deepEqual(session.diagnostics, []); assert.equal(session.manifest.protocolVersion, '0.6.0'); assert.equal(session.revisions.size, 2); assert.equal(session.events.length, 14);
  await session.pin('revision_fixture_initial');
  const events = (await eventRecords()).map(record => record.event), independent = independentSummary(events, 'revision_fixture_initial');
  assert.deepEqual(independent, {
    open: false, decision: ['accepted'], addressedRevision: 'revision_fixture_addressed', verification: ['verified'], suggestionApplied: true,
    stances: ['fixture-auditor:review.rejected', 'fixture-auditor:review.withdrawn', 'fixture-reviewer:review.approved']
  });
  const shared = fold(session.events, 'revision_fixture_initial');
  assert.equal(shared.threads.length, 1); assert.equal(shared.threads[0].open, independent.open); assert.equal(threadWorkflowQueue(shared.threads[0]), 'verified');
  assert.equal(shared.suggestions[0].status, 'applied'); assert.equal(shared.stances.length, 2);
  const audit = await session.audit(session.context({ id: 'fixture-reviewer', displayName: 'Fixture Reviewer' }));
  assert.equal(audit.revision.externalReferences.length, 3); assert.equal(audit.revision.mermaidDiagrams.length, 1); assert.equal(audit.revision.resources.length, 1);
  assert.ok(audit.inventory.events.every(item => item.path === `events/${item.digest.slice(7)}.json`));
});

type Mutation = { pointer: string; operation: 'replace' | 'remove'; value?: unknown };
type InvalidCase = { id: string; target?: string; eventId?: string; pointer?: string; operation?: 'replace' | 'remove'; value?: unknown; mutations?: Mutation[]; expectedCode: string };
function mutate(value: unknown, change: Mutation): void {
  const segments = change.pointer.split('/').slice(1).map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  let parent = value as Record<string, unknown> | unknown[];
  for (const segment of segments.slice(0, -1)) parent = (parent as Record<string, unknown>)[segment] as Record<string, unknown>;
  const key = segments.at(-1)!;
  if (change.operation === 'remove') Array.isArray(parent) ? parent.splice(Number(key), 1) : delete (parent as Record<string, unknown>)[key];
  else (parent as Record<string, unknown>)[key] = change.value;
}

test('checked-in 0.6 invalid corpus fails closed without repairing received bytes', async t => {
  const cases = JSON.parse(await readFile('protocol/fixtures/v0.6/invalid-cases.json', 'utf8')) as InvalidCase[];
  for (const item of cases) await t.test(item.id, async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'omr-v06-invalid-')), root = path.join(temporary, 'review'); await cp(fixture, root, { recursive: true });
    let target = item.target;
    if (item.eventId) target = `events/${(await eventRecords(root)).find(record => record.event.id === item.eventId)!.file}`;
    assert.ok(target);
    const original = path.join(root, target!), object = parseJson<Record<string, unknown>>(await readFile(original), LIMITS.revision);
    for (const change of item.mutations ?? [{ pointer: item.pointer!, operation: item.operation!, value: item.value }]) mutate(object, change);
    const bytes = jsonBytes(object);
    if (item.eventId) { const replacement = path.join(root, 'events', `${digest(bytes).slice(7)}.json`); await writeFile(replacement, bytes); await unlink(original); target = path.relative(root, replacement); }
    else await writeFile(original, bytes);
    const storage = new NativeStorage(root, path.join(temporary, 'journal')), session = new ReviewSession(storage);
    let thrown: unknown;
    try { await session.open(); } catch (error) { thrown = error; }
    const codes = new Set(session.diagnostics.map(diagnostic => diagnostic.code === 'event.graph' ? 'invalid' : diagnostic.code));
    if (thrown instanceof ProtocolError) codes.add(thrown.code);
    assert.ok(codes.has(item.expectedCode), `${item.id}: expected ${item.expectedCode}; received ${[...codes].join(', ') || String(thrown)}`);
    if (item.eventId) assert.equal(session.events.some(event => event.id === item.eventId), false, 'A mutated event must not enter current state.');
    const retained = await readFile(path.join(root, target!));
    assert.equal(retained.length, bytes.length, 'The reader must not resize invalid received evidence.');
    assert.equal(digest(retained), digest(bytes), 'The reader must not repair or rewrite invalid received evidence.');
  });
});
