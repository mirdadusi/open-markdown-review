import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPdfRevision, pdfRevisionChoices } from '../src/professional/exportRevisions';
import { commentFixture, initiator } from './commentEdits.fixture';
import { authorReview } from '../src/professional/authoring';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

test('PDF defaults to the unique newest verified head, not the displayed older snapshot', async () => {
  const f = await commentFixture(); await writeFile(path.join(f.source, 'index.md'), '# Newest publication\n');
  const next = await authorReview({ source: f.source, store: f.root, rootDocument: 'index.md', actor: initiator, operationId: 'next_export', parents: [f.origin], journalRoot: f.journal, clientArtifact: path.resolve('dist/OpenMarkdownReview.html') });
  await f.session.refresh(); const choices = pdfRevisionChoices(f.session.revisions.values(), f.session.events);
  assert.equal(f.session.revision!.id, f.origin); assert.equal(defaultPdfRevision(choices), next.revisionId);
  assert.equal(choices.find(c => c.id === f.origin)!.comments, 1); assert.equal(choices.find(c => c.id === f.origin)!.replies, 2);
  assert.equal(choices.find(c => c.id === next.revisionId)!.comments, 0);
  const competing = [...f.session.revisions.values()].find(r => r.id === next.revisionId)!;
  const branches = pdfRevisionChoices([...f.session.revisions.values(), { ...competing, id: 'competing_head', createdAt: '2099-01-01T00:00:00.000Z' }], f.session.events);
  assert.equal(defaultPdfRevision(branches), undefined, 'A later clock timestamp is not branch authority.');
  assert.equal(defaultPdfRevision([]), undefined);
});
