import { execFile } from 'node:child_process';

/** Read credentials without logging them or passing them as command arguments. */
export function githubCliToken(host: string): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('gh', ['auth', 'token', '--hostname', host], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 },
      (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
  });
}
