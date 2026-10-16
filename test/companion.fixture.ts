import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorReview } from '../src/professional/authoring';
import { startCompanion } from '../src/professional/companion';
import { NativeStorage } from '../src/professional/nativeStorage';
import { ReviewSession } from '../src/professional/session';
import { decode, pointAt } from '../src/professional/bytes';
import { CompanionTarget } from '../src/professional/companionTargets';

export async function companionFixture(options: { companionTargets?: CompanionTarget[] } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omr-companion-')), source = path.join(temporary, 'source'), root = path.join(temporary, 'review');
  await mkdir(source);
  await writeFile(path.join(source, 'index.md'), '# Companion review\n\nFrozen paragraph for collaborative review.\n\n[Second document](second.md)\n\n| Requirement | State |\n|---|---|\n| Offline review | Required |\n\n![Frozen diagram](image.svg)\n\n```mermaid\nflowchart LR\n A[Read] --> B[Review]\n```\n');
  await writeFile(path.join(source, 'second.md'), '# Second document\n\nReferences are frozen.\n');
  await writeFile(path.join(source, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#2458a6"/></svg>');
  const artifact = path.resolve('dist/OpenMarkdownReview.html'), creator = { id: 'creator@example.com', displayName: 'Review Creator' };
  const created = await authorReview({ source, store: root, rootDocument: 'index.md', title: 'Companion fixture', actor: creator, reviewerEmails: ['alex@example.com', 'sam@example.com'], operationId: 'companion_fixture', journalRoot: path.join(temporary, 'author-journal'), clientArtifact: artifact, companionTargets: options.companionTargets });
  if (created.outcome !== 'completed') throw new Error(created.error ?? 'Companion fixture creation failed.');
  const store = new NativeStorage(root, path.join(temporary, 'test-journal')), session = new ReviewSession(store); await session.open();
  const text = decode(await session.content(session.revision!.documents.find(d => d.path === 'index.md')!)), start = text.indexOf('Frozen paragraph'), exact = 'Frozen paragraph';
  const anchor = { document: 'index.md', documentDigest: session.revision!.documents.find(d => d.path === 'index.md')!.digest, range: { start: pointAt(text, start), end: pointAt(text, start + exact.length) }, quote: { exact }, target: { kind: 'text' as const } };
  const html = await readFile(artifact, 'utf8');
  const helper = await startCompanion({ root, journalRoot: path.join(temporary, 'helper-journal'), html });
  const token = new URLSearchParams(new URL(helper.url).hash.slice(1)).get('omr-session')!;
  const rpc = async (method: string, args: unknown[] = []) => {
    const response = await fetch(helper.origin + '/api/rpc', { method: 'POST', headers: { Origin: helper.origin, 'Content-Type': 'application/json', 'X-OMR-Session': token }, body: JSON.stringify({ method, args }) });
    return await response.json() as { ok: boolean; code?: string; error?: string; value?: any };
  };
  const sendEvent = async (event: unknown) => {
    const { digest, jsonBytes } = await import('../src/professional/bytes'); const bytes = jsonBytes(event);
    return rpc('write', [`events/${digest(bytes).slice(7)}.json`, Buffer.from(bytes).toString('base64'), false]);
  };
  return { temporary, source, root, creator, store, session, anchor, html, helper, token, rpc, sendEvent };
}
