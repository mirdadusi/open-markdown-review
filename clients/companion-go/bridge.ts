// Host compatibility only. Authorization, parsing, state and publication are shared.
import { digest, parseJson } from '../../src/professional/bytes';
import { ReviewSession } from '../../src/professional/session';
import { LIMITS, ProtocolError } from '../../src/professional/types';
import { createCompanionRpc, parseCompanionRequest } from '../../src/professional/companionRpc';
import type { Storage } from '../../src/professional/storage';
import { inspect } from '../../src/professional/validation';

declare const __io: (scope: string, method: string, args: string) => string;
declare const __root: string;
declare const __encode: (value: string) => ArrayBuffer;
declare const __decode: (value: Uint8Array) => string;
declare const __b64: (value: Uint8Array) => string;
declare const __unb64: (value: string) => ArrayBuffer;
declare const __read: (file: string, limit: number) => ArrayBuffer;
declare const __write: (file: string, bytes: Uint8Array, recover: boolean) => void;
declare const __random: () => string;
declare const __stop: () => void;
Object.assign(globalThis, {
  TextEncoder: class { encode(value: string) { return new Uint8Array(__encode(value)); } },
  TextDecoder: class { decode(value: Uint8Array) { return __decode(value); } },
  crypto: { randomUUID: __random },
});
function io(scope: string, method: string, args: unknown[]) {
  // Only trusted Go-host results use this decoder. Every incoming request and
  // review JSON file goes through the shared strict parser before normalization.
  const result = JSON.parse(__io(scope, method, JSON.stringify(args)));
  if (!result.ok) throw new ProtocolError(result.code ?? 'uncertain', result.error);
  return result.value;
}
function native<T>(work: () => T): T {
  try { return work(); }
  catch (error) { const e = error as { code?: string; message?: string }; throw new ProtocolError((e.code ?? 'uncertain') as any, e.message ?? String(error)); }
}
function storage(scope: string): Storage {
  return {
    identity: __root, writable: true,
    async read(file, limit) { return native(() => new Uint8Array(__read(file, limit))); },
    async list(file) { return io(scope, 'list', [file]); },
    async write(file, bytes, recover) { native(() => __write(file, bytes, recover)); },
    async journalGet(key) {
      const raw = io(scope, 'journalGet', [key]);
      if (raw == null) return undefined;
      const entry = parseJson<any>(new Uint8Array(__encode(raw)), LIMITS.pdf * 8);
      if (entry.base64 !== undefined) { entry.bytes = new Uint8Array(__unb64(entry.base64)); delete entry.base64; }
      return entry;
    },
    async journalPut(key, entry) { const { bytes, ...metadata } = entry; io(scope, 'journalPut', [key, { ...metadata, base64: __b64(new Uint8Array(bytes)) }]); },
  };
}
let execute: ReturnType<typeof createCompanionRpc>;
export async function initialize() {
  const store = storage('client'), hostStore = storage('host'), session = new ReviewSession(hostStore);
  const manifestBytes = await store.read('manifest.json', LIMITS.manifest), manifestDigest = digest(manifestBytes);
  await session.open();
  if (digest(await store.read('manifest.json', LIMITS.manifest)) !== manifestDigest) throw new ProtocolError('changed', 'Review changed during startup.');
  execute = createCompanionRpc({
    store, hostStore, session, manifestDigest,
    codec: { toBase64: __b64, fromBase64: value => new Uint8Array(__unb64(value)) },
    binding: async () => { io('host', 'binding', []); }, scheduleStop: __stop,
  });
  return session.manifest.reviewId;
}
export async function request(source: string) {
  try {
    const body = parseCompanionRequest(new Uint8Array(__encode(source)));
    return { ok: true, value: await execute(body.method, body.args) };
  } catch (error) {
    return { ok: false, code: error instanceof ProtocolError ? error.code : 'uncertain', error: error instanceof Error ? error.message : String(error) };
  }
}
export function parseProbe(source: string) { return parseJson(new Uint8Array(__encode(source))); }
// Trusted test probes are not participant RPC methods. They cannot be invoked
// over HTTP; the shared allowlist still rejects unknown operations.
export function digestProbe(bytes: Uint8Array) { return digest(bytes); }
export function semanticsProbe(document: string, source: string, profile: Parameters<typeof inspect>[2]) { return inspect(source, document, profile); }
