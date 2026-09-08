import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { digest, jsonBytes, parseJson, safePath } from './bytes';
import { IoLimiter, JournalEntry, Storage } from './storage';
import { LIMITS, ProtocolError } from './types';

function normalizeError(error: unknown, file: string): never {
  if (error instanceof ProtocolError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  throw new ProtocolError(code === 'ENOENT' ? 'missing' : code === 'EACCES' || code === 'EPERM' ? 'permission' : 'uncertain', `${file}: ${error instanceof Error ? error.message : String(error)}`);
}
const io = new IoLimiter(4);
/** Reject all links below the explicitly selected root, including Windows junctions. */
export async function contained(root: string, relative: string, createParents = false): Promise<string> {
  safePath(relative); const canonical = await realpath(root); let current = canonical;
  const segments = relative.split('/');
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new ProtocolError('integrity', `Symbolic links/junctions are not allowed: ${relative}`);
      if (i < segments.length - 1 && !info.isDirectory()) throw new ProtocolError('invalid', `Not a directory: ${current}`);
      const resolved = await realpath(current), diff = path.relative(canonical, resolved);
      if (diff === '..' || diff.startsWith(`..${path.sep}`) || path.isAbsolute(diff)) throw new ProtocolError('integrity', 'Path escapes the selected root.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (i < segments.length - 1 && createParents) {
        try { await mkdir(current); } catch (creationError) { if ((creationError as NodeJS.ErrnoException).code !== 'EEXIST') throw creationError; }
        const created = await lstat(current), actual = await realpath(current), diff = path.relative(canonical, actual);
        if (!created.isDirectory() || created.isSymbolicLink() || diff === '..' || diff.startsWith(`..${path.sep}`) || path.isAbsolute(diff)) throw new ProtocolError('integrity', 'New directory was replaced or escaped the root.');
      }
      else if (i < segments.length - 1) throw error;
    }
  }
  return current;
}
export class NativeStorage implements Storage {
  readonly identity: string; readonly writable = true;
  constructor(readonly root: string, readonly journalRoot: string) { this.identity = path.resolve(root); }
  read(relative: string, limit: number): Promise<Uint8Array> { return io.run(() => this.readFile(relative, limit)); }
  private async readFile(relative: string, limit: number): Promise<Uint8Array> {
    try {
      const target = await contained(this.root, relative), handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > limit) throw new ProtocolError('unsupported', `${relative} exceeds the ${limit}-byte limit or is not a regular file.`);
        const bytes = await handle.readFile();
        const after = await handle.stat(); await contained(this.root, relative);
        if (bytes.length > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new ProtocolError('changed', `File changed during read: ${relative}`);
        return bytes;
      } finally { await handle.close(); }
    } catch (error) { return normalizeError(error, relative); }
  }
  list(relative: string): Promise<string[]> { return io.run(() => this.listFiles(relative)); }
  private async listFiles(relative: string): Promise<string[]> {
    try {
      const directory = await contained(this.root, relative);
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.some(e => e.isSymbolicLink())) throw new ProtocolError('integrity', `Linked entry in ${relative}.`);
      return entries.filter(e => e.isFile()).map(e => e.name).sort();
    } catch (error) { return normalizeError(error, relative); }
  }
  write(relative: string, bytes: Uint8Array, recoverPrefix: boolean): Promise<void> { return io.run(() => this.writeFile(relative, bytes, recoverPrefix)); }
  private async writeFile(relative: string, bytes: Uint8Array, recoverPrefix: boolean): Promise<void> {
    try {
      const target = await contained(this.root, relative, true);
      const flags = (recoverPrefix ? constants.O_RDWR : constants.O_WRONLY) | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (recoverPrefix ? 0 : constants.O_EXCL);
      let handle;
      try { handle = await open(target, flags, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST' && digest(await this.readFile(relative, bytes.length)) === digest(bytes)) return;
        throw error;
      }
      try {
        await contained(this.root, relative);
        if (recoverPrefix) {
          const existing = await handle.readFile();
          if (digest(existing) === digest(bytes)) return;
          if (existing.length >= bytes.length || !existing.every((b, i) => b === bytes[i])) throw new ProtocolError('integrity', 'Pending file changed before recovery.');
        }
        let written = 0;
        while (written < bytes.length) { const part = await handle.write(bytes, written, bytes.length - written, written); if (!part.bytesWritten) throw new ProtocolError('uncertain', 'File write made no progress.'); written += part.bytesWritten; }
        await handle.truncate(bytes.length); await handle.sync(); await contained(this.root, relative);
      }
      finally { await handle.close(); }
    } catch (error) { normalizeError(error, relative); }
  }
  private journalName(operation: string): string { return `${digest(`${this.identity}\0${operation}`).slice(7)}.json`; }
  async journalGet(operation: string): Promise<JournalEntry | undefined> {
    try {
      const store = new NativeStorage(this.journalRoot, this.journalRoot);
      const entry = parseJson<JournalEntry & { base64?: string }>(await store.read(this.journalName(operation), LIMITS.pdf * 8), LIMITS.pdf * 8);
      if (entry.base64 !== undefined) { entry.bytes = Array.from(Buffer.from(entry.base64, 'base64')); delete entry.base64; }
      return entry;
    }
    catch (error) { if (error instanceof ProtocolError && error.code === 'missing') return undefined; throw error; }
  }
  async journalPut(operation: string, entry: JournalEntry): Promise<void> {
    await mkdir(this.journalRoot, { recursive: true, mode: 0o700 });
    const name = this.journalName(operation), temporary = `${name}.${crypto.randomUUID()}`;
    const store = new NativeStorage(this.journalRoot, this.journalRoot);
    const { bytes, ...metadata } = entry;
    await store.write(temporary, jsonBytes({ ...metadata, base64: Buffer.from(bytes).toString('base64') }), false);
    await rename(await contained(this.journalRoot, temporary), await contained(this.journalRoot, name));
  }
}
