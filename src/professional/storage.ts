import { digest, jsonBytes, parseJson, safePath } from './bytes';
import { FileEvidence, LIMITS, ProtocolError, StoredContent } from './types';
export interface JournalEntry { path: string; bytes: number[]; acknowledged: boolean; digest?: string }
/** Global adapter admission avoids nested scans multiplying shared-drive requests. */
export class IoLimiter {
  private running = 0; private readonly waiting: Array<() => void> = [];
  constructor(readonly maximum = 4) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.maximum) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.running++;
    try { return await work(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.running--; }
  }
}
/** All adapters are rooted capabilities, never ambient arbitrary-path access. */
export interface Storage {
  readonly identity: string;
  readonly writable: boolean;
  read(path: string, limit: number): Promise<Uint8Array>;
  list(path: string): Promise<string[]>;
  write(path: string, bytes: Uint8Array, recoverPrefix: boolean): Promise<void>;
  journalGet(operation: string): Promise<JournalEntry | undefined>;
  journalPut(operation: string, entry: JournalEntry): Promise<void>;
}
export async function readOptional(store: Storage, path: string, limit: number): Promise<Uint8Array | undefined> {
  try { return await store.read(path, limit); } catch (error) { if (error instanceof ProtocolError && error.code === 'missing') return undefined; throw error; }
}
export function evidence(path: string, bytes: Uint8Array, mediaType: string): FileEvidence { return { path, digest: digest(bytes), byteLength: bytes.length, mediaType }; }
export const contentRef = (file: FileEvidence): StoredContent => ({ digest: file.digest, byteLength: file.byteLength, mediaType: file.mediaType, blobPath: file.path });
export function blobEvidence(bytes: Uint8Array, mediaType: string): FileEvidence {
  const hash = digest(bytes).slice(7); return evidence(`blobs/sha256/${hash.slice(0, 2)}/${hash}`, bytes, mediaType);
}
/** Exact-intent recovery is local-only. No provider file is repaired without its journal. */
export async function publish(store: Storage, operation: string, file: FileEvidence, bytes: Uint8Array): Promise<void> {
  if (!store.writable) throw new ProtocolError('permission', 'This connection is read-only.');
  safePath(file.path);
  if (digest(bytes) !== file.digest || bytes.length !== file.byteLength) throw new ProtocolError('invalid', 'Publication bytes differ from intent.');
  let journal = await store.journalGet(operation);
  if (journal && (journal.path !== file.path || (journal.digest ?? digest(new Uint8Array(journal.bytes))) !== file.digest)) throw new ProtocolError('integrity', 'Operation ID already names a different publication. Retry its original intent.');
  const existing = await readOptional(store, file.path, Math.max(bytes.length, 1));
  if (existing && digest(existing) === file.digest) {
    await store.journalPut(operation, { path: file.path, bytes: [], digest: file.digest, acknowledged: true }); return;
  }
  // Acknowledged records intentionally retain no large bytes. Never reconstruct a lost shared file.
  if (journal?.acknowledged) throw new ProtocolError('integrity', `An acknowledged immutable publication disappeared or changed: ${file.path}. Preserve the package for inspection and start a new capture in a different empty folder; never reconstruct acknowledged evidence automatically.`);
  const recover = !!journal && !!existing && existing.length < bytes.length && existing.every((b, i) => b === bytes[i]);
  if (existing && !recover) throw new ProtocolError('integrity', `Refusing to overwrite existing file: ${file.path}`);
  if (!journal) {
    journal = { path: file.path, bytes: Array.from(bytes), acknowledged: false };
    await store.journalPut(operation, journal);
  }
  try {
    await store.write(file.path, bytes, recover);
    const actual = await store.read(file.path, bytes.length);
    if (digest(actual) !== file.digest || actual.length !== bytes.length) throw new ProtocolError('uncertain', 'Closed file has not been verified. Retry the same action.');
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError('uncertain', `Publication is unacknowledged: ${String(error)}`);
  }
  await store.journalPut(operation, { path: file.path, bytes: [], digest: file.digest, acknowledged: true });
}
export async function publishBlob(store: Storage, operation: string, bytes: Uint8Array, mediaType: string): Promise<StoredContent> {
  const file = blobEvidence(bytes, mediaType); await publish(store, operation, file, bytes); return contentRef(file);
}
/** Bounded LRU; shared files remain authoritative and are reread during full audits. */
export class ByteCache {
  private readonly values = new Map<string, Uint8Array>(); private size = 0;
  constructor(readonly maximum = LIMITS.content) {}
  get(key: string): Uint8Array | undefined { const value = this.values.get(key); if (value) { this.values.delete(key); this.values.set(key, value); } return value; }
  set(key: string, bytes: Uint8Array): void {
    const previous = this.values.get(key); if (previous) this.size -= previous.length;
    this.values.delete(key);
    if (bytes.length > this.maximum) return;
    this.values.set(key, bytes); this.size += bytes.length;
    while (this.size > this.maximum) { const first = this.values.keys().next().value!; this.size -= this.values.get(first)!.length; this.values.delete(first); }
  }
}
