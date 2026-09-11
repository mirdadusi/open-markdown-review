import path from 'node:path';

/** VS Code uses case-insensitive file identity on Windows; keep display paths intact. */
export function reviewPathKey(value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.win32.resolve(value).toLowerCase() : path.posix.resolve(value);
}
export function sameReviewPath(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && reviewPathKey(a) === reviewPathKey(b);
}
export function uniqueReviewPaths(values: Iterable<string>): string[] {
  const paths = new Map<string, string>();
  for (const value of values) if (!paths.has(reviewPathKey(value))) paths.set(reviewPathKey(value), value);
  return [...paths.values()];
}
