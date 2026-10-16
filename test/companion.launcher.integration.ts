import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, chmod, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { companionFixture } from './companion.fixture';
import { digest, jsonBytes } from '../src/professional/bytes';

test('standalone launcher starts outside the project, persists validated review actions and stops cleanly', { timeout: 45000 }, async () => {
  const f = await companionFixture();
  await f.helper.close();
  const native = process.env.OMR_TEST_COMPANION;
  let executable = process.execPath, args = [path.resolve('dist/companion.js'), '--store', f.root, '--no-open'];
  if (native) {
    assert.ok(path.isAbsolute(native), 'OMR_TEST_COMPANION must name an explicitly built absolute executable.');
    executable = path.join(f.root, process.platform === 'win32' ? 'StartReview.exe' : 'StartReview');
    await copyFile(native, executable); await chmod(executable, 0o755); args = ['--no-open'];
  }
  const manifest = await readFile(path.join(f.root, 'manifest.json')), events = await readdir(path.join(f.root, 'events'));
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
    const rpc = async (method: string, args: unknown[] = []) => (await fetch(local.origin + '/api/rpc', { method: 'POST', headers: { Origin: local.origin, 'Content-Type': 'application/json', 'X-OMR-Session': token }, body: JSON.stringify({ method, args }) })).json() as Promise<any>;
    assert.equal((await rpc('info')).value.companion, true);
    assert.equal((await fetch(local.origin)).status, 200);
    assert.deepEqual(await readFile(path.join(f.root, 'manifest.json')), manifest); assert.deepEqual(await readdir(path.join(f.root, 'events')), events);
    const actor = f.session.context({ id: 'alex@example.com', displayName: 'Alex' });
    const event = f.session.makeEvent(actor, { type: 'comment.created', threadId: 'native_thread', commentId: 'native_comment', anchor: f.anchor, body: { format: 'markdown', text: 'Persisted by the standalone native transport.' } });
    const eventBytes = jsonBytes(event), filename = `events/${digest(eventBytes).slice(7)}.json`;
    const saved = await rpc('write', [filename, Buffer.from(eventBytes).toString('base64'), false]); assert.equal(saved.ok, true, saved.error);
    assert.deepEqual(await readFile(path.join(f.root, filename)), Buffer.from(eventBytes));
    assert.equal((await rpc('stop')).ok, true); assert.equal(await exited, 0, stderr);
    await assert.rejects(fetch(local.origin));
  } finally { if (child.exitCode === null) child.kill('SIGTERM'); await exited; await f.helper.close(); }
});
