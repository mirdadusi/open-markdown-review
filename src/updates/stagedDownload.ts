import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { DownloadOptions, downloadVerifiedVsix } from './githubReleaseClient';
import { UpdateDownloadResult } from './types';

/** A unique private file, never an installer input before exact SHA-256 passes. */
export async function stageVerifiedVsix(directory: string, options: DownloadOptions): Promise<{ result: UpdateDownloadResult; file?: string }> {
  if (!path.isAbsolute(directory)) throw new Error('Update staging requires an absolute private directory.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(directory, 'download-')), file = path.join(temporary, 'verified-update.vsix');
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  let verified = false;
  try {
    const result = await downloadVerifiedVsix({ ...options, writeChunk: async bytes => {
      let offset = 0;
      while (offset < bytes.length) { const part = await handle.write(bytes, offset); if (!part.bytesWritten) throw new Error('Update staging made no progress.'); offset += part.bytesWritten; }
    } });
    if (result.kind === 'streamed') { await handle.sync(); verified = true; return { result, file }; }
    return { result };
  } finally {
    await handle.close();
    if (!verified) { await unlink(file); await rmdir(temporary); }
  }
}
