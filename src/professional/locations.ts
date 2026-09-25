import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

const TRANSIENT_SEGMENTS = new Set(['.local-preview']);

/** Review packages must not live below generated preview trees that can be recreated. */
export function transientReviewLocation(candidate: string): string | undefined {
  const resolved = path.resolve(candidate);
  const segments = resolved.split(path.sep).filter(Boolean);
  const marker = segments.find(segment => TRANSIENT_SEGMENTS.has(segment.toLowerCase()));
  return marker ? `the generated ${marker} tree` : undefined;
}

/** Choose a missing or empty default without reusing a partial package from an earlier operation. */
export async function nextReviewStorageRoot(source: string): Promise<string> {
  for (let ordinal = 1; ordinal <= 100; ordinal++) {
    const candidate = path.join(source, ordinal === 1 ? '.review' : `.review-${ordinal}`);
    try {
      const info = await lstat(candidate);
      if (info.isDirectory() && !info.isSymbolicLink() && (await readdir(candidate)).length === 0) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
      throw error;
    }
  }
  throw new Error('No available default review folder was found. Choose an empty package folder explicitly.');
}
