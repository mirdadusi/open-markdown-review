import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { mapWithConcurrency } from '../protocol/concurrency';
import { digest } from './bytes';
import { contained, NativeStorage } from './nativeStorage';
import { ReviewSession } from './session';
import { LIMITS, ProtocolError } from './types';

const PACKAGE_DIRECTORIES = new Set(['events', 'revisions', 'blobs', 'exports', 'client-backups']);
const PACKAGE_FILES = new Set(['manifest.json', '.gitattributes', 'OpenMarkdownReview.html', '.DS_Store', 'desktop.ini', 'Thumbs.db']);
const isPackageFile = (name: string) => PACKAGE_FILES.has(name) || /^Review-[A-Za-z0-9._-]{1,64}\.html$/.test(name);
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 32;
const COPY_CHUNK = 1024 * 1024;

export interface PackageFile {
  path: string;
  byteLength: number;
  digest: string;
}

export interface PackageInventory {
  root: string;
  reviewId: string;
  title: string;
  directories: string[];
  files: PackageFile[];
  byteLength: number;
  fingerprint: string;
}

export interface SourceBindingReport {
  sourceRoot: string;
  documents: number;
  exact: string[];
  changed: string[];
  missing: string[];
}

export interface RelocationResult {
  sourceRoot: string;
  destinationRoot: string;
  reviewId: string;
  files: number;
  directories: number;
  byteLength: number;
  fingerprint: string;
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function serial(inventory: Pick<PackageInventory, 'directories' | 'files'>): string {
  return JSON.stringify({ directories: inventory.directories, files: inventory.files });
}

async function hashFile(root: string, relative: string): Promise<PackageFile> {
  const target = await contained(root, relative);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new ProtocolError('invalid', `Not a regular package file: ${relative}`);
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(COPY_CHUNK);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (!bytesRead) throw new ProtocolError('changed', `Package file became shorter while reading: ${relative}`);
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    const after = await handle.stat();
    await contained(root, relative);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new ProtocolError('changed', `Package file changed while reading: ${relative}`);
    return { path: relative, byteLength: before.size, digest: `sha256:${hash.digest('hex')}` };
  } finally { await handle.close(); }
}

/** Exact, link-free inventory for transport. Unknown top-level content is refused. */
export async function inspectReviewPackage(rootInput: string): Promise<PackageInventory> {
  if (!path.isAbsolute(rootInput)) throw new ProtocolError('invalid', 'Review package paths must be absolute.');
  const initial = await lstat(rootInput);
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new ProtocolError('invalid', 'The review package must be a real directory, not a symbolic link or junction.');
  const root = await realpath(rootInput), directories: string[] = [], relativeFiles: string[] = [];
  let entries = 0;
  async function visit(absolute: string, relative: string, depth: number): Promise<void> {
    if (++entries > MAX_ENTRIES || depth > MAX_DEPTH) throw new ProtocolError('unsupported', 'Review package exceeds relocation inventory limits.');
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new ProtocolError('integrity', `Linked or special package entry is not portable: ${relative || root}`);
    if (relative && path.basename(absolute) === '.git') throw new ProtocolError('invalid', `Git metadata must remain outside the dedicated review package: ${relative}`);
    if (depth === 1 && (info.isDirectory() ? !PACKAGE_DIRECTORIES.has(path.basename(absolute)) : !isPackageFile(path.basename(absolute)))) throw new ProtocolError('invalid', `Unexpected top-level package entry: ${relative}`);
    if (info.isFile()) { relativeFiles.push(relative); return; }
    if (relative) directories.push(relative);
    const children = await readdir(absolute);
    await mapWithConcurrency(children, 4, child => visit(path.join(absolute, child), relative ? `${relative}/${child}` : child, depth + 1));
  }
  await visit(root, '', 0);
  directories.sort(); relativeFiles.sort();
  const files = (await mapWithConcurrency(relativeFiles, 4, relative => hashFile(root, relative))).sort((a, b) => a.path.localeCompare(b.path));
  const storage = new NativeStorage(root, path.join(root, '.unused-relocation-journal'));
  const session = new ReviewSession(storage); await session.open(); await session.refresh(true);
  const manifestFile = files.find(file => file.path === 'manifest.json');
  if (!manifestFile) throw new ProtocolError('missing', 'Review package has no manifest.json.');
  const identity = await lstat(rootInput);
  if (identity.isSymbolicLink() || identity.dev !== initial.dev || identity.ino !== initial.ino || await realpath(rootInput) !== root) throw new ProtocolError('changed', 'Review package root changed during inspection.');
  const byteLength = files.reduce((sum, file) => sum + file.byteLength, 0);
  const fingerprint = createHash('sha256').update(serial({ directories, files })).digest('hex');
  return { root, reviewId: session.manifest.reviewId, title: session.manifest.title, directories, files, byteLength, fingerprint };
}

async function prepareEmptyDestination(destinationInput: string): Promise<string> {
  if (!path.isAbsolute(destinationInput)) throw new ProtocolError('invalid', 'The destination must be an absolute folder path.');
  const destination = path.resolve(destinationInput);
  try {
    const info = await lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ProtocolError('invalid', 'The destination must be a real directory, not a link or special file.');
    if ((await readdir(destination)).length) throw new ProtocolError('invalid', 'The destination folder must be empty. Nothing was copied.');
    return await realpath(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = await realpath(path.dirname(destination));
    await mkdir(destination, { mode: 0o700 });
    const created = await lstat(destination), actual = await realpath(destination);
    if (!created.isDirectory() || created.isSymbolicLink() || path.dirname(actual) !== parent) throw new ProtocolError('integrity', 'The destination changed while it was being created.');
    return actual;
  }
}

async function copyExactFile(sourceRoot: string, destinationRoot: string, expected: PackageFile): Promise<void> {
  const source = await contained(sourceRoot, expected.path), destination = await contained(destinationRoot, expected.path, true);
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output;
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size !== expected.byteLength) throw new ProtocolError('changed', `Source package file changed before copying: ${expected.path}`);
    output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(COPY_CHUNK);
    let readPosition = 0;
    while (readPosition < before.size) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - readPosition), readPosition);
      if (!bytesRead) throw new ProtocolError('changed', `Source package file became shorter while copying: ${expected.path}`);
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, readPosition + written);
        if (!result.bytesWritten) throw new ProtocolError('uncertain', `Destination stopped accepting bytes: ${expected.path}`);
        written += result.bytesWritten;
      }
      readPosition += bytesRead;
    }
    await output.sync();
    const after = await input.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || `sha256:${hash.digest('hex')}` !== expected.digest) throw new ProtocolError('changed', `Source package file changed while copying: ${expected.path}`);
  } finally { await output?.close(); await input.close(); }
}

/** Copy a complete package to an empty destination and verify both sides before use. */
export async function relocateReviewPackage(sourceInput: string, destinationInput: string): Promise<RelocationResult> {
  const before = await inspectReviewPackage(sourceInput), destinationResolved = path.resolve(destinationInput);
  if (inside(before.root, destinationResolved) || inside(destinationResolved, before.root)) throw new ProtocolError('invalid', 'Source and destination review folders must not contain one another.');
  const destination = await prepareEmptyDestination(destinationResolved);
  for (const directory of [...before.directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) await mkdir(await contained(destination, directory, true), { mode: 0o700 });
  const manifest = before.files.find(file => file.path === 'manifest.json');
  if (!manifest) throw new ProtocolError('missing', 'Review package has no manifest.json.');
  await mapWithConcurrency(before.files.filter(file => file.path !== 'manifest.json'), 2, file => copyExactFile(before.root, destination, file));
  // A partial destination is not discoverable as a review until every other byte is closed.
  await copyExactFile(before.root, destination, manifest);
  const [sourceAfter, destinationAfter] = await Promise.all([inspectReviewPackage(before.root), inspectReviewPackage(destination)]);
  if (sourceAfter.reviewId !== before.reviewId || sourceAfter.fingerprint !== before.fingerprint || serial(sourceAfter) !== serial(before)) throw new ProtocolError('changed', 'The source review changed during publication. The destination was not activated; stop all writers and publish again to a new empty folder.');
  if (destinationAfter.reviewId !== before.reviewId || destinationAfter.fingerprint !== before.fingerprint || serial(destinationAfter) !== serial(before)) throw new ProtocolError('integrity', 'The destination differs from the source package and was not activated.');
  return { sourceRoot: before.root, destinationRoot: destinationAfter.root, reviewId: before.reviewId, files: before.files.length, directories: before.directories.length, byteLength: before.byteLength, fingerprint: before.fingerprint };
}

/** Inspect a private source binding without writing native paths into review evidence. */
export async function inspectSourceBinding(reviewRoot: string, sourceInput: string, journalRoot: string): Promise<SourceBindingReport> {
  const sourceRoot = await realpath(sourceInput), session = new ReviewSession(new NativeStorage(reviewRoot, journalRoot));
  await session.open(); await session.refresh(true);
  const heads = session.heads;
  if (!heads.length) throw new ProtocolError('missing', 'The review has no verified revision to bind.');
  const expected = new Map<string, Set<string>>();
  for (const revision of heads) for (const document of revision.documents) {
    const digests = expected.get(document.path) ?? new Set<string>(); digests.add(document.digest); expected.set(document.path, digests);
  }
  const storage = new NativeStorage(sourceRoot, journalRoot), exact: string[] = [], changed: string[] = [], missing: string[] = [];
  await mapWithConcurrency([...expected.entries()], 4, async ([document, digests]) => {
    try {
      const bytes = await storage.read(document, LIMITS.markdown);
      (digests.has(digest(bytes)) ? exact : changed).push(document);
    } catch (error) {
      if (error instanceof ProtocolError && error.code === 'missing') missing.push(document);
      else throw error;
    }
  });
  exact.sort(); changed.sort(); missing.sort();
  return { sourceRoot, documents: expected.size, exact, changed, missing };
}
