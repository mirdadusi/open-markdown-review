import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, symlink, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canUseWorkspaceTrash, inspectReviewRemoval, removeReview, RemovalActions, ReviewActivity } from '../src/reviewRemoval';

test('remote extension hosts never claim recoverable workspace trash', () => {
  assert.equal(canUseWorkspaceTrash(undefined), true);
  assert.equal(canUseWorkspaceTrash('wsl'), false);
  assert.equal(canUseWorkspaceTrash('ssh-remote'), false);
});

async function fixture(legacy = false) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omr-removal-')), root = path.join(temporary, 'custom-review');
  const manifest = JSON.parse(await readFile(path.resolve('examples/professional/review/manifest.json'), 'utf8'));
  if (legacy) { manifest.protocolVersion = '0.4.0'; manifest.capabilities = ['quote-anchor-v1', 'range-anchor-v1', 'content-addressed-resources-v1']; }
  await mkdir(path.join(root, 'events'), { recursive: true });
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(root, 'events', 'event.json'), '{}');
  const source = path.join(temporary, 'source'); await mkdir(source); await writeFile(path.join(source, 'a.md'), '# Keep me\n');
  return { temporary, root, source, target: { root, title: manifest.title, reviewId: manifest.reviewId, protectedPaths: [source] } };
}
function actions(overrides: Partial<RemovalActions> = {}) {
  const calls: string[] = [];
  return { calls, callbacks: { confirm: async () => { calls.push('confirm'); return true; }, close: () => { calls.push('close'); }, trash: async () => { calls.push('trash'); }, forget: async () => { calls.push('forget'); }, ...overrides } satisfies RemovalActions };
}
test('removal inspects modern and legacy custom-named packages without touching evidence', async () => {
  for (const legacy of [false, true]) {
    const f = await fixture(legacy), before = await readFile(path.join(f.root, 'manifest.json'));
    const plan = await inspectReviewRemoval(f.target);
    assert.equal(plan.files, 2); assert.equal(plan.directories, 2); assert.equal(plan.reviewId, f.target.reviewId);
    assert.equal(plan.fingerprint, (await inspectReviewRemoval(f.target)).fingerprint);
    assert.deepEqual(await readFile(path.join(f.root, 'manifest.json')), before);
  }
});
test('cancelled deletion closes nothing and writes nothing', async () => {
  const f = await fixture(), a = actions({ confirm: async () => false });
  assert.equal(await removeReview(f.target, 'trash', a.callbacks), false); assert.deepEqual(a.calls, []);
  assert.equal((await readdir(f.root)).length, 2);
});
test('local removal works for missing/unavailable folders without reading or deleting them', async () => {
  const f = await fixture(), a = actions();
  assert.equal(await removeReview({ ...f.target, root: path.join(f.temporary, 'unavailable') }, 'forget', a.callbacks), true);
  assert.deepEqual(a.calls, ['confirm', 'close', 'forget']);
});
test('validated trash target is only the exact package; source and history are recoverable', async () => {
  const f = await fixture(), destination = path.join(f.temporary, 'simulated-trash');
  const a = actions({ trash: async root => { assert.equal(root, (await inspectReviewRemoval(f.target)).root); await rename(root, destination); } });
  assert.equal(await removeReview(f.target, 'trash', a.callbacks), true);
  assert.deepEqual(a.calls, ['confirm', 'close', 'forget']);
  assert.equal(await readFile(path.join(f.source, 'a.md'), 'utf8'), '# Keep me\n');
  assert.equal(await readFile(path.join(destination, 'events/event.json'), 'utf8'), '{}');
});
test('trash error is surfaced once, without permanent fallback or forgetting the review', async () => {
  const f = await fixture(); let attempts = 0;
  const a = actions({ trash: async () => { attempts++; throw new Error('Share does not support trash'); } });
  await assert.rejects(removeReview(f.target, 'trash', a.callbacks), /No permanent-delete fallback/);
  assert.equal(attempts, 1); assert.deepEqual(a.calls, ['confirm', 'close']);
  assert.ok(await readFile(path.join(f.root, 'manifest.json')));
});
test('new or changed files during confirmation prevent deletion before closing tabs', async () => {
  for (const changed of ['events/new.json', 'events/event.json']) {
    const f = await fixture(), a = actions({ confirm: async () => { await writeFile(path.join(f.root, changed), 'changed'); return true; } });
    await assert.rejects(removeReview(f.target, 'trash', a.callbacks), /changed during confirmation/); assert.deepEqual(a.calls, []);
  }
});
test('successful trash followed by a preferences failure reports the actual recoverable outcome', async () => {
  const f = await fixture(), a = actions({ forget: async () => { throw new Error('Preferences unavailable'); } });
  await assert.rejects(removeReview(f.target, 'trash', a.callbacks), /was moved to Trash\/Recycle Bin, but its local list entry/);
  assert.deepEqual(a.calls, ['confirm', 'close', 'trash']);
});
test('source/workspace roots, parent of a source and filesystem root cannot be deleted', async () => {
  const f = await fixture();
  await assert.rejects(inspectReviewRemoval({ ...f.target, protectedPaths: [f.root] }), /Cannot delete/);
  await assert.rejects(inspectReviewRemoval({ ...f.target, protectedPaths: [path.join(f.root, 'events')] }), /Cannot delete/);
  await assert.rejects(inspectReviewRemoval({ ...f.target, root: path.parse(f.root).root }), /Cannot delete/);
  await assert.rejects(inspectReviewRemoval({ ...f.target, root: 'relative-review' }), /absolute/);
});
test('unknown source files, git metadata, temporary writes, invalid and replaced manifests are refused', async () => {
  for (const name of ['source.md', '.git', 'events/.tmp-pending']) {
    const f = await fixture(); await writeFile(path.join(f.root, name), 'must preserve');
    await assert.rejects(inspectReviewRemoval(f.target), /unexpected entry|metadata|unfinished write/);
  }
  const f = await fixture();
  await assert.rejects(inspectReviewRemoval({ ...f.target, reviewId: 'different' }), /different review/);
  await writeFile(path.join(f.root, 'manifest.json'), '{}');
  await assert.rejects(inspectReviewRemoval(f.target), /Invalid or unsupported/);
});
test('symbolic links and Windows junctions are not followed, at root or inside package', async () => {
  const f = await fixture(), link = path.join(f.temporary, 'linked-review');
  await symlink(f.root, link, 'junction');
  await assert.rejects(inspectReviewRemoval({ ...f.target, root: link }), /link or junction/);
  await symlink(f.source, path.join(f.root, 'events/linked-source'), 'junction');
  await assert.rejects(inspectReviewRemoval(f.target), /Unsafe linked/);
});
test('local in-flight writes block removal, removal blocks new writes, errors release the gate', async () => {
  const activity = new ReviewActivity(); let done!: () => void;
  const pending = activity.run(() => new Promise<void>(resolve => { done = resolve; }));
  await assert.rejects(activity.exclusive(async () => {}), /still in progress/);
  done(); await pending;
  await activity.exclusive(async () => {
    await assert.rejects(activity.run(async () => {}), /removal is in progress/);
    await assert.rejects(activity.exclusive(async () => {}), /still in progress/);
  });
  await assert.rejects(activity.exclusive(async () => { throw new Error('cancel'); }), /cancel/);
  assert.equal(await activity.run(async () => 'ready'), 'ready');
});
