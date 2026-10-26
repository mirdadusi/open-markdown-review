// Test transport selector: the very same assertions run against either host.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Companion, CompanionOptions, startCompanion as startNode } from '../src/professional/companion';
export async function startCompanion(options: CompanionOptions): Promise<Companion> {
  const executable = process.env.OMR_PROCESS_COMPANION ?? process.env.OMR_GO_COMPANION ?? process.env.OMR_EXPERIMENTAL_COMPANION;
  if (!executable) return startNode(options);
  return startNativeCompanion(options, executable);
}
export async function startNativeCompanion(options: CompanionOptions, executable: string): Promise<Companion> {
  if (!path.isAbsolute(executable)) throw new Error('Use an absolute experimental executable.');
  if (!options.html.includes('name="open-markdown-review-portable-client"') || !options.html.includes("connect-src 'none'")) throw new Error('Use the trusted bundled toolbox.');
  const args = ['--store', options.root, '--recovery-root', options.journalRoot, '--no-open'];
  if (process.env.OMR_COMPANION_TEST_FAULTS === 'true' || process.env.OMR_EXPERIMENTAL_COMPANION) args.push('--test-fault-file', options.journalRoot + '.fault');
  if (options.idleTimeoutMs !== undefined) args.push('--idle-ms', String(options.idleTimeoutMs));
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  let timer: NodeJS.Timeout;
  const url = await new Promise<string>((resolve, reject) => {
    let output = ''; timer = setTimeout(() => { child.kill(); reject(new Error(`Experimental startup timed out: ${stderr}`)); }, 30000);
    child.stdout.on('data', bytes => { output += bytes; const match = /http:\/\/127\.0\.0\.1:\d+\/#omr-session=[a-f0-9]{64}/.exec(output); if (match) { clearTimeout(timer); resolve(match[0]); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Experimental startup failed (${code}): ${stderr}`)); });
  });
  const local = new URL(url), token = new URLSearchParams(local.hash.slice(1)).get('omr-session')!;
  const response = await fetch(local.origin + '/api/rpc', { method: 'POST', headers: { Origin: local.origin, 'X-OMR-Session': token, 'Content-Type': 'application/json' }, body: '{"method":"read","args":["manifest.json",1048576]}' });
  const manifest = await response.json() as { value: string; ok: boolean; error?: string };
  if (!manifest.ok) { child.kill(); await exited; throw new Error(`Experimental manifest read failed: ${manifest.error}`); }
  const closed = exited.then(code => { if (code !== 0) throw new Error(`Experimental host exited ${code}: ${stderr}`); });
  return { root: options.root, reviewId: JSON.parse(Buffer.from(manifest.value, 'base64').toString()).reviewId, url, origin: local.origin, closed, close: async () => {
    if (child.exitCode === null) await fetch(local.origin + '/api/rpc', { method: 'POST', headers: { Origin: local.origin, 'X-OMR-Session': token, 'Content-Type': 'application/json' }, body: '{"method":"stop","args":[]}' });
    await closed;
  } };
}
