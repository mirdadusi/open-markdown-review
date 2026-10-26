import { decode, digest, jsonBytes, parseJson, safePath } from './bytes';
import { ReviewSession } from './session';
import { evidence, JournalEntry, publish, Storage } from './storage';
import { LIMITS, ProtocolError } from './types';
import { validate } from './validation';
import { reviewerForInput } from './reviewer';

/** Host-neutral authorization/publication boundary. No filesystem, HTTP, Node or Go imports. */
export interface CompanionCodec {
  toBase64(bytes: Uint8Array): string;
  fromBase64(value: string): Uint8Array;
}
export interface CompanionRpcOptions {
  store: Storage;
  hostStore: Storage;
  session: ReviewSession;
  manifestDigest: string;
  codec: CompanionCodec;
  binding(): Promise<void>;
  scheduleStop(): void;
}
export const COMPANION_MAX_BODY = Math.ceil(LIMITS.pdf / 3) * 4 + 131072;
const READABLE = /^(?:manifest\.json|events\/[a-f0-9]{64}\.json|revisions\/[A-Za-z0-9_-]+\.json|blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}|exports\/[a-f0-9]{64}\.(?:pdf|inventory\.json))$/;
const WRITABLE = /^(?:events\/[a-f0-9]{64}\.json|blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}|exports\/[a-f0-9]{64}\.(?:pdf|inventory\.json))$/;
function invalid(message: string): never { throw new ProtocolError('invalid', message); }
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

export function parseCompanionRequest(bytes: Uint8Array): { method: string; args: unknown[] } {
  const body = parseJson<any>(bytes, COMPANION_MAX_BODY);
  if (!body || typeof body.method !== 'string' || !Array.isArray(body.args) || body.args.length > 3 || Object.keys(body).sort().join(',') !== 'args,method') invalid('Invalid companion request.');
  return body;
}
export function createCompanionRpc(options: CompanionRpcOptions) {
  const { store, hostStore, session, manifestDigest, codec, binding, scheduleStop } = options;
  const root = store.identity;
  let mutation = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = mutation.then(work); mutation = next.then(() => undefined, () => undefined); return next;
  }
  function wireJournal(entry: JournalEntry | undefined) { return entry ? { ...entry, bytes: codec.toBase64(new Uint8Array(entry.bytes)) } : null; }
  function fromWire(value: unknown, limit: number = LIMITS.pdf): Uint8Array {
    if (typeof value !== 'string' || value.length % 4 !== 0 || value.length > Math.ceil(limit / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) invalid('Invalid or excessive base64 payload.');
    const bytes = codec.fromBase64(value);
    if (bytes.length > limit || codec.toBase64(bytes) !== value) invalid('Noncanonical base64 payload.');
    return bytes;
  }

  async function writeFile(args: unknown[]) {
    if (args.length !== 3 || typeof args[2] !== 'boolean') invalid('Invalid publication arguments.');
    const file = fileArgument(args[0], true), bytes = fromWire(args[1], fileLimit(file));
    const hash = digest(bytes).slice(7), expected = file.startsWith('blobs/') ? file.slice(-64) : file.split('/').at(-1)!.slice(0, 64);
    if (hash !== expected || file.startsWith('blobs/') && file.split('/')[2] !== hash.slice(0, 2)) throw new ProtocolError('integrity', 'Publication bytes do not match their content-addressed path.');
    await binding();
    if (file.startsWith('events/')) {
      const event = validate('event', parseJson(bytes, LIMITS.event));
      if (event.type === 'revision.created' || event.type === 'suggestion.applied') throw new ProtocolError('permission', 'Source authoring is available only in VS Code or the authoring CLI.');
      if (digest(jsonBytes(event)) !== digest(bytes)) invalid('Participant events must use the shared canonical writer encoding.');
      await session.refresh(); await session.pin(event.revisionId);
      await session.save(session.context(event.actor), event);
    } else {
      if (file.endsWith('.pdf') && decode(bytes.subarray(0, 5)) !== '%PDF-') invalid('An archived PDF must contain PDF bytes.');
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
      return codec.toBase64(bytes);
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
      await store.journalPut(key, { path: value.path, bytes, acknowledged: value.acknowledged, ...(value.digest ? { digest: value.digest } : {}) });
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
    if (method === 'stop' && !args.length) { scheduleStop(); return true; }
    throw new ProtocolError('permission', 'Unsupported companion operation.');
  }
  return rpc;
}
