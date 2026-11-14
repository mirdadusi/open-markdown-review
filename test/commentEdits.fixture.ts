import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorReview } from '../src/professional/authoring';
import { NativeStorage } from '../src/professional/nativeStorage';
import { ReviewSession } from '../src/professional/session';
import { COMMENT_EDITS, Event } from '../src/professional/types';

export const initiator = { id: 'creator@example.com', displayName: 'Initiator' };
export const owner = { id: 'author@example.com', displayName: 'Comment Author' };
export async function commentFixture(legacy = false, artifact = path.resolve('dist/OpenMarkdownReview.html')) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'omr-comment-edits-')), source = path.join(temp, 'source'), root = path.join(temp, 'review'), journal = path.join(temp, 'journal');
  await mkdir(source); await writeFile(path.join(source, 'index.md'), '# Original specification\n\nOriginal reviewed sentence.\n');
  const created = await authorReview({ source, store: root, rootDocument: 'index.md', actor: initiator, operationId: 'create_comments', journalRoot: journal, clientArtifact: artifact });
  if (legacy) {
    // Synthetic older package only, before any receipt/event references this
    // manifest. Production never rewrites an existing review to enable edits.
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    for (const key of ['capabilities', 'requiredCapabilities']) manifest[key] = manifest[key].filter((c: string) => c !== COMMENT_EDITS);
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  const store = new NativeStorage(root, journal), session = new ReviewSession(store); await session.open();
  const origin = created.revisionId!, ctx = session.context(owner), doc = ctx.revision.documents[0];
  const quote = 'Original reviewed sentence.';
  const comment = session.makeEvent(ctx, { type: 'comment.created', threadId: 'edit_thread', commentId: 'edit_comment', anchor: { document: 'index.md', documentDigest: doc.digest, range: { start: { line: 2, character: 0 }, end: { line: 2, character: quote.length } }, quote: { exact: quote }, target: { kind: 'text' } }, body: { format: 'markdown', text: 'Original comment wording.' } });
  await session.save(ctx, comment);
  const reply = session.makeEvent(ctx, { type: 'comment.replied', threadId: 'edit_thread', commentId: 'edit_reply', inReplyTo: 'edit_comment', body: { format: 'markdown', text: 'Original reply wording.' } }); await session.save(ctx, reply);
  const other = session.context({ id: 'other@example.com', displayName: 'Other Reviewer' });
  await session.save(other, session.makeEvent(other, { type: 'comment.replied', threadId: 'edit_thread', commentId: 'other_reply', inReplyTo: 'edit_comment', body: { format: 'markdown', text: 'Another reviewer reply.' } }));
  const edit = (text: string, commentId = 'edit_comment', editPredecessors: string[] = [], actor = owner): Event => session.makeEvent(session.context(actor, origin), { type: 'comment.edited', threadId: 'edit_thread', commentId, body: { format: 'markdown', text }, editPredecessors });
  return { temp, source, root, journal, store, session, created, origin, comment, reply, edit };
}
