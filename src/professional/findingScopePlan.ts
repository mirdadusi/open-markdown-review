import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { ascii, decode, digest, jsonBytes } from './bytes';
import { NativeStorage } from './nativeStorage';
import { FindingScopePlan, markdownDocumentLinks } from './findingScope';
import { LIMITS, ProtocolError, Revision, SANITIZED_HTML_PROFILE } from './types';
import { checkpoint, interruptible, OperationControl } from './operation';
import { mapWithConcurrency } from '../protocol/concurrency';

/** Bounded read-only graph walk, not repository-wide discovery or resource capture. */
export async function planFindingScope(source: string, review: string, journal: string, parent: Revision, origin: string, parents: string[], heads: string[], title: string, control?: OperationControl): Promise<FindingScopePlan> {
  const sourceRoot = await interruptible(realpath(source), control), initial = await interruptible(lstat(sourceRoot), control);
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new ProtocolError('integrity', 'The editable source root is not a real directory.');
  const storage = new NativeStorage(sourceRoot, journal), prior = new Set(parent.documents.map(doc => doc.path));
  const documents = new Map<string, FindingScopePlan['documents'][number]>(), links: FindingScopePlan['links'] = [];
  const add = (file: string, from?: string) => {
    let doc = documents.get(file);
    if (!doc) {
      if (documents.size >= LIMITS.documents * 2) throw new ProtocolError('unsupported', 'Referenced Markdown discovery exceeds 200 files. Reduce the linked scope or use Advanced setup.');
      doc = { path: file, inReview: prior.has(file), available: false, referencedBy: [] }; documents.set(file, doc);
    }
    if (from && !doc.referencedBy.includes(from)) doc.referencedBy.push(from);
  };
  prior.forEach(file => add(file));
  const scanned = new Set<string>();
  while ([...documents.keys()].some(file => !scanned.has(file))) {
    const batch = [...documents.keys()].filter(file => !scanned.has(file)); batch.forEach(file => scanned.add(file));
    const results = await mapWithConcurrency(batch, 4, async file => {
      checkpoint(control, `Checking Markdown links: ${file}`);
      const relativeToReview = path.relative(path.resolve(review), path.resolve(sourceRoot, ...file.split('/')));
      if (!relativeToReview || relativeToReview !== '..' && !relativeToReview.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToReview)) return { file, problem: 'A source link points inside the frozen review package.' };
      try {
        const bytes = await interruptible(storage.read(file, LIMITS.markdown), control);
        const canonical = path.relative(sourceRoot, await interruptible(realpath(path.join(sourceRoot, ...file.split('/'))), control)).split(path.sep).join('/');
        if (canonical !== file) return { file, problem: 'Link spelling/case differs from the source filename; use the exact portable path.' };
        return { file, digest: digest(bytes), links: markdownDocumentLinks(decode(bytes), file, parent.renderer.markdownProfile === SANITIZED_HTML_PROFILE) };
      } catch (error) {
        if (error instanceof ProtocolError && error.code === 'missing') return { file, problem: 'Linked source Markdown file does not exist.' };
        throw error; // Permissions, links/junctions, changed reads and cancellation never become “missing”.
      }
    });
    for (const result of results) {
      const doc = documents.get(result.file)!;
      if (result.digest) { doc.available = true; doc.digest = result.digest; }
      if (result.problem) for (const link of links.filter(link => link.target === result.file)) link.problem = result.problem;
      for (const link of result.links ?? []) {
        if (links.length >= LIMITS.events) throw new ProtocolError('unsupported', 'Markdown scope discovery exceeds 10,000 local links.');
        links.push(link); if (link.target) add(link.target, result.file);
      }
    }
  }
  // A later edge can target an already scanned missing/case-invalid document.
  for (const link of links) if (link.target && !documents.get(link.target)?.available && !link.problem) link.problem = 'Linked source Markdown file is unavailable; check existence and exact filename/case.';
  const after = await interruptible(lstat(sourceRoot), control);
  if (initial.dev !== after.dev || initial.ino !== after.ino || await interruptible(realpath(source), control) !== sourceRoot) throw new ProtocolError('changed', 'The editable source root changed during scope discovery.');
  const result = { kind: 'finding-scope-v1' as const, originRevisionId: origin, parents, reviewTitle: title, sourceRoot, destination: review, rootDocument: parent.rootDocument,
    documents: [...documents.values()].map(doc => ({ ...doc, referencedBy: doc.referencedBy.sort(ascii) })).sort((a, b) => ascii(a.path, b.path)), links: links.sort((a, b) => ascii(a.document, b.document) || ascii(a.reference, b.reference)) };
  return { ...result, digest: digest(jsonBytes({ ...result, sourceIdentity: `${initial.dev}:${initial.ino}`, parentDigest: digest(jsonBytes(parent)), heads: [...heads].sort(ascii) })) };
}
