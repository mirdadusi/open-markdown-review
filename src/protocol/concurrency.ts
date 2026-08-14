export const DEFAULT_IO_CONCURRENCY = 4;

/**
 * Maps values with a fixed number of workers. Shared and synchronized folders
 * are commonly slower when hundreds of reads are issued at once, especially on
 * Windows where antivirus scanning can amplify every operation.
 */
export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("I/O concurrency must be a positive integer.");
  const result = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      result[index] = await worker(values[index], index);
    }
  }));
  return result;
}
