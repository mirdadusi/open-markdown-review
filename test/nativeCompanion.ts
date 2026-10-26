import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Companion } from '../src/professional/companion';
import { COMPANION_TARGETS, CompanionTarget } from '../src/professional/companionTargets';
import { companionFileDigest } from '../src/professional/companionDelivery';

export function nativeTarget(): CompanionTarget {
  const value = `${process.platform}-${process.arch}`;
  if (!COMPANION_TARGETS.some(target => target.id === value)) throw new Error(`No qualified native companion target for ${value}.`);
  return value as CompanionTarget;
}
export async function nativeCompanion(root: string, privateHome: string, reviewId: string): Promise<Companion> {
  const target = COMPANION_TARGETS.find(target => target.id === nativeTarget())!;
  const executable = path.join(root, target.filename), expected = process.env.OMR_TEST_COMPANION;
  assert.ok(expected && path.isAbsolute(expected), 'Native qualification requires an explicit absolute executable.');
  assert.deepEqual(await companionFileDigest(executable), await companionFileDigest(expected), 'Creation delivered the exact packaged executable.');
  await mkdir(privateHome, { recursive: true });
  const child = spawn(executable, ['--recovery-root', privateHome, '--no-open'], { cwd: privateHome, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } });
  let stderr = '', timer: NodeJS.Timeout;
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  let url: string;
  try {
    url = await new Promise<string>((resolve, reject) => {
      let output = '';
      timer = setTimeout(() => reject(new Error(`Native companion startup timed out. ${stderr}`)), 30000);
      child.stdout.on('data', bytes => { output += bytes.toString(); const match = /http:\/\/127\.0\.0\.1:\d+\/#omr-session=[a-f0-9]{64}/.exec(output); if (match) { clearTimeout(timer); resolve(match[0]); } });
      child.once('error', reject); child.once('exit', code => reject(new Error(`Native companion exited before startup (${code}). ${stderr}`)));
    });
  } catch (error) { if (child.exitCode === null) child.kill('SIGTERM'); await exited; throw error; }
  finally { clearTimeout(timer!); }
  const local = new URL(url), closed = exited.then(code => { assert.equal(code, 0, stderr); });
  return { url, origin: local.origin, root, reviewId, closed, close: async () => {
    if (child.exitCode === null) {
      const token = new URLSearchParams(local.hash.slice(1)).get('omr-session')!;
      const response = await fetch(local.origin + '/api/rpc', { method: 'POST', headers: { Origin: local.origin, 'Content-Type': 'application/json', 'X-OMR-Session': token }, body: JSON.stringify({ method: 'stop', args: [] }) });
      assert.equal(response.status, 200, 'Native qualification uses the graceful stop API, including on Windows.');
    }
    await closed;
  } };
}
