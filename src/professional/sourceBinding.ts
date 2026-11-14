import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { mapWithConcurrency } from '../protocol/concurrency';
import { reviewPathKey } from '../reviewPaths';
import { digest, jsonBytes } from './bytes';
import { NativeStorage } from './nativeStorage';
import { ReviewSession } from './session';
import { LIMITS, ProtocolError } from './types';
import { checkpoint, interruptible, OperationControl } from './operation';

export interface SourceBindingReport { sourceRoot: string; documents: number; exact: string[]; changed: string[]; missing: string[] }
export interface SourceBindingSnapshot {
  reviewRoot: string; reviewId: string; title: string; fingerprint: string;
  documents: Array<{ path: string; digests: string[] }>;
}
export interface SourceBindingCheck extends SourceBindingReport { fingerprint: string }
export function sourceWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function directoryIdentity(root: string, control?: OperationControl): Promise<string> {
  const info = await interruptible(lstat(root), control);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ProtocolError('invalid', 'The source/review root was replaced or is not a real directory.');
  return `${info.dev}:${info.ino}`;
}

/** One fresh verified snapshot per discovery pass, not a review scan per folder. */
export async function sourceBindingSnapshot(reviewInput: string, journalRoot: string, control?: OperationControl): Promise<SourceBindingSnapshot> {
  checkpoint(control, 'Verifying review paths and revision heads…');
  const reviewRoot = await interruptible(realpath(reviewInput), control), store = new NativeStorage(reviewRoot, journalRoot);
  const identity = await directoryIdentity(reviewRoot, control);
  const manifest = await interruptible(store.read('manifest.json', LIMITS.manifest), control);
  const session = new ReviewSession(store, message => checkpoint(control, message));
  await interruptible(session.open(), control);
  if (session.diagnostics.some(d => d.severity === 'error')) throw new ProtocolError('integrity', 'The review could not be fully verified for source linking. Resolve its synchronization/integrity errors first.');
  if (!session.heads.length) throw new ProtocolError('missing', 'The review package is incomplete: it has no verified revision publication to bind.');
  if (digest(await interruptible(store.read('manifest.json', LIMITS.manifest), control)) !== digest(manifest)) throw new ProtocolError('changed', 'The review manifest changed during source discovery. No source was linked.');
  if (await directoryIdentity(reviewRoot, control) !== identity || await interruptible(realpath(reviewInput), control) !== reviewRoot) throw new ProtocolError('changed', 'The review folder changed during source discovery. No source was linked.');
  const expected = new Map<string, Set<string>>();
  for (const revision of session.heads) for (const document of revision.documents) {
    const digests = expected.get(document.path) ?? new Set<string>(); digests.add(document.digest); expected.set(document.path, digests);
  }
  const documents = [...expected].sort(([a], [b]) => a.localeCompare(b)).map(([file, digests]) => ({ path: file, digests: [...digests].sort() }));
  const heads = session.heads.map(r => ({ id: r.id, digest: digest(jsonBytes(r)) })).sort((a, b) => a.id.localeCompare(b.id));
  return { reviewRoot, reviewId: session.manifest.reviewId, title: session.manifest.title, documents,
    fingerprint: digest(jsonBytes({ root: reviewPathKey(reviewRoot), identity, manifest: digest(manifest), heads, documents })) };
}

/** Structural match is mandatory; changed bytes are normal when preparing fixes. */
export async function inspectSourceCandidate(snapshot: SourceBindingSnapshot, input: string, journalRoot: string, control?: OperationControl): Promise<SourceBindingCheck> {
  checkpoint(control, `Checking source folder: ${input}`);
  if (!path.isAbsolute(input)) throw new ProtocolError('invalid', 'A source folder must have an absolute native path.');
  const sourceRoot = await interruptible(realpath(input), control);
  const identity = await directoryIdentity(sourceRoot, control);
  if (sourceWithin(snapshot.reviewRoot, sourceRoot)) throw new ProtocolError('permission', 'The review package and its frozen evidence cannot be used as editable source. Choose the original Markdown folder.');
  const storage = new NativeStorage(sourceRoot, journalRoot), exact: string[] = [], changed: string[] = [], missing: string[] = [];
  const observed = await mapWithConcurrency(snapshot.documents, 4, async document => {
    checkpoint(control);
    if (sourceWithin(snapshot.reviewRoot, path.resolve(sourceRoot, ...document.path.split('/')))) throw new ProtocolError('permission', 'A reviewed source path points inside the frozen review package.');
    try {
      const hash = digest(await interruptible(storage.read(document.path, LIMITS.markdown), control));
      (document.digests.includes(hash) ? exact : changed).push(document.path);
      return { path: document.path, digest: hash };
    } catch (error) {
      if (error instanceof ProtocolError && error.code === 'missing') { missing.push(document.path); return { path: document.path, missing: true }; }
      throw error;
    }
  });
  checkpoint(control);
  if (await directoryIdentity(sourceRoot, control) !== identity || await interruptible(realpath(input), control) !== sourceRoot) throw new ProtocolError('changed', 'The source folder changed while its documents were checked.');
  exact.sort(); changed.sort(); missing.sort();
  return { sourceRoot, documents: snapshot.documents.length, exact, changed, missing,
    fingerprint: digest(jsonBytes({ root: reviewPathKey(sourceRoot), identity, observed })) };
}

/** Compatible public helper for manual source binding and existing callers. */
export async function inspectSourceBinding(reviewRoot: string, sourceInput: string, journalRoot: string): Promise<SourceBindingReport> {
  const { fingerprint: _privateFingerprint, ...report } = await inspectSourceCandidate(await sourceBindingSnapshot(reviewRoot, journalRoot), sourceInput, journalRoot);
  return report;
}
