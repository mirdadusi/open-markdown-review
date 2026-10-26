import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, chmod, readFile, readdir, lstat, realpath, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { companionFixture } from './companion.fixture';
import { digest, jsonBytes } from '../src/professional/bytes';
import { companionFileDigest, readCompanionCatalog } from '../src/professional/companionDelivery';

test('standalone launcher starts outside the project, persists validated review actions and stops cleanly', { timeout: 45000 }, async t => {
  // Keep the original gate, bounded requests and useful stage diagnostics.
  const started = performance.now(); let stage = 'fixture authoring and first native startup';
  const next = (value: string) => { t.diagnostic(`${stage}: ${(performance.now() - started).toFixed(0)} ms elapsed`); stage = value; };
  t.after(() => t.diagnostic(`Final stage: ${stage}; ${(performance.now() - started).toFixed(0)} ms elapsed`));
  const f = await companionFixture();
  next('stop the fixture helper');
  await f.helper.close();
  next('copy the native executable');
  const native = process.env.OMR_PROCESS_COMPANION ?? process.env.OMR_GO_COMPANION ?? process.env.OMR_EXPERIMENTAL_COMPANION ?? process.env.OMR_TEST_COMPANION;
  let executable = process.execPath, args = [path.resolve('dist/companion.js'), '--store', f.root, '--no-open'];
  let copiedDigest: string | undefined;
  let copiedExecutable: string | undefined;
  if (native) {
    assert.ok(path.isAbsolute(native), 'OMR_TEST_COMPANION must name an explicitly built absolute executable.');
    executable = path.join(f.root, process.platform === 'win32' ? 'StartReview.exe' : 'StartReview');
    copiedDigest = digest(await readFile(native));
    await copyFile(native, executable, constants.COPYFILE_FICLONE); await chmod(executable, 0o755); args = ['--no-open'];
    copiedExecutable = executable;
  } else {
    // The default JS entry now delegates to the installed Go distribution. A
    // loose build-tree script is not a complete installation. Exercise the real
    // authoring CLI from a private installed-layout fixture, never Node fallback.
    const installed = path.join(f.temporary, 'installed-authoring'); await mkdir(installed);
    for (const name of ['companion.js', 'OpenMarkdownReview.html', 'companion-core.js', 'companion-catalog.json']) {
      await copyFile(path.resolve('dist', name), path.join(installed, name), constants.COPYFILE_EXCL);
    }
    const { catalog } = await readCompanionCatalog(path.join(installed, 'OpenMarkdownReview.html'));
    const target = `${process.platform}-${process.arch}`, entry = catalog.targets.find(item => item.target === target);
    assert.ok(entry, 'The default launcher requires a pinned native Go target.');
    const filename = process.platform === 'win32' ? 'StartReview.exe' : 'StartReview';
    let source: string | undefined;
    for (const candidate of [path.resolve('dist/bundled-companions', target, filename), path.resolve('dist/companion-go', target, filename)]) {
      try {
        assert.deepEqual(await companionFileDigest(candidate), { digest: entry.executable.digest, byteLength: entry.executable.byteLength });
        source = candidate; break;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    assert.ok(source, 'Build or install the release-pinned Go companion before the launcher integration test.');
    copiedExecutable = path.join(installed, 'bundled-companions', target, filename);
    await mkdir(path.dirname(copiedExecutable), { recursive: true });
    await copyFile(source, copiedExecutable, constants.COPYFILE_EXCL); await chmod(copiedExecutable, 0o755);
    copiedDigest = entry.executable.digest;
    args = [path.join(installed, 'companion.js'), '--store', f.root, '--no-open'];
  }
  const manifest = await readFile(path.join(f.root, 'manifest.json')), events = await readdir(path.join(f.root, 'events'));
  next('start the copied standalone launcher');
  const child = spawn(executable, args, { cwd: f.temporary, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => reject(new Error(`The standalone launcher did not become ready. ${stderr}`)), 20000);
      child.stdout.on('data', bytes => {
        stdout += bytes.toString(); const match = /http:\/\/127\.0\.0\.1:\d+\/#omr-session=[a-f0-9]{64}/.exec(stdout);
        if (match) { clearTimeout(timeout); resolve(match[0]); }
      });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Launcher exited before ready (${code}). ${stderr}`)); });
    });
    const local = new URL(url), token = new URLSearchParams(local.hash.slice(1)).get('omr-session')!;
    const rpc = async (method: string, args: unknown[] = []) => (await fetch(local.origin + '/api/rpc', { method: 'POST', headers: { Origin: local.origin, 'Content-Type': 'application/json', 'X-OMR-Session': token }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(20000) })).json() as Promise<any>;
    next('read standalone identity and toolbox');
    assert.equal((await rpc('info')).value.companion, true);
    const toolbox = await fetch(local.origin, { signal: AbortSignal.timeout(20000) });
    // fetch resolves at the headers. Drain the large toolbox before asking the
    // host to stop: an unread body can leave an active write blocked on a slow
    // CI socket, which graceful shutdown correctly waits to finish.
    assert.equal(toolbox.status, 200); await toolbox.arrayBuffer();
    assert.deepEqual(await readFile(path.join(f.root, 'manifest.json')), manifest); assert.deepEqual(await readdir(path.join(f.root, 'events')), events);
    const actor = f.session.context({ id: 'alex@example.com', displayName: 'Alex' });
    const event = f.session.makeEvent(actor, { type: 'comment.created', threadId: 'native_thread', commentId: 'native_comment', anchor: f.anchor, body: { format: 'markdown', text: 'Persisted by the standalone native transport.' } });
    const eventBytes = jsonBytes(event), filename = `events/${digest(eventBytes).slice(7)}.json`;
    next('persist and verify the native event');
    const saved = await rpc('write', [filename, Buffer.from(eventBytes).toString('base64'), false]); assert.equal(saved.ok, true, saved.error);
    assert.deepEqual(await readFile(path.join(f.root, filename)), Buffer.from(eventBytes));
    next('stop and await the standalone process');
    assert.equal((await rpc('stop')).ok, true); assert.equal(await exited, 0, stderr);
    await assert.rejects(fetch(local.origin, { signal: AbortSignal.timeout(5000) }));
    next('cleanup');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM'); await exited; await f.helper.close();
    // Remove only our unchanged executable copy; retain the fixture's review,
    // events and other evidence. Repeated native tests must not leak runtimes.
    if (copiedDigest && copiedExecutable) {
      const info = await lstat(copiedExecutable);
      assert.ok(info.isFile() && !info.isSymbolicLink());
      const parent = await realpath(path.dirname(copiedExecutable)), relative = path.relative(await realpath(f.temporary), parent);
      assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
      assert.equal(await realpath(copiedExecutable), path.join(parent, path.basename(copiedExecutable)));
      assert.equal(digest(await readFile(copiedExecutable)), copiedDigest, 'Never remove an altered fixture executable.');
      await unlink(copiedExecutable);
    }
  }
});
