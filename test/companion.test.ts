import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFile, readdir, writeFile, rename, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { startCompanion } from '../src/professional/companion';
import { companionArguments } from '../src/professional/companionCli';
import { digest, jsonBytes } from '../src/professional/bytes';
import { companionFixture } from './companion.fixture';
import { NativeStorage } from '../src/professional/nativeStorage';
import { reviewerRoster } from '../src/professional/reviewer';
import { authorReview } from '../src/professional/authoring';

test('companion binds only loopback, requires a per-launch capability and same-origin POST, and never serves arbitrary paths', async () => {
  const f = await companionFixture();
  try {
    const before = await readdir(path.join(f.root, 'events'));
    const page = await fetch(f.helper.origin);
    assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    const html = await page.text(); assert.match(html, /open-markdown-review-companion/); assert.match(html, /connect-src 'self'/); assert.ok(!html.includes(f.token));
    const invalidHeaders: Array<Record<string, string>> = [{}, { Origin: f.helper.origin }, { Origin: 'https://attacker.invalid', 'X-OMR-Session': f.token }, { Origin: 'null', 'X-OMR-Session': f.token }, { Origin: f.helper.origin, 'X-OMR-Session': 'é'.repeat(64) }, { Origin: f.helper.origin, 'X-OMR-Session': f.token, Host: 'attacker.invalid' }];
    for (const changes of invalidHeaders) {
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = request(f.helper.origin + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', ...changes } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode!)); });
        outgoing.once('error', reject); outgoing.end('{"method":"info","args":[]}');
      });
      assert.equal(status, 403, `Rejected header combination ${Object.keys(changes).join(',')}`);
    }
    assert.equal((await fetch(f.helper.origin + '/api/rpc', { method: 'OPTIONS', headers: { Origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal((await fetch(f.helper.origin, { headers: { 'Sec-Fetch-Dest': 'iframe' } })).status, 403);
    assert.equal((await fetch(f.helper.origin + '/manifest.json')).status, 404);
    assert.equal((await fetch(f.helper.origin + '/api/rpc')).status, 403);
    const info = await f.rpc('info'); assert.equal(info.ok, true); assert.equal(info.value.binaryEncoding, 'base64'); assert.equal(info.value.reviewer, undefined);
    for (const relative of ['../manifest.json', '/etc/passwd', 'C:\\Windows\\win.ini', 'StartReview.exe', 'client-backups/anything.html']) assert.equal((await f.rpc('read', [relative, 1024])).ok, false);
    assert.equal((await f.rpc('list', ['.'])).ok, false);
    assert.equal((await f.rpc('write', ['manifest.json', Buffer.from('{}').toString('base64'), false])).ok, false);
    assert.equal((await f.rpc('read', ['manifest.json', 999999999])).ok, false);
    const evidence = await f.rpc('read', ['manifest.json', 1048576]); assert.deepEqual(Buffer.from(evidence.value, 'base64'), await readFile(path.join(f.root, 'manifest.json')));
    assert.deepEqual(await readdir(path.join(f.root, 'events')), before, 'Opening/denied requests never mutate review evidence.');
    const oversized = await new Promise<number>(resolve => {
      const outgoing = request(f.helper.origin + '/api/rpc', { method: 'POST', headers: { Origin: f.helper.origin, 'X-OMR-Session': f.token, 'Content-Type': 'application/json', 'Content-Length': '999999999' } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode!)); });
      outgoing.end();
    });
    assert.equal(oversized, 413);
  } finally { await f.helper.close(); }
});

test('companion validates anchored actions and creator-only decisions on the server, preserves exact events and retries idempotently', async () => {
  const f = await companionFixture();
  try {
    const manifest = await readFile(path.join(f.root, 'manifest.json')), alex = f.session.context({ id: 'alex@example.com', displayName: 'Alex' });
    const comment = f.session.makeEvent(alex, { type: 'comment.created', threadId: 'thread_companion', commentId: 'comment_companion', anchor: f.anchor, body: { format: 'markdown', text: 'Please clarify this paragraph.' } });
    assert.equal((await f.sendEvent(comment)).ok, true);
    assert.equal((await f.sendEvent(comment)).ok, true);
    await f.session.refresh(); assert.equal(f.session.events.filter(e => e.id === comment.id).length, 1);
    const bytes = jsonBytes(comment); assert.deepEqual(await readFile(path.join(f.root, 'events', `${digest(bytes).slice(7)}.json`)), Buffer.from(bytes));
    const denied = f.session.makeEvent(alex, { type: 'thread.resolved', threadId: 'thread_companion', statusPredecessors: [] });
    const deniedResult = await f.sendEvent(denied); assert.equal(deniedResult.ok, false); assert.match(deniedResult.error!, /initiator/);
    const outsider = f.session.makeEvent(f.session.context({ id: 'outsider@example.com' }), { type: 'comment.replied', threadId: 'thread_companion', commentId: 'outsider_reply', body: { format: 'markdown', text: 'Forged invitation.' } });
    assert.equal((await f.sendEvent(outsider)).ok, false);
    const altered = structuredClone(comment); if (altered.type !== 'comment.created') throw new Error(); altered.id = 'bad_anchor'; altered.operationId = 'bad_anchor_op'; altered.anchor.quote.exact = 'Not the frozen text';
    assert.equal((await f.sendEvent(altered)).ok, false);
    const resolve = f.session.makeEvent(f.session.context(f.creator), { type: 'thread.resolved', threadId: 'thread_companion', statusPredecessors: [] });
    assert.equal((await f.sendEvent(resolve)).ok, true);
    const late = f.session.makeEvent(alex, { type: 'comment.replied', threadId: 'thread_companion', commentId: 'late_reply', body: { format: 'markdown', text: 'Thread is already closed.' } });
    assert.match((await f.sendEvent(late)).error!, /closed/);
    const reopen = f.session.makeEvent(f.session.context(f.creator), { type: 'thread.reopened', threadId: 'thread_companion', reason: 'One more check.', statusPredecessors: [resolve.id] });
    assert.equal((await f.sendEvent(reopen)).ok, true); assert.equal((await f.sendEvent(late)).ok, true);
    const publication = f.session.events.find(e => e.type === 'revision.created')!;
    assert.equal((await f.sendEvent({ ...publication, id: 'forged_revision', operationId: 'forged_revision_op' })).ok, false);
    const additional = reviewerRoster(['nina@example.com'])[0];
    const invitationDenied = f.session.makeEvent(alex, { type: 'reviewer.invited', reviewer: additional }); assert.equal((await f.sendEvent(invitationDenied)).ok, false);
    const invitation = f.session.makeEvent(f.session.context(f.creator), { type: 'reviewer.invited', reviewer: additional }); assert.equal((await f.sendEvent(invitation)).ok, true);
    assert.equal((await f.rpc('rememberReviewer', [{ id: 'nina@example.com', displayName: 'Nina' }])).ok, true);
    assert.deepEqual(await readFile(path.join(f.root, 'manifest.json')), manifest);
    const final = new (await import('../src/professional/session')).ReviewSession(f.store); await final.open();
    assert.equal(final.diagnostics.length, 0); assert.equal(final.events.filter(e => e.type === 'comment.replied').length, 1);
  } finally { await f.helper.close(); }
});

test('companion rejects changed roots, digest mismatches and malformed recovery; private identities survive restart', async () => {
  const f = await companionFixture();
  try {
    assert.equal((await f.rpc('rememberReviewer', [{ id: 'outsider@example.com' }])).ok, false);
    assert.equal((await f.rpc('rememberReviewer', [{ id: 'alex@example.com', displayName: 'Alex' }])).ok, true);
    assert.equal((await f.rpc('info')).value.reviewer.displayName, 'Alex');
    assert.equal((await f.rpc('journalPut', ['bad', { path: 'exports', bytes: '???', acknowledged: false }])).ok, false);
    assert.equal((await f.rpc('journalGet', ['companion:reviewer'])).ok, false);
    assert.equal((await f.rpc('write', [`blobs/sha256/${'aa'}/${'a'.repeat(64)}`, 'YQ==', false])).ok, false);
    await f.helper.close();
    const helper = await startCompanion({ root: f.root, journalRoot: path.join(f.temporary, 'helper-journal'), html: f.html });
    try {
      assert.notEqual(helper.url, f.helper.url);
      const token = new URLSearchParams(new URL(helper.url).hash.slice(1)).get('omr-session')!;
      const rpc = async () => (await fetch(helper.origin + '/api/rpc', { method: 'POST', headers: { Origin: helper.origin, 'X-OMR-Session': token, 'Content-Type': 'application/json' }, body: '{"method":"info","args":[]}' })).json() as Promise<any>;
      assert.equal((await rpc()).value.reviewer.displayName, 'Alex');
      await writeFile(path.join(f.root, 'manifest.json'), '{}');
      assert.equal((await rpc()).ok, false);
    } finally { await helper.close(); }
  } finally { await f.helper.close(); }
});

test('companion expires when unused and refuses unsafe launch parameters and shared recovery roots', async () => {
  const f = await companionFixture(); await f.helper.close();
  await assert.rejects(startCompanion({ root: f.root, journalRoot: path.join(f.root, 'private'), html: f.html }), /outside/);
  await assert.rejects(startCompanion({ root: f.root, journalRoot: path.join(f.temporary, 'journal'), html: '<html>untrusted</html>' }), /trusted/);
  const helper = await startCompanion({ root: f.root, journalRoot: path.join(f.temporary, 'idle-journal'), html: f.html, idleTimeoutMs: 120 });
  await helper.closed;
  await assert.rejects(fetch(helper.origin));
  assert.equal(companionArguments(['--store', f.root, '--no-open'], f.source).root, f.root);
  assert.equal(companionArguments([], f.root).root, f.root);
  assert.equal(companionArguments(['--recovery-root', f.temporary], f.root).journalRoot, f.temporary);
  for (const args of [['--host', '0.0.0.0'], ['--store', '../review'], ['--store'], ['--recovery-root', '../private'], ['--no-open', '--no-open']]) assert.throws(() => companionArguments(args, f.root));
  await rename(f.root, path.join(f.temporary, 'retired'));
});

test('companion refuses linked evidence and a replaced review directory', async () => {
  const f = await companionFixture();
  try {
    const document = f.session.revision!.documents.find(d => d.path === 'index.md')!, prefix = document.blobPath.split('/').slice(0, -1).join('/');
    await rename(path.join(f.root, prefix), path.join(f.temporary, 'original-evidence'));
    await symlink(f.source, path.join(f.root, prefix), process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await f.rpc('read', [document.blobPath, 2097152]); assert.equal(linked.ok, false); assert.match(linked.error!, /links|junction/i);
    const manifest = await readFile(path.join(f.root, 'manifest.json'));
    await rename(f.root, path.join(f.temporary, 'replaced-review'));
    await mkdir(f.root); await writeFile(path.join(f.root, 'manifest.json'), manifest);
    const replaced = await f.rpc('info'); assert.equal(replaced.ok, false); assert.match(replaced.error!, /replaced/);
  } finally { await f.helper.close(); }
});

test('host-owned publication recovery survives interruption and cannot be reset by browser journal hints', async () => {
  const f = await companionFixture();
  const bytes = Buffer.from('A publication with a recoverable, verified exact intent.'), hash = digest(bytes).slice(7), file = `blobs/sha256/${hash.slice(0, 2)}/${hash}`;
  const original = NativeStorage.prototype.write; let interrupted = false;
  try {
    NativeStorage.prototype.write = async function(relative, data, recover) {
      if (!interrupted && this.root === f.helper.root && relative === file) {
        interrupted = true; await original.call(this, relative, data.slice(0, 8), false); throw new Error('Injected interrupted native publication.');
      }
      return original.call(this, relative, data, recover);
    };
    const first = await f.rpc('write', [file, bytes.toString('base64'), false]); assert.equal(first.ok, false); assert.equal(first.code, 'uncertain');
    NativeStorage.prototype.write = original;
    assert.equal((await f.rpc('write', [file, bytes.toString('base64'), true])).ok, true);
    assert.deepEqual(await readFile(path.join(f.root, file)), bytes);
    await rename(path.join(f.root, file), path.join(f.temporary, 'saved-original-publication'));
    assert.equal((await f.rpc('journalPut', ['browser_hint', { path: file, bytes: bytes.toString('base64'), acknowledged: false }])).ok, true);
    const changed = await f.rpc('write', [file, bytes.toString('base64'), true]); assert.equal(changed.ok, false); assert.match(changed.error!, /acknowledged.*disappeared/);
    await assert.rejects(readFile(path.join(f.root, file)), /ENOENT/);
  } finally { NativeStorage.prototype.write = original; await f.helper.close(); }
});

test('reusing a retired review path cannot inherit old companion acknowledgements or identities', async () => {
  const f = await companionFixture(), bytes = Buffer.from('Identical optional publication bytes'), hash = digest(bytes).slice(7), file = `blobs/sha256/${hash.slice(0, 2)}/${hash}`;
  assert.equal((await f.rpc('write', [file, bytes.toString('base64'), false])).ok, true);
  assert.equal((await f.rpc('rememberReviewer', [{ id: 'alex@example.com', displayName: 'Previous review' }])).ok, true);
  await f.helper.close(); await rename(f.root, path.join(f.temporary, 'retired-review'));
  await authorReview({ source: f.source, store: f.root, rootDocument: 'index.md', actor: f.creator, operationId: 'new_review_same_path', journalRoot: path.join(f.temporary, 'new-author-journal'), clientArtifact: path.resolve('dist/OpenMarkdownReview.html') });
  const helper = await startCompanion({ root: f.root, journalRoot: path.join(f.temporary, 'helper-journal'), html: f.html });
  try {
    assert.notEqual(helper.reviewId, f.helper.reviewId);
    const token = new URLSearchParams(new URL(helper.url).hash.slice(1)).get('omr-session')!;
    const rpc = async (method: string, args: unknown[]) => (await fetch(helper.origin + '/api/rpc', { method: 'POST', headers: { Origin: helper.origin, 'X-OMR-Session': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })).json() as Promise<any>;
    assert.equal((await rpc('info', [])).value.reviewer, undefined);
    assert.equal((await rpc('write', [file, bytes.toString('base64'), false])).ok, true);
    assert.deepEqual(await readFile(path.join(f.root, file)), bytes);
  } finally { await helper.close(); }
});
