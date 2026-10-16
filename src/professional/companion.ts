import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { digest, jsonBytes, parseJson, safePath } from './bytes';
import { NativeStorage } from './nativeStorage';
import { ReviewSession } from './session';
import { evidence, JournalEntry, publish } from './storage';
import { LIMITS, ProtocolError } from './types';
import { validate } from './validation';
import { reviewerForInput } from './reviewer';

export interface CompanionOptions {
  root: string;
  journalRoot: string;
  /** Trusted client shipped with this application, never HTML read from a review. */
  html: string;
  port?: number;
  idleTimeoutMs?: number;
}
export interface Companion {
  origin: string;
  /** Local capability URL. Never store this URL in a review, logs or telemetry. */
  url: string;
  root: string;
  reviewId: string;
  closed: Promise<void>;
  close(): Promise<void>;
}
const MAX_BODY = Math.ceil(LIMITS.pdf / 3) * 4 + 131072;
const MAX_REQUESTS = 8;
const READABLE = /^(?:manifest\.json|events\/[a-f0-9]{64}\.json|revisions\/[A-Za-z0-9_-]+\.json|blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}|exports\/[a-f0-9]{64}\.(?:pdf|inventory\.json))$/;
const WRITABLE = /^(?:events\/[a-f0-9]{64}\.json|blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}|exports\/[a-f0-9]{64}\.(?:pdf|inventory\.json))$/;
function invalid(message: string): never { throw new ProtocolError('invalid', message); }
function fromWire(value: unknown, limit: number = LIMITS.pdf): Uint8Array {
  if (typeof value !== 'string' || value.length % 4 !== 0 || value.length > Math.ceil(limit / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) invalid('Invalid or excessive base64 payload.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > limit || bytes.toString('base64') !== value) invalid('Noncanonical base64 payload.');
  return bytes;
}
function operation(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) invalid('Invalid private journal key.');
  return value;
}
function fileArgument(value: unknown, writable = false): string {
  if (typeof value !== 'string') invalid('Expected a package-relative path.');
  safePath(value);
  if (!(writable ? WRITABLE : READABLE).test(value)) throw new ProtocolError('permission', 'This companion exposes review evidence only, not arbitrary files, sources or client programs.');
  return value;
}
function fileLimit(file: string): number {
  return file === 'manifest.json' ? LIMITS.manifest : file.startsWith('events/') ? LIMITS.event : file.startsWith('revisions/') ? LIMITS.revision : file.endsWith('.inventory.json') ? LIMITS.inventory : LIMITS.pdf;
}
async function requestBody(request: IncomingMessage): Promise<unknown> {
  const length = Number(request.headers['content-length']);
  if (request.headers['content-length'] && (!Number.isSafeInteger(length) || length < 1 || length > MAX_BODY)) throw new ProtocolError('unsupported', 'Request exceeds the companion size limit.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ProtocolError('unsupported', 'Request exceeds the companion size limit.');
    chunks.push(Buffer.from(chunk));
  }
  return parseJson(Buffer.concat(chunks), MAX_BODY);
}
function wireJournal(entry: JournalEntry | undefined) { return entry ? { ...entry, bytes: Buffer.from(entry.bytes).toString('base64') } : null; }
async function canonicalFutureDirectory(input: string): Promise<string> {
  let current = path.resolve(input); const tail: string[] = [];
  for (;;) {
    try { return path.join(await realpath(current), ...tail); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(current) === current) throw error;
      tail.unshift(path.basename(current)); current = path.dirname(current);
    }
  }
}

/** One explicitly selected review, one loopback origin, no ambient filesystem API. */
export async function startCompanion(options: CompanionOptions): Promise<Companion> {
  if (!path.isAbsolute(options.root) || !path.isAbsolute(options.journalRoot)) invalid('Companion paths must be absolute.');
  const initial = await lstat(options.root);
  if (!initial.isDirectory() || initial.isSymbolicLink()) invalid('Select a real review folder, not a symbolic link or junction.');
  const root = await realpath(options.root);
  const journalRoot = await canonicalFutureDirectory(options.journalRoot);
  const relativeJournal = path.relative(root, journalRoot);
  if (!relativeJournal || !relativeJournal.startsWith(`..${path.sep}`) && relativeJournal !== '..' && !path.isAbsolute(relativeJournal)) invalid('Recovery journals must stay outside the shared review folder.');
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) invalid('Invalid loopback port.');
  const idleMs = options.idleTimeoutMs ?? 10 * 60_000;
  if (!Number.isFinite(idleMs) || idleMs < 100 || idleMs > 24 * 60 * 60_000) invalid('Invalid companion idle timeout.');
  if (!options.html.includes('name="open-markdown-review-portable-client"') || !options.html.includes("connect-src 'none'")) invalid('Use the trusted bundled toolbox, not review-supplied HTML.');
  const html = options.html.replace("connect-src 'none'", "connect-src 'self'")
    .replace('</head>', '<meta name="open-markdown-review-companion" content="1"></head>');
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
  if (!policy) invalid('The trusted toolbox has no Content Security Policy.');
  const manifestBytes = await new NativeStorage(root, journalRoot).read('manifest.json', LIMITS.manifest);
  const manifestDigest = digest(manifestBytes), reviewId = validate('manifest', parseJson(manifestBytes, LIMITS.manifest)).reviewId;
  const privateRoot = path.join(journalRoot, manifestDigest.slice(7));
  // Browser recovery hints cannot replace the host's independent publication
  // acknowledgements. Both remain private; only the shared evidence is truth.
  // Scope journals to the immutable review, so reusing a retired folder cannot
  // inherit another review's acknowledgements or participant preferences.
  const store = new NativeStorage(root, path.join(privateRoot, 'client'));
  const hostStore = new NativeStorage(root, path.join(privateRoot, 'host')), session = new ReviewSession(hostStore);
  await session.open();
  if (session.manifest.reviewId !== reviewId || digest(await store.read('manifest.json', LIMITS.manifest)) !== manifestDigest) throw new ProtocolError('changed', 'The review changed during companion startup.');
  const token = randomBytes(32).toString('hex');
  let origin = '', closing = false, active = 0, idle: NodeJS.Timeout | undefined;
  let mutation = Promise.resolve();
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = mutation.then(work); mutation = next.then(() => undefined, () => undefined); return next;
  }
  async function binding() {
    const current = await lstat(options.root);
    if (current.isSymbolicLink() || current.dev !== initial.dev || current.ino !== initial.ino || await realpath(options.root) !== root || digest(await store.read('manifest.json', LIMITS.manifest)) !== manifestDigest) throw new ProtocolError('integrity', 'The selected review was replaced or its immutable manifest changed. Stop and reopen the companion.');
  }
  async function writeFile(args: unknown[]) {
    if (args.length !== 3 || typeof args[2] !== 'boolean') invalid('Invalid publication arguments.');
    const file = fileArgument(args[0], true), bytes = fromWire(args[1], fileLimit(file));
    const hash = digest(bytes).slice(7), expected = file.startsWith('blobs/') ? file.slice(-64) : path.basename(file).slice(0, 64);
    if (hash !== expected || file.startsWith('blobs/') && file.split('/')[2] !== hash.slice(0, 2)) throw new ProtocolError('integrity', 'Publication bytes do not match their content-addressed path.');
    await binding();
    if (file.startsWith('events/')) {
      const event = validate('event', parseJson(bytes, LIMITS.event));
      if (event.type === 'revision.created' || event.type === 'suggestion.applied') throw new ProtocolError('permission', 'Source authoring is available only in VS Code or the authoring CLI.');
      if (digest(jsonBytes(event)) !== digest(bytes)) invalid('Participant events must use the shared canonical writer encoding.');
      await session.refresh(); await session.pin(event.revisionId);
      await session.save(session.context(event.actor), event);
    } else {
      if (file.endsWith('.pdf') && Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-') invalid('An archived PDF must contain PDF bytes.');
      if (file.endsWith('.inventory.json')) validate('inventory', parseJson(bytes, LIMITS.inventory));
      // Only the host's exact-intent journal can authorize a partial-file retry.
      // A browser-supplied recovery flag/acknowledgement is never sufficient.
      await publish(hostStore, `companion:publication:${digest(file).slice(7)}`, evidence(file, bytes, file.endsWith('.pdf') ? 'application/pdf' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream'), bytes);
    }
    return null;
  }
  async function rpc(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'info') {
      if (args.length) invalid('Invalid info arguments.');
      await binding();
      const saved = await hostStore.journalGet('companion:reviewer');
      const reviewer = saved ? reviewerForInput(session.manifest, parseJson(new Uint8Array(saved.bytes)), session.events) : undefined;
      return { identity: root, writable: true, companion: true, binaryEncoding: 'base64', canRememberReviewer: true, ...(reviewer ? { reviewer } : {}) };
    }
    if (method === 'read') {
      const file = fileArgument(args[0]), limit = args[1];
      if (args.length !== 2 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > fileLimit(file)) invalid('Invalid evidence read limit.');
      const bytes = await store.read(file, Number(limit));
      if (file === 'manifest.json' && digest(bytes) !== manifestDigest) throw new ProtocolError('integrity', 'The immutable review manifest changed.');
      return Buffer.from(bytes).toString('base64');
    }
    if (method === 'list') {
      if (args.length !== 1 || typeof args[0] !== 'string' || !['events', 'revisions', 'exports'].includes(args[0])) throw new ProtocolError('permission', 'Only review evidence directories may be listed.');
      return store.list(args[0]);
    }
    if (method === 'write') return serialized(() => writeFile(args));
    if (method === 'journalGet') {
      if (args.length !== 1 || String(args[0]).startsWith('companion:')) invalid('Invalid journal request.');
      return wireJournal(await store.journalGet(operation(args[0])));
    }
    if (method === 'journalPut') return serialized(async () => {
      if (args.length !== 2 || String(args[0]).startsWith('companion:')) invalid('Invalid journal request.');
      const key = operation(args[0]), value = args[1] as Partial<JournalEntry> & { bytes?: unknown };
      if (!value || typeof value !== 'object' || typeof value.path !== 'string' || value.path.length > 1024 || typeof value.acknowledged !== 'boolean' || value.digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(value.digest)) invalid('Invalid recovery record.');
      const bytes = fromWire(value.bytes);
      if (value.digest && bytes.length && value.digest !== digest(bytes)) invalid('Recovery bytes differ from their digest.');
      await store.journalPut(key, { path: value.path, bytes: Array.from(bytes), acknowledged: value.acknowledged, ...(value.digest ? { digest: value.digest } : {}) });
      return null;
    });
    if (method === 'rememberReviewer') return serialized(async () => {
      if (args.length !== 1) invalid('Invalid reviewer preference.');
      await session.refresh();
      const reviewer = reviewerForInput(session.manifest, args[0], session.events);
      if (!reviewer) throw new ProtocolError('permission', 'Enter an invited reviewer email or the initiator identity.');
      await hostStore.journalPut('companion:reviewer', { path: 'identity', bytes: Array.from(jsonBytes(reviewer)), acknowledged: false });
      return true;
    });
    if (method === 'stop' && !args.length) { setTimeout(() => { void close(); }, 50).unref(); return true; }
    throw new ProtocolError('permission', 'Unsupported companion operation.');
  }
  function send(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value));
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', `${policy}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== origin.slice(7)) { send(response, 403, { ok: false, error: 'Invalid local host.' }); return; }
    if (closing) { send(response, 503, { ok: false, error: 'The companion is stopping.' }); return; }
    if (request.method === 'GET' && request.url === '/') {
      if (request.headers['sec-fetch-dest'] && request.headers['sec-fetch-dest'] !== 'document' || request.headers.origin && request.headers.origin !== origin) { send(response, 403, { ok: false, error: 'Open the companion directly, not inside a preview.' }); return; }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return;
    }
    if (request.method === 'GET' && request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (request.url !== '/api/rpc') { send(response, 404, { ok: false, error: 'Not found.' }); return; }
    const supplied = request.headers['x-omr-session'];
    if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin' || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token)) || request.headers['content-type'] !== 'application/json') {
      send(response, 403, { ok: false, error: 'Invalid local session. Reopen using the launcher.' }); return;
    }
    if (active >= MAX_REQUESTS) { send(response, 429, { ok: false, error: 'Too many simultaneous local requests.' }); return; }
    active++; touch();
    try {
      const body = await requestBody(request) as { method?: unknown; args?: unknown };
      if (!body || typeof body.method !== 'string' || !Array.isArray(body.args) || body.args.length > 3 || Object.keys(body).sort().join(',') !== 'args,method') invalid('Invalid companion request.');
      send(response, 200, { ok: true, value: await rpc(body.method, body.args) });
    } catch (error) {
      const known = error instanceof ProtocolError;
      send(response, known && error.code === 'unsupported' ? 413 : 200, { ok: false, code: known ? error.code : 'uncertain', error: error instanceof Error ? error.message : 'Local operation failed.' });
    } finally { active--; touch(); }
  });
  server.requestTimeout = 120_000; server.headersTimeout = 15_000; server.keepAliveTimeout = 5_000; server.maxHeadersCount = 32;
  function touch() {
    if (idle) clearTimeout(idle);
    if (!closing) idle = setTimeout(() => { if (active) touch(); else void close(); }, idleMs).unref();
  }
  function close(): Promise<void> {
    if (!closing) {
      closing = true; if (idle) clearTimeout(idle);
      server.close(() => resolveClosed()); server.closeIdleConnections();
    }
    return closed;
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') { await close(); throw new Error('Could not bind the local companion.'); }
  origin = `http://127.0.0.1:${address.port}`; touch();
  return { root, reviewId, origin, url: `${origin}/#omr-session=${token}`, closed, close };
}
