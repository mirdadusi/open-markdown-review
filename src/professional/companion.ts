import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { digest, parseJson } from './bytes';
import { NativeStorage } from './nativeStorage';
import { ReviewSession } from './session';
import { LIMITS, ProtocolError } from './types';
import { validate } from './validation';
import { COMPANION_MAX_BODY as MAX_BODY, createCompanionRpc, parseCompanionRequest } from './companionRpc';

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
const MAX_REQUESTS = 8;
function invalid(message: string): never { throw new ProtocolError('invalid', message); }
async function requestBody(request: IncomingMessage): Promise<{ method: string; args: unknown[] }> {
  const length = Number(request.headers['content-length']);
  if (request.headers['content-length'] && (!Number.isSafeInteger(length) || length < 1 || length > MAX_BODY)) throw new ProtocolError('unsupported', 'Request exceeds the companion size limit.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ProtocolError('unsupported', 'Request exceeds the companion size limit.');
    chunks.push(Buffer.from(chunk));
  }
  return parseCompanionRequest(Buffer.concat(chunks));
}
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
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  async function binding() {
    const current = await lstat(options.root);
    if (current.isSymbolicLink() || current.dev !== initial.dev || current.ino !== initial.ino || await realpath(options.root) !== root || digest(await store.read('manifest.json', LIMITS.manifest)) !== manifestDigest) throw new ProtocolError('integrity', 'The selected review was replaced or its immutable manifest changed. Stop and reopen the companion.');
  }
  const rpc = createCompanionRpc({
    store, hostStore, session, manifestDigest, binding,
    codec: { toBase64: bytes => Buffer.from(bytes).toString('base64'), fromBase64: value => Buffer.from(value, 'base64') },
    scheduleStop: () => { setTimeout(() => { void close(); }, 50).unref(); },
  });
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
      const body = await requestBody(request);
      // Parsed and structurally checked by the shared RPC boundary.
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
