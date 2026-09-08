import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { digest, parseJson } from '../bytes';
import { NativeStorage } from '../nativeStorage';
import { checkpoint, OperationControl } from '../operation';
import { LIMITS, ProtocolError } from '../types';
import { rasterDimensions } from '../imageLimits';
import { SLIDEV_VERSION } from './slidev';

export interface SlidevOptions { notes: 'included' | 'excluded'; trustProject: boolean; browserExecutable?: string }
export interface CaptureRequest extends OperationControl { source: string; entry: string; journalRoot: string; options: SlidevOptions; sources: ReadonlyMap<string, string>; count: number }

export async function slidevRuntime(source: string): Promise<{ cli: string; version: string }> {
  try {
    const resolve = createRequire(path.join(path.resolve(source), 'package.json'));
    const packagePath = resolve.resolve('@slidev/cli/package.json');
    const metadata = parseJson<{ version: string; bin: Record<string, string> }>(await readFile(packagePath), LIMITS.manifest);
    if (metadata.version !== SLIDEV_VERSION) throw new ProtocolError('unsupported', `This profile requires author-side @slidev/cli ${SLIDEV_VERSION}; found ${metadata.version}.`);
    const cli = path.resolve(path.dirname(packagePath), metadata.bin.slidev);
    if (!cli.startsWith(path.dirname(packagePath) + path.sep) || !(await lstat(cli)).isFile()) throw new Error('Invalid Slidev executable.');
    return { cli, version: metadata.version };
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError('missing', `Install @slidev/cli@${SLIDEV_VERSION}, its theme and playwright-chromium in the trusted Slidev project first. No package is installed automatically. ${String(error)}`);
  }
}
async function unchanged(request: CaptureRequest): Promise<void> {
  const store = new NativeStorage(request.source, request.journalRoot);
  for (const [file, original] of request.sources) if (digest(await store.read(file, LIMITS.markdown)) !== digest(original)) throw new ProtocolError('changed', `Slidev source changed during capture: ${file}. Start a new authoring operation.`);
}
/** Explicitly trusted author-side build. No child process or Slidev code is shipped to participants. */
export async function captureSlidev(request: CaptureRequest): Promise<Uint8Array[]> {
  if (!request.options.trustProject) throw new ProtocolError('permission', 'Slidev capture executes the author project. Explicit trust is required.');
  checkpoint(request, 'Checking trusted Slidev runtime');
  const runtime = await slidevRuntime(request.source);
  for (const name of ['preparser.ts', 'preparser.js', 'preparser.mts', 'preparser.mjs']) {
    try { await lstat(path.join(request.source, 'setup', name)); throw new ProtocolError('unsupported', 'Custom Slidev preparsers cannot provide verified v1 source mappings.'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  await unchanged(request);
  // mkdtemp creates a unique owned directory. Slidev receives only its fresh child,
  // never a user-selected output directory (Slidev cleans its output recursively).
  const temporary = await mkdtemp(path.join(request.journalRoot, 'slidev-capture-'));
  const output = path.join(temporary, 'slides');
  const args = [runtime.cli, 'export', path.resolve(request.source, request.entry), '--format', 'png', '--output', output, '--timeout', '30000', '--wait', '1000', '--wait-until', 'networkidle', '--range', 'all', '--with-clicks=false', '--per-slide=false'];
  if (request.options.browserExecutable) args.push('--executable-path', path.resolve(request.options.browserExecutable));
  checkpoint(request, 'Rendering frozen Slidev pages (trusted author project; up to five minutes)');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: request.source, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CI: 'true' } });
    let tail = '', failure: ProtocolError | undefined;
    const collect = (chunk: Buffer) => { tail = (tail + chunk.toString('utf8')).slice(-6000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const stop = (error: ProtocolError) => { failure ??= error; child.kill(); };
    const abort = () => stop(new ProtocolError('cancelled', 'Slidev capture was cancelled. No review was published.'));
    request.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new ProtocolError('uncertain', 'Slidev capture exceeded five minutes. No review was published.')), 300000);
    const done = () => { clearTimeout(timer); request.signal?.removeEventListener('abort', abort); };
    child.on('error', error => { done(); reject(error); });
    child.on('close', code => { done(); if (failure) reject(failure); else if (code !== 0) reject(new ProtocolError('invalid', `Slidev capture failed (${code}). ${tail}`)); else resolve(); });
    if (request.signal?.aborted) abort();
  });
  checkpoint(request); await unchanged(request);
  const files = await readdir(output);
  if (files.length !== request.count || files.some(name => !/^\d+\.png$/.test(name)) || new Set(files.map(name => Number(name.slice(0, -4)))).size !== request.count) throw new ProtocolError('integrity', 'Slidev exported an unexpected page set. No review was published.');
  const store = new NativeStorage(output, request.journalRoot), pages: Uint8Array[] = [];
  for (let i = 1; i <= request.count; i++) {
    checkpoint(request, `Freezing slide ${i} of ${request.count}`);
    const file = files.find(name => Number(name.slice(0, -4)) === i);
    if (!file) throw new ProtocolError('integrity', `Slidev export is missing page ${i}.`);
    const bytes = await store.read(file, LIMITS.resource); rasterDimensions(bytes, 'image/png'); pages.push(bytes);
    if (pages.reduce((n, p) => n + p.length, 0) > LIMITS.content) throw new ProtocolError('unsupported', 'Slide snapshots exceed the package byte limit.');
  }
  return pages;
}
