import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import { markdownDocumentLinks, findingScopeChoice, findingScopeProblems, FindingScopePlan } from '../src/professional/findingScope';
import { actor, findingFixture } from './findingPublication.fixture';
import { FindingPublisher } from '../src/professional/findingPublication';
import { decode } from '../src/professional/bytes';
import { fold } from '../src/professional/state';
import { NativeStorage } from '../src/professional/nativeStorage';

test('local Markdown graph parsing is portable, supports reference/HTML links and ignores executable/external/attachment content', () => {
  const links = markdownDocumentLinks('[Details][d]\n\n[d]: ../details/space%20name.md#topic\n\n<a href="../more.md">More</a>\n\n[Remote](https://example.com/a.md) [Network](file://host/a.md) [Attachment](../attachment.md "review:attach")\n\n```md\n[Not navigation](../ignored.md)\n```\n\n[Escape](../../private.md) [Absolute](/absolute.md)', 'sections/a.md');
  assert.deepEqual(links.filter(link => link.target).map(link => link.target), ['details/space name.md', 'more.md']);
  assert.equal(links.filter(link => link.problem).length, 2);
  assert.deepEqual(markdownDocumentLinks('<a href="b.md">B</a>', 'a.md', false), []);
  assert.match(markdownDocumentLinks('[Ambiguous](details//new.md)', 'a.md')[0].problem!, /Normalize/);
  assert.throws(() => findingScopeChoice({ planDigest: 'bad', documents: ['a.md'], parents: ['r'] }), /valid document scope/);
});

test('guided capture requires explicit new/transitive scope and freezes new Markdown/resources with original finding evidence', async () => {
  const f = await findingFixture(), manifest = await readFile(path.join(f.root, 'manifest.json'));
  const oldEvents = new Map(await Promise.all((await readdir(path.join(f.root, 'events'))).map(async file => [file, await readFile(path.join(f.root, 'events', file))] as const)));
  await mkdir(path.join(f.source, 'details'));
  await writeFile(path.join(f.source, 'a.md'), '# Design\n\nOriginal concern.\n\n[Implementation detail](details/new.md)\n');
  await writeFile(path.join(f.source, 'details/new.md'), '# New detail\n\n[More](more.md)\n\n![Picture](picture.svg)\n');
  await writeFile(path.join(f.source, 'details/more.md'), '# More\n\n[Back](new.md)\n');
  await writeFile(path.join(f.source, 'details/picture.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>');
  await writeFile(path.join(f.source, 'unrelated-private.md'), '# Not linked; do not capture\n');
  const planned = await f.publisher.prepareGuided(f.origin, actor); assert.ok('kind' in planned); const plan = planned as FindingScopePlan;
  assert.deepEqual(plan.documents.filter(doc => !doc.inReview).map(doc => doc.path), ['details/more.md', 'details/new.md']);
  assert.ok(findingScopeProblems(plan, ['a.md', 'b.md']).length);
  assert.equal((await readdir(path.join(f.root, 'revisions'))).length, 1);
  await assert.rejects(f.publisher.prepare(f.origin, actor), /complete Markdown scope/);
  const choice = findingScopeChoice({ planDigest: plan.digest, parents: plan.parents, documents: plan.documents.map(doc => doc.path) });
  const prepared = await f.publisher.prepareGuided(f.origin, actor, plan.parents, undefined, undefined, choice); assert.ok(!('kind' in prepared));
  assert.equal(prepared.documents.filter(doc => doc.change === 'added').length, 2); assert.equal(prepared.scopeConfirmed, true);
  const result = await f.publisher.finish(prepared.operationId, actor, [{ threadId: 'finding_0' }]); await f.session.refresh();
  const revision = f.session.revisions.get(result.revisionId)!;
  assert.equal(revision.documents.length, 4); assert.equal(revision.resources.length, 1); assert.ok(!revision.documents.some(doc => /private/.test(doc.path)));
  const fixed = fold(f.session.events, f.origin).threads[0]; assert.equal(fixed.addressed!.toRevisionId, revision.id); assert.equal(fixed.root.anchor.quote.exact, 'Original concern.');
  assert.deepEqual(await readFile(path.join(f.root, 'manifest.json')), manifest);
  for (const [file, bytes] of oldEvents) assert.deepEqual(await readFile(path.join(f.root, 'events', file)), bytes);
});

test('missing files are never silently removed; explicit removal preserves old discussions and never marks them implemented', async () => {
  const f = await findingFixture(); await rename(path.join(f.source, 'b.md'), path.join(f.source, 'b-retained.txt'));
  const plan = await f.publisher.prepareGuided(f.origin, actor); assert.ok('kind' in plan);
  assert.ok(findingScopeProblems(plan, ['a.md', 'b.md']).some(problem => /missing/.test(problem)));
  const prepared = await f.publisher.prepareGuided(f.origin, actor, plan.parents, undefined, undefined, { planDigest: plan.digest, parents: plan.parents, documents: ['a.md'] }); assert.ok(!('kind' in prepared));
  assert.equal(prepared.documents.find(doc => doc.path === 'b.md')!.change, 'removed'); assert.equal(prepared.removedFindingCount, 1);
  assert.ok(!prepared.findings.some(finding => finding.threadId === 'finding_1'));
  await f.publisher.finish(prepared.operationId, actor, []); await f.session.refresh();
  assert.equal(fold(f.session.events, f.origin).threads.length, 2); assert.equal(fold(f.session.events, f.origin).threads[1].addressed, undefined);
  assert.ok(f.session.revisions.get(f.origin)!.documents.some(doc => doc.path === 'b.md'));
});

test('stale scope, unsafe links, changed source, forged choices and linked files fail before shared publication', async () => {
  const f = await findingFixture(); await writeFile(path.join(f.source, 'a.md'), '# Design\n\nOriginal concern.\n\n[New](new.md)\n'); await writeFile(path.join(f.source, 'new.md'), '# New\n');
  const plan = await f.publisher.prepareGuided(f.origin, actor); assert.ok('kind' in plan);
  const choice = { planDigest: plan.digest, parents: plan.parents, documents: ['a.md', 'b.md', 'new.md'] };
  await assert.rejects(f.publisher.prepareGuided(f.origin, { id: 'not-the-creator' }), /initiator/);
  await writeFile(path.join(f.source, 'new.md'), '# Changed while selecting scope\n');
  await assert.rejects(f.publisher.prepareGuided(f.origin, actor, plan.parents, undefined, undefined, choice), /changed after scope selection/);
  await writeFile(path.join(f.source, 'a.md'), '# Design\n\n[Outside](../outside.md)\n');
  const unsafe = await f.publisher.prepareGuided(f.origin, actor); assert.ok('kind' in unsafe); assert.ok(findingScopeProblems(unsafe, ['a.md', 'b.md']).some(problem => /escapes/.test(problem)));
  await writeFile(path.join(f.source, 'a.md'), '# Design\n\n[Linked](linked/new.md)\n'); await symlink(f.source, path.join(f.source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.publisher.prepareGuided(f.origin, actor), /Symbolic links|junctions/);
  assert.equal((await readdir(path.join(f.root, 'revisions'))).length, 1);
});

test('partially recorded expanded scope retries exact bytes without capturing later files', async () => {
  const f = await findingFixture(); await writeFile(path.join(f.source, 'a.md'), '# Design\n\nOriginal concern.\n\n[New](new.md)\n'); await writeFile(path.join(f.source, 'new.md'), '# New\n');
  const plan = await f.publisher.prepareGuided(f.origin, actor); assert.ok('kind' in plan);
  const prepared = await f.publisher.prepareGuided(f.origin, actor, plan.parents, undefined, undefined, { planDigest: plan.digest, parents: plan.parents, documents: ['a.md', 'b.md', 'new.md'] }); assert.ok(!('kind' in prepared));
  const original = NativeStorage.prototype.write;
  NativeStorage.prototype.write = async function(file, bytes, recover) { if (this.identity === f.store.identity && file.startsWith('events/') && JSON.parse(decode(bytes)).type === 'thread.addressed') throw new Error('Simulated disconnect.'); return original.call(this, file, bytes, recover); };
  try { assert.equal((await f.publisher.finish(prepared.operationId, actor, [{ threadId: 'finding_0' }])).records[0].saved, false); }
  finally { NativeStorage.prototype.write = original; }
  await writeFile(path.join(f.source, 'new.md'), '# Later private change\n');
  const resumed = new FindingPublisher(f.options), pending = await resumed.prepareGuided(f.origin, actor); assert.ok(!('kind' in pending)); assert.ok(pending.pending);
  await resumed.finish(prepared.operationId, actor, [{ threadId: 'finding_0' }]); await f.session.refresh();
  assert.equal(f.session.revisions.size, 2); const frozen = f.session.revisions.get(prepared.revisionId)!.documents.find(doc => doc.path === 'new.md')!; assert.equal(decode(await f.session.content(frozen)), '# New\n');
});
