import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateManifest } from './protocol/validation';
import { validate } from './professional/validation';
import { IoLimiter } from './professional/storage';
import { mapWithConcurrency } from './protocol/concurrency';

/** Local coordination only. Other processes/machines must stop writing before deletion. */
export class ReviewActivity {
  private busy = 0;
  private removing = false;
  begin(): () => void {
    if (this.removing) throw new Error('Review removal is in progress. Try again when it finishes.');
    this.busy++;
    return () => { this.busy--; };
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const finish = this.begin();
    try { return await operation(); } finally { finish(); }
  }
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.removing || this.busy) throw new Error('A review operation is still in progress. Finish it before removing a review.');
    this.removing = true;
    try { return await operation(); } finally { this.removing = false; }
  }
}

export interface RemovalTarget { root: string; title: string; reviewId?: string; protectedPaths: string[] }
export interface RemovalPlan { root: string; title: string; reviewId: string; files: number; directories: number; bytes: number; fingerprint: string }
const folders = new Set(['events', 'revisions', 'blobs', 'exports', 'client-backups']);
const files = new Set(['manifest.json', '.gitattributes', 'OpenMarkdownReview.html', '.DS_Store', 'desktop.ini', 'Thumbs.db']);
const within = (parent: string, child: string) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };

/** Enumerate the entire dedicated package, never follow links or accept project/source roots. */
export async function inspectReviewRemoval(target: RemovalTarget): Promise<RemovalPlan> {
  if (!path.isAbsolute(target.root)) throw new Error('Review deletion requires an absolute folder path.');
  const requested = path.resolve(target.root), initial = await lstat(requested);
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error('The review folder must be a real directory, not a symbolic link or junction.');
  const root = await realpath(requested);
  for (const protectedPath of [path.parse(root).root, os.homedir(), ...target.protectedPaths]) {
    const canonical = await realpath(protectedPath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return path.resolve(protectedPath); throw error; });
    if (within(root, canonical)) throw new Error('Cannot delete a source, workspace, home or filesystem root. Open its parent/source workspace if the review itself is the workspace. Use Remove Review from List instead.');
  }
  const inventory: Array<[string, string, number, number, number, number, number]> = [];
  const io = new IoLimiter(4);
  let fileCount = 0, directoryCount = 0, bytes = 0;
  async function visit(absolute: string, relative: string, depth: number): Promise<void> {
    if (inventory.length >= 100_000 || depth > 32) throw new Error('Review is too large to safely inspect for deletion. Manage this folder manually.');
    const stat = await io.run(() => lstat(absolute));
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Unsafe linked or special entry: ${relative || root}`);
    const name = path.basename(absolute);
    if (relative && (name === '.git' || name.includes('.tmp-') || name.endsWith('.tmp'))) throw new Error(`Project metadata or an unfinished write is present: ${relative}`);
    if (depth === 1 && !(stat.isDirectory() ? folders : files).has(name)) throw new Error(`Not a dedicated review folder: unexpected entry ${relative}. Nothing will be deleted.`);
    if (inventory.length >= 100_000) throw new Error('Review is too large to safely inspect for deletion. Manage this folder manually.');
    inventory.push([relative, stat.isDirectory() ? 'directory' : 'file', stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
    if (stat.isDirectory()) {
      directoryCount++;
      const children = await io.run(() => readdir(absolute));
      await mapWithConcurrency(children, 4, child => visit(path.join(absolute, child), relative ? `${relative}/${child}` : child, depth + 1));
    } else { fileCount++; bytes += stat.size; }
  }
  await visit(root, '', 0);
  inventory.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const manifestPath = path.join(root, 'manifest.json'), manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 1024 * 1024) throw new Error('Invalid review manifest for deletion.');
  const manifestBytes = await readFile(manifestPath), value = JSON.parse(manifestBytes.toString('utf8'));
  const manifest = value.protocolVersion === '0.5.0' ? validate('manifest', value) : (() => {
    const checked = validateManifest(value);
    if (!checked.ok) throw new Error('Invalid or unsupported review manifest. Nothing will be deleted.');
    return checked.value;
  })();
  const final = await lstat(requested);
  if (target.reviewId && manifest.reviewId !== target.reviewId) throw new Error('The registered review was replaced by a different review. Reconnect and inspect it before deletion.');
  if (final.isSymbolicLink() || initial.ino !== final.ino || initial.dev !== final.dev || root !== await realpath(requested)) throw new Error('The review folder changed during inspection. Nothing will be deleted.');
  return { root, title: manifest.title, reviewId: manifest.reviewId, files: fileCount, directories: directoryCount, bytes, fingerprint: createHash('sha256').update(JSON.stringify(inventory)).update(manifestBytes).digest('hex') };
}

export interface RemovalActions {
  confirm(plan?: RemovalPlan): Promise<boolean>;
  close(): void;
  trash(root: string): Promise<void>;
  forget(): Promise<void>;
}

/** Never fall back to permanent deletion. Failed trash leaves the registration available. */
export async function removeReview(target: RemovalTarget, mode: 'forget' | 'trash', actions: RemovalActions): Promise<boolean> {
  const plan = mode === 'trash' ? await inspectReviewRemoval(target) : undefined;
  if (!await actions.confirm(plan)) return false;
  if (plan) {
    const current = await inspectReviewRemoval(target);
    if (current.root !== plan.root || current.fingerprint !== plan.fingerprint) throw new Error('The review changed during confirmation. Nothing was deleted; stop other writers and try again.');
  }
  actions.close();
  if (plan) {
    try { await actions.trash(plan.root); }
    catch (error) { throw new Error(`Could not move the review to Trash/Recycle Bin. No permanent-delete fallback was attempted; the review remains in your list. Check the folder before retrying. ${error instanceof Error ? error.message : String(error)}`); }
  }
  try { await actions.forget(); }
  catch (error) {
    if (plan) throw new Error(`The review at ${plan.root} was moved to Trash/Recycle Bin, but its local list entry could not be updated. Restore it from the OS trash if needed, or remove the stale list entry. ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  return true;
}
