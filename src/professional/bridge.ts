import { NativeStorage } from './nativeStorage';
import { JournalEntry } from './storage';
import { LIMITS, ProtocolError } from './types';
import { safePath } from './bytes';
export async function storageResponse(storage: NativeStorage, method: string, args: unknown[]) {
  try { return { ok: true as const, value: await storageRequest(storage, method, args) }; }
  catch (error) { return { ok: false as const, code: error instanceof ProtocolError ? error.code : 'uncertain', error: error instanceof Error ? error.message : String(error) }; }
}
/** Explicit RPC allowlist. No arbitrary filesystem or command execution from a webview. */
export async function storageRequest(storage: NativeStorage, method: string, args: unknown[]): Promise<unknown> {
  const file = () => { if (typeof args[0] !== 'string') throw new ProtocolError('invalid', 'Expected a package-relative path.'); return safePath(args[0]); };
  switch (method) {
    case 'info': return { identity: storage.identity, writable: storage.writable };
    case 'read': { const limit = args[1]; if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > LIMITS.pdf) throw new ProtocolError('unsupported', 'Invalid read limit.'); return Array.from(await storage.read(file(), Number(limit))); }
    case 'list': return storage.list(file());
    case 'write': {
      const relative = file();
      if (!/^(?:events\/[a-f0-9]{64}\.json|blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}|exports\/[a-f0-9]{64}\.(?:pdf|inventory\.json))$/.test(relative)) throw new ProtocolError('permission', 'Participant bridge cannot create manifests, revisions, source files or executable clients.');
      const value = args[1]; if (!Array.isArray(value) || value.length > LIMITS.pdf || value.some(v => !Number.isInteger(v) || v < 0 || v > 255) || typeof args[2] !== 'boolean') throw new ProtocolError('invalid', 'Invalid write request.');
      await storage.write(relative, new Uint8Array(value), args[2]); return null;
    }
    case 'journalGet': if (typeof args[0] !== 'string') throw new ProtocolError('invalid', 'Invalid journal key.'); return await storage.journalGet(args[0]) ?? null;
    case 'journalPut': {
      const entry = args[1] as JournalEntry;
      if (typeof args[0] !== 'string' || !entry || typeof entry.path !== 'string' || !Array.isArray(entry.bytes) || entry.bytes.length > LIMITS.pdf || typeof entry.acknowledged !== 'boolean') throw new ProtocolError('invalid', 'Invalid local journal request.');
      await storage.journalPut(args[0], entry); return null;
    }
    default: throw new ProtocolError('permission', `Unsupported bridge operation: ${method}`);
  }
}
