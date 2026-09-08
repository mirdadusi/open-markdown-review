import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { ActorRef, CAPABILITIES, Event, LIMITS, Manifest, Policy, ProtocolError, Revision } from './types';
import { decode, digest, encode, jsonBytes, newId, parseJson, safePath } from './bytes';
import { contained, NativeStorage } from './nativeStorage';
import { blobEvidence, contentRef, evidence, publish, publishBlob, readOptional } from './storage';
import { inspect, validate } from './validation';
import { ReviewSession } from './session';
import { findMarkdownFiles, sanitizeExternalUri } from '../protocol/snapshot';
import { mapWithConcurrency } from '../protocol/concurrency';
import mermaidPackage from 'mermaid/package.json';
import { checkpoint, OperationControl } from './operation';

export interface AuthorRequest extends OperationControl {
  source: string; store: string; title?: string; include?: string[]; includeDir?: string[]; exclude?: string[];
  rootDocument: string; actor: ActorRef; operationId: string; parents?: string[]; resourceRoots?: string[];
  policy?: Policy; dryRun?: boolean; resume?: boolean; clientArtifact: string; journalRoot: string;
}
export interface AuthorResult { reviewId: string; revisionId?: string; store: string; browserClientPath: string; documentPaths: string[]; outcome: 'planned' | 'completed' | 'already-completed' | 'review-created-client-failed'; error?: string }
interface Plan { fingerprint: string; manifest: Manifest; revision: Revision; publication: Event; blobs: Array<{ path: string; mediaType: string }> }
function isInside(root: string, target: string) { const p = path.relative(root, target); return p !== '..' && !p.startsWith(`..${path.sep}`) && !path.isAbsolute(p); }
function media(reference: string, supplied?: string | null): string {
  const type = supplied?.split(';')[0].trim();
  return type && type !== 'application/octet-stream' ? type : ({ '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json', '.html': 'text/html', '.js': 'application/javascript' }[path.extname(reference.split(/[?#]/)[0]).toLowerCase()] ?? 'application/octet-stream');
}
export async function scope(request: AuthorRequest): Promise<string[]> {
  const available = await findMarkdownFiles(request.source);
  const requested = request.include ?? [], dirs = request.includeDir ?? [];
  for (const p of [...requested, ...dirs, ...(request.exclude ?? [])]) safePath(p);
  const within = (p: string, directory: string) => p === directory || p.startsWith(directory + '/');
  for (const p of requested) if (!available.includes(p)) throw new ProtocolError('invalid', `Selected document not found: ${p}`);
  for (const d of dirs) if (!available.some(p => within(p, d))) throw new ProtocolError('invalid', `Selected folder has no Markdown: ${d}`);
  const files = available.filter(p => (!requested.length && !dirs.length || requested.includes(p) || dirs.some(d => within(p, d))) && !(request.exclude ?? []).some(d => within(p, d)) && !isInside(path.resolve(request.store), path.resolve(request.source, p)));
  if (!files.length || files.length > LIMITS.documents) throw new ProtocolError('invalid', 'Scope must contain between 1 and 100 Markdown files.');
  if (!files.includes(request.rootDocument)) throw new ProtocolError('invalid', 'The root document must be included.');
  return files;
}
async function capture(reference: string, document: string, request: AuthorRequest): Promise<{ bytes: Uint8Array; mediaType: string; sourceKind: Revision['resources'][number]['sourceKind'] }> {
  checkpoint(request, `Capturing resource for ${document}`);
  if (reference.startsWith('data:')) {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(reference); if (!match) throw new ProtocolError('invalid', 'Malformed data URI.');
    const bytes = match[2] ? Buffer.from(match[3], 'base64') : encode(decodeURIComponent(match[3]));
    if (bytes.length > LIMITS.resource) throw new ProtocolError('unsupported', 'Data image exceeds resource limit.');
    return { bytes, mediaType: match[1], sourceKind: 'data' };
  }
  if (/^https?:/i.test(reference)) {
    let url = new URL(reference); const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
    try {
      for (let hops = 0; hops <= 5; hops++) {
        if (url.protocol !== 'https:' || url.username || url.password || [...url.searchParams.keys()].some(k => /token|sig|secret|auth|api[-_]?key/i.test(k))) throw new ProtocolError('invalid', 'External capture requires HTTPS without credential/secret parameters. Remove secrets from Markdown before publishing.');
        const response = await fetch(url, { redirect: 'manual', signal: request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) { await response.body?.cancel(); const next = response.headers.get('location'); if (!next || hops === 5) throw new ProtocolError('invalid', 'Remote redirect limit exceeded.'); url = new URL(next, url); continue; }
        if (!response.ok || !response.body) throw new ProtocolError('missing', `External resource returned HTTP ${response.status}.`);
        if (Number(response.headers.get('content-length')) > LIMITS.resource) { await response.body.cancel(); throw new ProtocolError('unsupported', 'Remote resource exceeds 20 MiB.'); }
        const chunks: Uint8Array[] = []; let size = 0; const reader = response.body.getReader();
        while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > LIMITS.resource) { await reader.cancel(); throw new ProtocolError('unsupported', 'Remote resource exceeds 20 MiB.'); } chunks.push(part.value); }
        const bytes = new Uint8Array(size); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
        return { bytes, mediaType: media(url.pathname, response.headers.get('content-type')), sourceKind: 'remote' };
      }
    } catch (error) { checkpoint(request); throw error; }
    finally { clearTimeout(timeout); }
    throw new ProtocolError('invalid', 'Unresolved remote resource.');
  }
  const relative = decodeURIComponent(reference.split(/[?#]/)[0]), target = path.resolve(request.source, path.dirname(document), relative);
  const roots = [request.source, ...(request.resourceRoots ?? [])].map(r => path.resolve(r));
  const root = roots.find(r => isInside(r, target)); if (!root) throw new ProtocolError('permission', `Resource is outside explicitly granted roots: ${reference}`);
  const bytes = await new NativeStorage(root, request.journalRoot).read(path.relative(root, target).split(path.sep).join('/'), LIMITS.resource);
  return { bytes, mediaType: media(reference), sourceKind: root === roots[0] ? 'workspace' : 'granted-root' };
}
/** The only source-to-review authoring service; GUI and CLI call this same contract. */
export async function authorReview(request: AuthorRequest): Promise<AuthorResult> {
  checkpoint(request, 'Planning the selected Markdown scope');
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(request.operationId)) throw new ProtocolError('invalid', 'Creation operation ID must be filename-safe (1–96 characters).');
  const store = new NativeStorage(request.store, request.journalRoot);
  const stagedRoot = path.join(request.journalRoot, 'authoring', digest(`${store.identity}\0${request.operationId}`).slice(7));
  const staged = new NativeStorage(stagedRoot, path.join(request.journalRoot, 'publication'));
  const prior = request.dryRun ? undefined : await readOptional(staged, 'plan.json', LIMITS.revision * 2);
  const savedPlan = prior ? parseJson<Plan>(prior, LIMITS.revision * 2) : undefined;
  const intent = request.dryRun || prior ? undefined : await readOptional(staged, 'intent.json', LIMITS.manifest * 2);
  const started = intent ? parseJson<{ fingerprint: string; manifest: Manifest; documentPaths: string[] }>(intent, LIMITS.manifest * 2) : undefined;
  const documentPaths = savedPlan?.revision.documents.map(d => d.path) ?? started?.documentPaths ?? await scope(request);
  const result: AuthorResult = { reviewId: '', store: path.resolve(request.store), browserClientPath: path.join(path.resolve(request.store), 'OpenMarkdownReview.html'), documentPaths, outcome: 'planned' };
  const fingerprint = digest(jsonBytes({ source: path.resolve(request.source), store: path.resolve(request.store), title: request.title, documentPaths, include: request.include, includeDir: request.includeDir, exclude: request.exclude, rootDocument: request.rootDocument, actor: request.actor, parents: request.parents, policy: request.policy, resourceRoots: request.resourceRoots }));
  if (request.dryRun) {
    validate('policy', request.policy ?? { schemaVersion: '0.5.0', kind: 'review-policy', mode: 'assertions-only' });
    // Reads local Markdown only. No capture, output directory, journal or network access.
    for (const p of documentPaths) { checkpoint(request, `Planning ${p}`); inspect(decode(await new NativeStorage(request.source, request.journalRoot).read(p, LIMITS.markdown)), p); }
    return result;
  }
  let plan: Plan;
  if (prior) {
    if (!request.resume) throw new ProtocolError('changed', 'This operation already has a saved plan. Use --resume with matching parameters.');
    plan = parseJson<Plan>(prior, LIMITS.revision * 2);
    if (plan.fingerprint !== fingerprint) throw new ProtocolError('changed', 'Resume parameters differ from the saved creation plan.');
  } else {
    if (started && (!request.resume || started.fingerprint !== fingerprint)) throw new ProtocolError('changed', 'Capture already started. Resume the original operation with matching parameters.');
    const existing = await readOptional(store, 'manifest.json', LIMITS.manifest);
    let manifest: Manifest; let parents = request.parents ?? [];
    if (existing) {
      if (request.parents === undefined) throw new ProtocolError('invalid', 'This folder already contains a review. Use revision create with explicit parents.');
      manifest = validate('manifest', parseJson(existing, LIMITS.manifest));
      const session = new ReviewSession(store); await session.open();
      if (session.diagnostics.length || parents.some(p => !session.revisions.has(p))) throw new ProtocolError('invalid', 'Parent revisions are unavailable or invalid.');
      if (!parents.length) throw new ProtocolError('invalid', 'An existing review requires explicit parent revision IDs.');
    } else {
      let contents: string[] = []; try { contents = await readdir(request.store); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (contents.length) throw new ProtocolError('invalid', 'A new review requires an empty or nonexistent target directory.');
      if (parents.length) throw new ProtocolError('invalid', 'A new review cannot have parents.');
      manifest = started?.manifest ?? validate('manifest', { protocol: 'open-markdown-review', protocolVersion: '0.5.0', reviewId: newId('review'), title: request.title?.trim() || path.basename(request.source), createdAt: new Date().toISOString(), createdBy: request.actor, documents: documentPaths, eventDirectory: 'events', revisionDirectory: 'revisions', blobDirectory: 'blobs/sha256', exportDirectory: 'exports', eventLayout: 'sha256-flat-v1', identityProfile: 'self-asserted-v1', limitsProfile: 'pilot-v1', creationOperationId: request.operationId, capabilities: [...CAPABILITIES], requiredCapabilities: [...CAPABILITIES] });
    }
    checkpoint(request);
    await mkdir(stagedRoot, { recursive: true, mode: 0o700 });
    if (!started) await staged.write('intent.json', jsonBytes({ fingerprint, manifest, documentPaths }), false);
    else if (digest(jsonBytes(started.manifest)) !== digest(jsonBytes(manifest))) throw new ProtocolError('changed', 'The review changed since this capture started.');
    const blobs = new Map<string, { path: string; mediaType: string }>();
    const put = async (bytes: Uint8Array, mediaType: string) => { const f = blobEvidence(bytes, mediaType); await publish(staged, f.digest, f, bytes); blobs.set(f.path, { path: f.path, mediaType }); return contentRef(f); };
    const documents: Revision['documents'] = [], resources: Revision['resources'] = [], diagrams: Revision['mermaidDiagrams'] = [], references: Revision['externalReferences'] = [];
    for (const document of documentPaths) {
      checkpoint(request, `Capturing ${document}`);
      const documentCheckpoint = `capture/document_${digest(document).slice(7)}.json`, savedDocument = await readOptional(staged, documentCheckpoint, LIMITS.event);
      let frozen: Revision['documents'][number];
      if (savedDocument) frozen = parseJson(savedDocument);
      else { frozen = { path: document, ...await put(await new NativeStorage(request.source, request.journalRoot).read(document, LIMITS.markdown), 'text/markdown') }; await staged.write(documentCheckpoint, jsonBytes(frozen), false); }
      const bytes = await staged.read(frozen.blobPath, LIMITS.markdown);
      if (digest(bytes) !== frozen.digest || bytes.length !== frozen.byteLength) throw new ProtocolError('integrity', 'Saved capture bytes changed.');
      blobs.set(frozen.blobPath, { path: frozen.blobPath, mediaType: frozen.mediaType });
      const parsed = inspect(decode(bytes), document);
      documents.push(frozen); diagrams.push(...parsed.diagrams);
      for (const ref of parsed.references) {
        checkpoint(request);
        if (resources.some(r => r.id === ref.id)) continue;
        const resourceCheckpoint = `capture/${ref.id}.json`, savedResource = await readOptional(staged, resourceCheckpoint, LIMITS.event);
        if (savedResource) { const resource = parseJson<Revision['resources'][number]>(savedResource); resources.push(resource); blobs.set(resource.blobPath, { path: resource.blobPath, mediaType: resource.mediaType }); continue; }
        const captured = await capture(ref.reference, document, request);
        if (ref.role === 'image' && !/^image\/(?:png|jpeg|gif|webp|svg\+xml)$/.test(captured.mediaType)) throw new ProtocolError('unsupported', `Unsupported frozen image: ${captured.mediaType}`);
        if (ref.role === 'attachment' && !/^(?:application\/pdf|text\/plain|application\/json|application\/vnd\.)/.test(captured.mediaType)) throw new ProtocolError('unsupported', `Attachment type is not allowed: ${captured.mediaType}`);
        const resource = { id: ref.id, document, originalReference: sanitizeExternalUri(ref.reference), sourceKind: captured.sourceKind, role: ref.role, capturedAt: new Date().toISOString(), ...await put(captured.bytes, captured.mediaType) };
        await staged.write(resourceCheckpoint, jsonBytes(resource), false); resources.push(resource);
      }
      for (const token of parsed.tokens) for (const child of token.children ?? []) {
        const uri = child.type === 'link_open' ? child.attrGet('href') : undefined;
        if (uri && /^https?:/.test(uri) && child.attrGet('title') !== 'review:attach') references.push({ id: `reference_${digest(`${document}\0${uri}`).slice(7, 31)}`, document, uri: sanitizeExternalUri(uri), relation: 'link' });
      }
    }
    const policy = validate('policy', request.policy ?? { schemaVersion: '0.5.0', kind: 'review-policy', mode: 'assertions-only' });
    const revision = validate('revision', { schemaVersion: '0.5.0', id: newId('revision'), reviewId: manifest.reviewId, createdAt: new Date().toISOString(), createdBy: request.actor, rootDocument: request.rootDocument, documents, resources, externalReferences: [...new Map(references.map(r => [r.id, r])).values()], mermaidDiagrams: diagrams, diagnostics: [], renderer: { markdownProfile: 'commonmark-gfm', mermaidVersion: mermaidPackage.version }, parents, policy: await put(jsonBytes(policy), 'application/json'), creationOperationId: request.operationId });
    const publication = validate('event', { schemaVersion: '0.5.0', id: newId(), type: 'revision.created', reviewId: manifest.reviewId, revisionId: revision.id, revisionDigest: digest(jsonBytes(revision)), revisionPath: `revisions/${revision.id}.json`, occurredAt: new Date().toISOString(), actor: request.actor, operationId: `${request.operationId}_publication` });
    plan = { fingerprint, manifest, revision, publication, blobs: [...blobs.values()] };
    await staged.write('plan.json', jsonBytes(plan), false);
  }
  checkpoint(request, 'Publishing captured content; the revision is not yet visible');
  await mkdir(request.store, { recursive: true });
  const old = await readOptional(store, 'manifest.json', LIMITS.manifest);
  if (old && digest(old) !== digest(jsonBytes(plan.manifest))) throw new ProtocolError('integrity', 'Target contains another manifest.');
  if (!old) await publish(store, `${plan.manifest.creationOperationId}_manifest`, evidence('manifest.json', jsonBytes(plan.manifest), 'application/json'), jsonBytes(plan.manifest));
  for (const dir of ['events', 'revisions', 'exports']) await mkdir(path.join(request.store, dir), { recursive: true });
  await mapWithConcurrency(plan.blobs, 4, async blob => { checkpoint(request); const bytes = await staged.read(blob.path, LIMITS.content); checkpoint(request); await publish(store, blob.path, evidence(blob.path, bytes, blob.mediaType), bytes); });
  checkpoint(request);
  const revisionBytes = jsonBytes(plan.revision); await publish(store, `${request.operationId}_descriptor`, evidence(`revisions/${plan.revision.id}.json`, revisionBytes, 'application/json'), revisionBytes);
  checkpoint(request, 'Final publication started; finishing the review and entry file safely');
  // After this boundary, cancellation cannot truthfully mean "not published".
  // Finish and report the actual outcome instead of abandoning a valid review.
  const eventBytes = jsonBytes(plan.publication); await publish(store, plan.publication.operationId, evidence(`events/${digest(eventBytes).slice(7)}.json`, eventBytes, 'application/json'), eventBytes);
  const attrs = encode('# Exact review evidence: never normalize, filter, or re-encode.\n* -text -filter -working-tree-encoding\n**/* -text -filter -working-tree-encoding\n');
  if (!await readOptional(store, '.gitattributes', 1048576)) await store.write('.gitattributes', attrs, false);
  Object.assign(result, { reviewId: plan.manifest.reviewId, revisionId: plan.revision.id, outcome: 'completed' });
  try { await installClient(store, request.clientArtifact); }
  catch (error) { result.outcome = 'review-created-client-failed'; result.error = String(error); }
  return result;
}
export async function installClient(store: NativeStorage, artifact: string): Promise<string> {
  const bytes = await readFile(artifact);
  if (!decode(bytes).includes('name="open-markdown-review-portable-client"')) throw new ProtocolError('invalid', 'Not a bundled portable review client.');
  const old = await readOptional(store, 'OpenMarkdownReview.html', 64 * 1024 * 1024);
  if (old) { if (digest(old) === digest(bytes)) return path.join(store.root, 'OpenMarkdownReview.html'); throw new ProtocolError('changed', 'HTML already exists with different bytes. Keep a backup and explicitly approve a trusted update; it is not silently replaced.'); }
  await store.write('OpenMarkdownReview.html', bytes, false);
  if (digest(await store.read('OpenMarkdownReview.html', bytes.length)) !== digest(bytes)) throw new ProtocolError('uncertain', 'Client installation could not be verified.');
  return path.join(store.root, 'OpenMarkdownReview.html');
}
/** Only an explicitly expected current hash authorizes replacement of executable HTML. */
export async function updateClient(store: NativeStorage, artifact: string, expectedDigest: string): Promise<{ path: string; backupPath?: string }> {
  const bytes = await readFile(artifact);
  if (!decode(bytes).includes('name="open-markdown-review-portable-client"')) throw new ProtocolError('invalid', 'The installed client artifact is not recognized.');
  const old = await store.read('OpenMarkdownReview.html', 64 * 1024 * 1024), oldDigest = digest(old);
  if (oldDigest !== expectedDigest) throw new ProtocolError('changed', 'HTML changed since update confirmation. No replacement was made.');
  if (oldDigest === digest(bytes)) return { path: path.join(store.root, 'OpenMarkdownReview.html') };
  const backupPath = `client-backups/${oldDigest.slice(7)}.html`;
  await publish(store, `client_backup_${oldDigest.slice(7)}`, evidence(backupPath, old, 'text/html'), old);
  const updateId = newId('client_update'), temporary = `client-backups/${updateId}.html`;
  await publish(store, updateId, evidence(temporary, bytes, 'text/html'), bytes);
  if (digest(await store.read('OpenMarkdownReview.html', 64 * 1024 * 1024)) !== expectedDigest) throw new ProtocolError('changed', 'HTML changed during the update. The backup was retained.');
  // Backup and closed, verified temporary file precede the one atomic replacement.
  await rename(await contained(store.root, temporary), await contained(store.root, 'OpenMarkdownReview.html'));
  if (digest(await store.read('OpenMarkdownReview.html', bytes.length)) !== digest(bytes)) throw new ProtocolError('uncertain', 'Updated HTML could not be verified. The prior file remains in client-backups.');
  return { path: path.join(store.root, 'OpenMarkdownReview.html'), backupPath: path.join(store.root, backupPath) };
}
