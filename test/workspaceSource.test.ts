import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { actor, findingFixture } from './findingPublication.fixture';
import { digest } from '../src/professional/bytes';
import { authorReview } from '../src/professional/authoring';
import { ProtocolError } from '../src/professional/types';
import { NativeStorage } from '../src/professional/nativeStorage';
import { inspectSourceBinding, inspectSourceCandidate, sourceBindingSnapshot } from '../src/professional/sourceBinding';
import { chooseSourceWorkspace, discoverWorkspaceSources, MAX_SOURCE_CANDIDATES, SourceLinkOptions, SourceLinkUi } from '../src/professional/workspaceSource';

type Fixture = Awaited<ReturnType<typeof findingFixture>>;
const workspace = (root: string, name = path.basename(root)) => ({ root, name });
function harness(f: Fixture, overrides: Partial<SourceLinkUi> = {}, roots = [workspace(f.source)]) {
  const calls: string[] = [];
  const ui: SourceLinkUi = {
    confirm: async (_snapshot, _report, candidate, single) => { calls.push(`confirm:${candidate?.kind ?? 'manual'}:${!!single}`); return 'use'; },
    pick: async (_snapshot, discovery) => { calls.push('pick'); return discovery.candidates[0]; },
    browse: async () => { calls.push('browse'); return undefined; },
    missing: async () => { calls.push('missing'); return undefined; },
    ...overrides
  };
  const options: SourceLinkOptions = { reviewRoot: f.root, expectedReviewId: f.created.reviewId, journalRoot: f.journalRoot, workspaces: () => roots, ui };
  return { calls, options };
}
async function inventory(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(file); else result[path.relative(root, file)] = digest(await readFile(file));
    }
  }
  await visit(root); return result;
}
const changed = (error: unknown) => error instanceof ProtocolError && error.code === 'changed';

test('source linking: one complete open workspace uses one explicit confirmation and writes no source, evidence or private journal', async () => {
  const f = await findingFixture(), before = await inventory(f.temp), h = harness(f);
  const result = await chooseSourceWorkspace(h.options);
  assert.equal(result?.report.sourceRoot, await realpath(f.source));
  assert.equal(result?.reviewId, f.created.reviewId);
  assert.deepEqual(result?.report.exact, ['a.md', 'b.md']);
  assert.deepEqual(h.calls, ['confirm:workspace:true']);
  assert.deepEqual(await inventory(f.temp), before);
  assert.deepEqual(await inspectSourceBinding(f.root, f.source, f.journalRoot), { sourceRoot: await realpath(f.source), documents: 2, exact: ['a.md', 'b.md'], changed: [], missing: [] }, 'Legacy manual API retains its report shape.');
});

test('source linking: changed saved bytes are a valid match, not a claim of implementation', async () => {
  const f = await findingFixture(); await writeFile(path.join(f.source, 'b.md'), '# Updated entire document\n');
  const h = harness(f), result = await chooseSourceWorkspace(h.options);
  assert.deepEqual(result?.report.exact, ['a.md']); assert.deepEqual(result?.report.changed, ['b.md']);
  assert.deepEqual(h.calls, ['confirm:workspace:true']);
  assert.equal((await readdir(path.join(f.root, 'events'))).length, 7, 'Linking appends no addressing or revision event.');
});

test('source actions: one complete workspace is reused without any picker and without shared/source writes', async () => {
  const f = await findingFixture(), before = await inventory(f.temp), h = harness(f); h.options.reuseSingleMatch = true;
  const result = await chooseSourceWorkspace(h.options);
  assert.equal(result?.automatic, true); assert.equal(result?.report.sourceRoot, await realpath(f.source));
  assert.deepEqual(h.calls, []); assert.deepEqual(await inventory(f.temp), before);
  await writeFile(path.join(f.source, 'b.md'), '# Saved changes are still a valid source\n');
  assert.deepEqual((await chooseSourceWorkspace(h.options))?.report.changed, ['b.md']); assert.deepEqual(h.calls, []);
});

test('source actions: a remembered source is never implicitly replaced by a matching open workspace', async () => {
  const f = await findingFixture(), h = harness(f, { confirm: async () => { h.calls.push('confirm'); return undefined; } });
  h.options.reuseSingleMatch = true; h.options.previousSource = path.join(f.temp, 'existing-private-binding');
  assert.equal(await chooseSourceWorkspace(h.options), undefined); assert.deepEqual(h.calls, ['confirm']);
});

test('source actions: ambiguous, missing and truncated workspace matches still require an explicit choice', async () => {
  const f = await findingFixture(), second = path.join(f.temp, 'second'); await cp(f.source, second, { recursive: true });
  let h = harness(f, {}, [workspace(f.source), workspace(second)]); h.options.reuseSingleMatch = true;
  assert.equal((await chooseSourceWorkspace(h.options))?.automatic, false); assert.deepEqual(h.calls, ['pick']);
  h = harness(f, {}, []); h.options.reuseSingleMatch = true;
  assert.equal(await chooseSourceWorkspace(h.options), undefined); assert.deepEqual(h.calls, ['browse']);
  h = harness(f, {}, [workspace(f.source), ...Array.from({ length: MAX_SOURCE_CANDIDATES }, (_, i) => workspace(path.join(f.temp, `absent-${i}`)))]); h.options.reuseSingleMatch = true;
  assert.equal((await chooseSourceWorkspace(h.options))?.automatic, false); assert.deepEqual(h.calls, ['pick']);
});

test('source actions: an unreadable competing workspace cannot make another copy appear unambiguous', async () => {
  const f = await findingFixture(), locked = path.join(f.temp, 'locked'); await cp(f.source, locked, { recursive: true });
  const lockedRoot = await realpath(locked), read = NativeStorage.prototype.read;
  NativeStorage.prototype.read = function (file, limit) { return this.root === lockedRoot ? Promise.reject(new ProtocolError('permission', 'Simulated locked shared folder.')) : read.call(this, file, limit); };
  try {
    const h = harness(f, {}, [workspace(f.source), workspace(locked)]); h.options.reuseSingleMatch = true;
    assert.equal((await chooseSourceWorkspace(h.options))?.automatic, false); assert.deepEqual(h.calls, ['confirm:workspace:false']);
  } finally { NativeStorage.prototype.read = read; }
});

test('source actions: automatic reuse still rejects changed workspace membership and cancels before returning a binding', async () => {
  const f = await findingFixture(), h = harness(f); h.options.reuseSingleMatch = true;
  h.options.progress = message => { if (message.startsWith('Using the verified')) h.options.workspaces = () => [workspace(f.source), workspace(path.join(f.temp, 'new-workspace'))]; };
  await assert.rejects(chooseSourceWorkspace(h.options), /workspace folders changed/); assert.deepEqual(h.calls, []);
  const roots = [workspace(f.source)]; h.options.workspaces = () => roots;
  h.options.progress = message => { if (message.startsWith('Using the verified')) roots.push(workspace(path.join(f.temp, 'late-workspace'))); };
  await assert.rejects(chooseSourceWorkspace(h.options), /workspace folders changed/);
  const controller = new AbortController(); h.options.progress = message => { if (message.startsWith('Using the verified')) controller.abort(); };
  h.options.workspaces = () => [workspace(f.source)]; h.options.signal = controller.signal;
  await assert.rejects(chooseSourceWorkspace(h.options), (e: unknown) => e instanceof ProtocolError && e.code === 'cancelled'); assert.deepEqual(h.calls, []);
});

test('source discovery: multiple roots, missing documents and relative-path mismatches are checked, without recursive basename guessing', async () => {
  const f = await findingFixture(), wrong = path.join(f.temp, 'wrong'), absent = path.join(f.temp, 'missing');
  await mkdir(path.join(wrong, 'nested'), { recursive: true }); await cp(f.source, path.join(wrong, 'nested'), { recursive: true });
  const snapshot = await sourceBindingSnapshot(f.root, f.journalRoot);
  const result = await discoverWorkspaceSources(snapshot, [workspace(wrong), workspace(absent), workspace('relative'), workspace(f.source)], f.journalRoot);
  assert.deepEqual(result.candidates.map(c => c.report.sourceRoot), [await realpath(f.source)]);
  assert.equal(result.issues.length, 3);
  const partial = path.join(f.temp, 'partial'); await mkdir(partial); await cp(path.join(f.source, 'a.md'), path.join(partial, 'a.md'));
  const report = await inspectSourceCandidate(snapshot, partial, f.journalRoot); assert.deepEqual(report.missing, ['b.md']);
  assert.equal((await discoverWorkspaceSources(snapshot, [workspace(partial)], f.journalRoot)).candidates.length, 0);
});

test('source discovery: active Markdown can identify a nested root only when every review-relative path matches', async () => {
  const f = await findingFixture(), repo = path.join(f.temp, 'repo'), nested = path.join(repo, 'docs');
  await mkdir(repo); await cp(f.source, nested, { recursive: true });
  const snapshot = await sourceBindingSnapshot(f.root, f.journalRoot), roots = [workspace(repo)];
  assert.equal((await discoverWorkspaceSources(snapshot, roots, f.journalRoot)).candidates.length, 0);
  assert.equal((await discoverWorkspaceSources(snapshot, roots, f.journalRoot, path.join(f.source, 'a.md'))).candidates.length, 0, 'An editor outside the workspace is not a hint.');
  const result = await discoverWorkspaceSources(snapshot, roots, f.journalRoot, path.join(nested, 'a.md'));
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].kind, 'active-document');
  assert.equal(result.candidates[0].report.sourceRoot, await realpath(nested));
  const h = harness(f, {}, roots); h.options.activeDocument = path.join(nested, 'a.md');
  assert.equal((await chooseSourceWorkspace(h.options))?.report.sourceRoot, await realpath(nested)); assert.deepEqual(h.calls, ['confirm:active-document:true']);
  await rename(path.join(nested, 'b.md'), path.join(nested, 'other.md'));
  assert.equal((await discoverWorkspaceSources(snapshot, roots, f.journalRoot, path.join(nested, 'a.md'))).candidates.length, 0);
});

test('source linking: ambiguous exact and edited workspaces require an explicit choice; neither wins silently', async () => {
  const f = await findingFixture(), second = path.join(f.temp, 'second'); await cp(f.source, second, { recursive: true });
  await writeFile(path.join(second, 'a.md'), '# Deliberately edited copy\n');
  const roots = [workspace(f.source, 'original'), workspace(second, 'edited')];
  const h = harness(f, { pick: async (_snapshot, discovery) => {
    h.calls.push('pick'); assert.equal(discovery.candidates.length, 2); return discovery.candidates[1];
  } }, roots);
  assert.equal((await chooseSourceWorkspace(h.options))?.report.sourceRoot, await realpath(second)); assert.deepEqual(h.calls, ['pick']);
  h.options.ui.pick = async () => undefined; assert.equal(await chooseSourceWorkspace(h.options), undefined);
  h.options.ui.pick = async (_s, d) => ({ ...d.candidates[0], inputRoot: path.join(f.temp, 'uninspected') });
  await assert.rejects(chooseSourceWorkspace(h.options), /checked workspace folders/);
});

test('source linking: cancellation and choosing a different folder preserve the previous binding and permit manual fallback', async () => {
  const f = await findingFixture(), h = harness(f, { confirm: async () => undefined });
  h.options.previousSource = f.source; assert.equal(await chooseSourceWorkspace(h.options), undefined);
  h.options.ui.confirm = async (_s, _r, candidate) => candidate ? 'browse' : 'use';
  h.options.ui.browse = async (_s, defaultRoot) => { assert.equal(defaultRoot, f.source); return f.source; };
  assert.equal((await chooseSourceWorkspace(h.options))?.report.sourceRoot, await realpath(f.source));
  const empty = path.join(f.temp, 'empty'); await mkdir(empty);
  const manual = harness(f, {}, []); let count = 0;
  manual.options.ui.browse = async () => ++count === 1 ? empty : f.source;
  manual.options.ui.missing = async report => { assert.deepEqual(report.missing, ['a.md', 'b.md']); return 'browse'; };
  assert.equal((await chooseSourceWorkspace(manual.options))?.report.sourceRoot, await realpath(f.source));
  assert.equal(count, 2); assert.deepEqual(manual.calls, ['confirm:manual:false']);
  const cancelled = harness(f, {}, []); assert.equal(await chooseSourceWorkspace(cancelled.options), undefined);
  cancelled.options.ui.browse = async () => empty;
  assert.equal(await chooseSourceWorkspace(cancelled.options), undefined, 'Cancel after the missing-path explanation leaves no binding.');
  const alternative = harness(f, {}, [workspace(f.source), workspace(f.source, 'duplicate')]);
  alternative.options.ui.confirm = async (_s, _r, candidate) => candidate ? 'browse' : undefined;
  alternative.options.ui.browse = async () => f.source;
  assert.equal(await chooseSourceWorkspace(alternative.options), undefined, 'The manual confirmation also supports cancellation.');
});

test('source linking: incomplete, corrupt, replaced or absent reviews cannot be bound', async () => {
  const f = await findingFixture(), h = harness(f); h.options.expectedReviewId = 'different_review';
  await assert.rejects(chooseSourceWorkspace(h.options), /different review/);
  const incomplete = path.join(f.temp, 'incomplete'); await mkdir(incomplete); await mkdir(path.join(incomplete, 'events')); await mkdir(path.join(incomplete, 'revisions'));
  await cp(path.join(f.root, 'manifest.json'), path.join(incomplete, 'manifest.json'));
  await assert.rejects(sourceBindingSnapshot(incomplete, f.journalRoot), /no verified revision/);
  await assert.rejects(sourceBindingSnapshot(path.join(f.temp, 'absent'), f.journalRoot), { code: 'ENOENT' });
  const corrupt = path.join(f.temp, 'corrupt'); await cp(f.root, corrupt, { recursive: true });
  const revision = (await readdir(path.join(corrupt, 'revisions')))[0]; await writeFile(path.join(corrupt, 'revisions', revision), '{}');
  await assert.rejects(sourceBindingSnapshot(corrupt, f.journalRoot), /fully verified/);
});

test('source linking: frozen review evidence can never be selected as editable source, including from a containing folder', async () => {
  const f = await findingFixture(), snapshot = await sourceBindingSnapshot(f.root, f.journalRoot);
  await assert.rejects(inspectSourceCandidate(snapshot, f.root, f.journalRoot), /frozen evidence/);
  await assert.rejects(inspectSourceCandidate(snapshot, path.join(f.root, 'blobs'), f.journalRoot), /frozen evidence/);
  await assert.rejects(inspectSourceCandidate({ ...snapshot, documents: [{ path: 'review/a.md', digests: [] }] }, f.temp, f.journalRoot), /frozen review package/);
  await assert.rejects(inspectSourceCandidate(snapshot, '.', f.journalRoot), /absolute native path/);
});

test('source linking: source edits, changed workspace membership and revision publication during confirmation are rejected', async () => {
  const f = await findingFixture();
  let h = harness(f, { confirm: async () => { await writeFile(path.join(f.source, 'b.md'), '# Changed during confirmation\n'); return 'use'; } });
  await assert.rejects(chooseSourceWorkspace(h.options), changed);
  h = harness(f, { confirm: async () => { h.options.workspaces = () => []; return 'use'; } });
  await assert.rejects(chooseSourceWorkspace(h.options), /closed or replaced/);
  h = harness(f, { confirm: async () => {
    await authorReview({ source: f.source, store: f.root, actor, rootDocument: 'a.md', operationId: 'new_head_during_confirmation', parents: [f.origin], preserveClient: true, clientArtifact: '', journalRoot: f.journalRoot }); return 'use';
  } });
  await assert.rejects(chooseSourceWorkspace(h.options), /revision heads changed/);
});

test('source linking: unrelated peer comments arriving during confirmation do not invalidate source matching', async () => {
  const f = await findingFixture(), h = harness(f, { confirm: async () => {
    const ctx = f.session.context(actor), original = f.session.events.find(e => e.type === 'comment.created')!;
    assert.equal(original.type, 'comment.created');
    await f.session.save(ctx, f.session.makeEvent(ctx, { type: 'comment.created', threadId: 'peer_thread', commentId: 'peer_comment', anchor: original.anchor, body: { format: 'markdown', text: 'Another concurrent concern.' } })); return 'use';
  } });
  assert.equal((await chooseSourceWorkspace(h.options))?.report.sourceRoot, await realpath(f.source));
});

test('source linking: replacing a source or review root with a byte-identical copy during confirmation requires a retry', async () => {
  const f = await findingFixture();
  let h = harness(f, { confirm: async () => {
    const old = path.join(f.temp, 'previous-source'); await rename(f.source, old); await cp(old, f.source, { recursive: true }); return 'use';
  } });
  await assert.rejects(chooseSourceWorkspace(h.options), changed);
  h = harness(f, { confirm: async () => {
    const old = path.join(f.temp, 'previous-review'); await rename(f.root, old); await cp(old, f.root, { recursive: true }); return 'use';
  } });
  await assert.rejects(chooseSourceWorkspace(h.options), changed);
});

test('source linking: cancellation before and during discovery or confirmation never returns a binding', async () => {
  const f = await findingFixture(), controller = new AbortController(), h = harness(f); h.options.signal = controller.signal;
  controller.abort(); await assert.rejects(chooseSourceWorkspace(h.options), (e: unknown) => e instanceof ProtocolError && e.code === 'cancelled');
  const during = new AbortController(); h.options.signal = during.signal;
  h.options.progress = message => { if (message.startsWith('Checking source folder:')) during.abort(); };
  await assert.rejects(chooseSourceWorkspace(h.options), (e: unknown) => e instanceof ProtocolError && e.code === 'cancelled');
  const confirming = new AbortController(); h.options.signal = confirming.signal; h.options.progress = undefined;
  h.options.ui.confirm = async () => { confirming.abort(); return 'use'; };
  await assert.rejects(chooseSourceWorkspace(h.options), (e: unknown) => e instanceof ProtocolError && e.code === 'cancelled');
});

test('source discovery: every current branch-head path is required; shared paths may match either verified branch', async () => {
  const f = await findingFixture();
  await writeFile(path.join(f.source, 'left.md'), '# Left branch\n');
  await authorReview({ source: f.source, store: f.root, rootDocument: 'a.md', actor, parents: [f.origin], include: ['a.md', 'left.md'], operationId: 'left_branch', preserveClient: true, clientArtifact: '', journalRoot: f.journalRoot });
  await writeFile(path.join(f.source, 'right.md'), '# Right branch\n'); await writeFile(path.join(f.source, 'a.md'), '# Alternate branch contents\n');
  await authorReview({ source: f.source, store: f.root, rootDocument: 'a.md', actor, parents: [f.origin], include: ['a.md', 'right.md'], operationId: 'right_branch', preserveClient: true, clientArtifact: '', journalRoot: f.journalRoot });
  const snapshot = await sourceBindingSnapshot(f.root, f.journalRoot);
  assert.deepEqual(snapshot.documents.map(d => d.path), ['a.md', 'left.md', 'right.md']);
  assert.equal(snapshot.documents[0].digests.length, 2);
  assert.deepEqual((await inspectSourceCandidate(snapshot, f.source, f.journalRoot)).exact, ['a.md', 'left.md', 'right.md']);
});

test('source discovery: bounded candidate scans stay explicit when truncated', async () => {
  const f = await findingFixture(), roots = [workspace(f.source), ...Array.from({ length: MAX_SOURCE_CANDIDATES }, (_, i) => workspace(path.join(f.temp, `missing-${i}`)))];
  const h = harness(f, { pick: async (_s, discovery) => { h.calls.push('pick'); assert.equal(discovery.truncated, true); return discovery.candidates[0]; } }, roots);
  assert.ok(await chooseSourceWorkspace(h.options)); assert.deepEqual(h.calls, ['pick']);
});

test('source discovery: canonical root aliases deduplicate, but nested symlinks/junctions and nonregular source files are refused', async t => {
  const f = await findingFixture(), alias = path.join(f.temp, 'alias');
  try { await symlink(f.source, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('This Windows account cannot create test junctions.'); return; } throw error; }
  const snapshot = await sourceBindingSnapshot(f.root, f.journalRoot);
  const originalRead = NativeStorage.prototype.read, reads: string[] = [];
  NativeStorage.prototype.read = function (file, limit) { reads.push(`${this.root}/${file}`); return originalRead.call(this, file, limit); };
  try {
    assert.equal((await discoverWorkspaceSources(snapshot, [workspace(f.source), workspace(alias)], f.journalRoot)).candidates.length, 1);
    assert.equal(reads.length, 2, 'Each source document is read once across aliases; discovery does not rescan review history per root.');
  } finally { NativeStorage.prototype.read = originalRead; }
  const container = path.join(f.temp, 'container'); await mkdir(container); await symlink(f.source, path.join(container, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await discoverWorkspaceSources(snapshot, [workspace(container)], f.journalRoot, path.join(container, 'linked', 'a.md'))).candidates.length, 0);
  await assert.rejects(inspectSourceCandidate({ ...snapshot, documents: [{ path: 'linked/a.md', digests: [] }] }, container, f.journalRoot), /links\/junctions/);
  const nonregular = path.join(f.temp, 'nonregular'); await mkdir(path.join(nonregular, 'a.md'), { recursive: true });
  await assert.rejects(inspectSourceCandidate(snapshot, nonregular, f.journalRoot), (e: unknown) => e instanceof ProtocolError && ['unsupported', 'uncertain'].includes(e.code));
});
