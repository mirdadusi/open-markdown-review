import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { authorReview } from '../src/professional/authoring';
import { FindingPublisher } from '../src/professional/findingPublication';
import { ReviewSession } from '../src/professional/session';
import { NativeStorage } from '../src/professional/nativeStorage';

export const actor = { id: 'creator@example.com', displayName: 'Review Initiator' };
export async function findingFixture(artifact = path.resolve('dist/OpenMarkdownReview.html'), rich = false) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'omr-finding-workflow-'));
  const source = path.join(temp, 'source'), root = path.join(temp, 'review'), journalRoot = path.join(temp, 'journal');
  await mkdir(source); await writeFile(path.join(source, 'a.md'), '# Design\n\nOriginal concern.\n'); await writeFile(path.join(source, 'b.md'), '# Other\n\nOld chapter.\n');
  if (rich) {
    await writeFile(path.join(source, 'a.md'), '# Design\n\nOriginal concern.\n\n| Item | Value |\n| --- | --- |\n| Original | 1 |\n\n```mermaid\nflowchart LR\n  A[Original] --> B[Outcome]\n```\n\n![Frozen picture](picture.svg)\n\n[Other chapter](b.md)\n');
    await writeFile(path.join(source, 'picture.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><rect width="100" height="40" fill="blue"/></svg>');
  }
  const created = await authorReview({ source, store: root, rootDocument: 'a.md', actor, operationId: 'create_finding_fixture', clientArtifact: artifact, journalRoot });
  const store = new NativeStorage(root, journalRoot), session = new ReviewSession(store); await session.open();
  const origin = created.revisionId!;
  for (const [index, document] of ['a.md', 'b.md'].entries()) {
    const ctx = session.context(actor), doc = ctx.revision.documents.find(d => d.path === document)!;
    const quote = index ? 'Old chapter.' : 'Original concern.';
    await session.save(ctx, session.makeEvent(ctx, { type: 'comment.created', threadId: `finding_${index}`, commentId: `comment_${index}`, anchor: { document, documentDigest: doc.digest, range: { start: { line: 2, character: 0 }, end: { line: 2, character: quote.length } }, quote: { exact: quote }, target: { kind: 'text' } }, body: { format: 'markdown', text: `Please update the complete ${document} document.` } }));
    await session.save(ctx, session.makeEvent(ctx, { type: 'thread.decided', threadId: `finding_${index}`, decision: 'accepted', decisionPredecessors: [] }));
    await session.save(ctx, session.makeEvent(ctx, { type: 'thread.resolved', threadId: `finding_${index}`, statusPredecessors: [] }));
  }
  const options = { root, source, journalRoot, artifact: path.join(temp, 'intentionally-not-installed.html') };
  return { temp, source, root, journalRoot, created, store, session, origin, options, publisher: new FindingPublisher(options) };
}
export async function rewrite(source: string) {
  await writeFile(path.join(source, 'a.md'), '# Redesigned document\n\nA completely rewritten section.\n\n## New explanation\n\nImplementation details.\n');
  await writeFile(path.join(source, 'b.md'), '# Reorganized chapter\n\nThe whole second document changes too.\n');
}
