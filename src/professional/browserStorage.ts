import { digest, safePath } from './bytes';
import { IoLimiter, JournalEntry, Storage } from './storage';
import { ProtocolError } from './types';
const DB = 'omr-professional-local';
const io = new IoLimiter(4);
export async function localValue<T>(key: string, value?: T): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('local');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction('local', value === undefined ? 'readonly' : 'readwrite'), store = transaction.objectStore('local');
      const action = value === undefined ? store.get(key) : store.put(value, key);
      transaction.oncomplete = () => { db.close(); resolve(action.result as T); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  });
}
function translated(error: unknown): never {
  if (error instanceof ProtocolError) throw error;
  const name = (error as DOMException).name;
  throw new ProtocolError(name === 'NotFoundError' ? 'missing' : ['NotAllowedError', 'SecurityError'].includes(name) ? 'permission' : 'uncertain', error instanceof Error ? error.message : String(error));
}
export class BrowserStorage implements Storage {
  constructor(readonly root: FileSystemDirectoryHandle, readonly identity: string, readonly writable: boolean) {}
  private async file(relative: string, create = false): Promise<FileSystemFileHandle> {
    const parts = safePath(relative).split('/'), name = parts.pop()!; let parent = this.root;
    for (const part of parts) parent = await parent.getDirectoryHandle(part, { create });
    const handle = await parent.getFileHandle(name, { create });
    const resolved = await this.root.resolve(handle); if (!resolved || resolved.join('/') !== relative) throw new ProtocolError('integrity', 'File handle escapes the granted review root.');
    return handle;
  }
  read(relative: string, limit: number): Promise<Uint8Array> { return io.run(() => this.readFile(relative, limit)); }
  private async readFile(relative: string, limit: number): Promise<Uint8Array> {
    try { const file = await (await this.file(relative)).getFile(); if (file.size > limit) throw new ProtocolError('unsupported', `File exceeds ${limit} bytes: ${relative}`); return new Uint8Array(await file.arrayBuffer()); } catch (error) { return translated(error); }
  }
  list(relative: string): Promise<string[]> { return io.run(() => this.listFiles(relative)); }
  private async listFiles(relative: string): Promise<string[]> {
    try {
      let directory = this.root; for (const part of safePath(relative).split('/')) directory = await directory.getDirectoryHandle(part);
      const result: string[] = [];
      for await (const [name, handle] of (directory as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries()) if (handle.kind === 'file') result.push(name);
      return result.sort();
    } catch (error) { return translated(error); }
  }
  write(relative: string, bytes: Uint8Array, recoverPrefix: boolean): Promise<void> { return io.run(() => this.writeFile(relative, bytes, recoverPrefix)); }
  private async writeFile(relative: string, bytes: Uint8Array, recoverPrefix: boolean): Promise<void> {
    if (!this.writable) throw new ProtocolError('permission', 'Read-only folder grant.');
    try {
      // Check again immediately before creating a writer. Different valid contents have different hash targets.
      try {
        const existing = await this.readFile(relative, bytes.length);
        if (digest(existing) === digest(bytes)) return;
        if (!recoverPrefix || existing.length >= bytes.length || !existing.every((b, i) => b === bytes[i])) throw new ProtocolError('integrity', 'Existing file is not this pending publication.');
      } catch (error) { if (!(error instanceof ProtocolError && error.code === 'missing')) throw error; }
      const handle = await this.file(relative, true), writable = await handle.createWritable({ keepExistingData: false });
      try { const stable = new Uint8Array(bytes); await writable.write(stable.buffer); await writable.close(); } catch (error) { await writable.abort().catch(() => undefined); throw error; }
    } catch (error) { translated(error); }
  }
  async journalGet(operation: string): Promise<JournalEntry | undefined> { const entry = await localValue<JournalEntry>(`journal:${this.identity}:${operation}`); return entry && { ...entry, bytes: Array.from(entry.bytes) }; }
  async journalPut(operation: string, entry: JournalEntry): Promise<void> { await localValue(`journal:${this.identity}:${operation}`, { ...entry, bytes: new Uint8Array(entry.bytes) }); }
}
