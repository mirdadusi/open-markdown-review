import MarkdownIt from 'markdown-it';
import eventSchema from './generated/event';
import manifestSchema from './generated/manifest';
import revisionSchema from './generated/revision';
import policySchema from './generated/policy';
import verificationSchema from './generated/verification';
import inventorySchema from './generated/inventory';
import folding from './case-folding-15.1.json';
import { ascii, digest, encode, offsetAt, safePath, stableId } from './bytes';
import { Event, Manifest, Revision, Policy, ProtocolError, CAPABILITIES, OPTIONAL_CAPABILITIES, LIMITS, StoredContent, Verification, AuditInventory } from './types';
import { attribute, isAllowedHtmlTag, isAuditedExternalReference, SANITIZED_HTML_PROFILE, scanHtml } from './html';

const schemas = { event: eventSchema, manifest: manifestSchema, revision: revisionSchema, policy: policySchema, verification: verificationSchema, inventory: inventorySchema };
type Shapes = { event: Event; manifest: Manifest; revision: Revision; policy: Policy; verification: Verification; inventory: AuditInventory };
export const caseFold = (value: string): string => [...value].map(c => (folding as Record<string, string>)[c] ?? c).join('');
function requireRule(ok: unknown, message: string): asserts ok { if (!ok) throw new ProtocolError('invalid', message); }
export function validate<K extends keyof Shapes>(kind: K, value: unknown): Shapes[K] {
  const schema = schemas[kind] as ((value: unknown) => boolean) & { errors?: unknown[] };
  if (!schema(value)) throw new ProtocolError('invalid', `${kind}: ${JSON.stringify(schema.errors?.slice(0, 4))}`);
  const walk = (item: unknown, key = ''): void => {
    if (Array.isArray(item)) { item.forEach(v => walk(v, key)); return; }
    if (item && typeof item === 'object') { for (const [k, v] of Object.entries(item)) walk(v, k); return; }
    if (typeof item !== 'string') return;
    if (['occurredAt', 'createdAt', 'capturedAt', 'verifiedAt'].includes(key)) requireRule(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(item), 'Timestamp needs seconds and an explicit timezone.');
    if (['path', 'document', 'rootDocument', 'blobPath', 'revisionPath', 'schemaBlobPath'].includes(key)) safePath(item);
    if (['text', 'reason', 'replacement', 'note'].includes(key)) requireRule(encode(item).length <= LIMITS.text, 'Text exceeds 32 KiB.');
  };
  walk(value);
  const actor = (a: { id: string }) => requireRule(a.id === a.id.trim() && [...a.id].length <= 128 && !/[\x00-\x1f\x7f-\x9f]/.test(a.id), 'Actor ID contains whitespace or controls.');
  if (kind === 'manifest') {
    const m = value as Manifest; actor(m.createdBy);
    requireRule(CAPABILITIES.every(c => m.capabilities.includes(c) && m.requiredCapabilities.includes(c)), 'Missing core capability.');
    requireRule(new Set(m.extensions?.map(e => e.id)).size === (m.extensions?.length ?? 0), 'Duplicate extension declaration.');
    if (m.requiredCapabilities.some(c => ![...CAPABILITIES, ...OPTIONAL_CAPABILITIES].includes(c as typeof CAPABILITIES[number])) || m.extensions?.some(e => e.affectsState)) throw new ProtocolError('unsupported', 'Unsupported required semantics; inspect only.');
    requireRule(m.requiredCapabilities.every(c => m.capabilities.includes(c)), 'Required capabilities must be advertised.');
  }
  if (kind === 'event') {
    const e = value as Event; actor(e.actor);
    if ('verification' in e) checkStored(e.verification);
    if (e.type === 'suggestion.applied') requireRule(e.acceptanceIds.length, 'Application requires acceptance evidence.');
    if (e.type === 'thread.decided' && e.decision !== 'accepted') requireRule(e.reason?.trim(), 'A non-acceptance decision requires a reason.');
  }
  if (kind === 'revision') {
    const r = value as Revision; actor(r.createdBy);
    requireRule(r.documents.some(d => d.path === r.rootDocument), 'Root document is outside the revision.');
    const paths = r.documents.map(d => caseFold(d.path));
    requireRule(new Set(paths).size === paths.length, 'Document paths alias under Unicode 15.1 case folding.');
    const contents = [...r.documents, ...r.resources]; contents.forEach(checkStored); checkStored(r.policy);
    requireRule(r.policy.mediaType === 'application/json' && r.policy.byteLength <= LIMITS.policy, 'Policy content type/size is invalid.');
    requireRule(r.documents.every(d => d.byteLength <= LIMITS.markdown), 'Markdown exceeds 2 MiB.');
    requireRule(r.resources.every(d => d.byteLength <= LIMITS.resource), 'Resource exceeds 20 MiB.');
    requireRule([...new Map(contents.map(c => [c.digest, c.byteLength])).values()].reduce((a, b) => a + b, 0) <= LIMITS.content, 'Revision exceeds 512 MiB.');
    for (const list of [r.resources, r.externalReferences, r.mermaidDiagrams]) {
      requireRule(new Set(list.map(i => i.id)).size === list.length, 'Duplicate semantic ID.');
      requireRule(list.every(i => r.documents.some(d => d.path === i.document)), 'Semantic owner is outside the revision.');
    }
    for (const d of r.mermaidDiagrams) requireRule(encode(d.source).length <= LIMITS.diagram && digest(d.source) === d.sourceDigest && stableId('diagram', `${d.document}\0${d.ordinal}\0${d.source}`) === d.id, 'Invalid Mermaid identity/source.');
  }
  if (kind === 'policy') {
    const p = value as Policy;
    if (p.mode === 'quorum-v1') { p.eligibleActorIds.forEach(id => actor({ id })); requireRule(p.minimumApprovals <= p.eligibleActorIds.length, 'Quorum exceeds eligible actors.'); }
  }
  if (kind === 'verification' || kind === 'inventory') {
    const v = value as Verification;
    for (const list of [v.contextRevisions, v.documents, v.resources]) requireRule(list.every((f, i) => i === 0 || ascii(list[i - 1].path, f.path) < 0), 'Inventory paths must be unique and sorted.');
    requireRule(v.events.every((e, i) => i === 0 || ascii(v.events[i - 1].eventId, e.eventId) < 0), 'Inventory events must be unique and sorted.');
  }
  return value as Shapes[K];
}
export function checkStored(c: StoredContent): void {
  requireRule(c.blobPath === `blobs/sha256/${c.digest.slice(7, 9)}/${c.digest.slice(7)}`, 'Blob path must encode its digest.');
}
export const markdown = (profile: Revision['renderer']['markdownProfile'] = 'commonmark-gfm') => new MarkdownIt({ html: profile === SANITIZED_HTML_PROFILE, linkify: false, typographer: false });
export function inspect(source: string, document: string, profile: Revision['renderer']['markdownProfile'] = 'commonmark-gfm') {
  const parser = markdown(profile), tokens = parser.parse(source, {}); let tableOrdinal = 0, diagramOrdinal = 0, hasHtml = false;
  const tables: Array<{ id: string; rows: number[] }> = [], diagrams: Revision['mermaidDiagrams'] = [];
  const references: Array<{ reference: string; role: 'image' | 'attachment'; id: string }> = [];
  const links: Array<{ uri: string; label?: string; id: string }> = [], unsupportedHtmlTags = new Set<string>();
  const addReference = (reference: string, role: 'image' | 'attachment') => references.push({ reference, role, id: stableId('resource', `${document}\0${reference}`) });
  const addLink = (uri: string, label?: string) => links.push({ uri, ...(label?.trim() ? { label: label.trim() } : {}), id: `reference_${digest(`${document}\0${uri}`).slice(7, 31)}` });
  const inspectHtml = (fragment: string) => {
    hasHtml = true;
    const stack: Array<{ table: { id: string; rows: number[] } }> = [];
    for (const part of scanHtml(fragment)) {
      if (part.kind !== 'tag') continue;
      const read = (name: string) => { const value = attribute(part, name); return value === undefined ? undefined : parser.utils.unescapeAll(value); };
      if (!isAllowedHtmlTag(part.name)) unsupportedHtmlTags.add(part.name);
      if (part.closing) { if (part.name === 'table') stack.pop(); continue; }
      if (part.name === 'table') { const table = { id: stableId('table', `${document}\0${tableOrdinal++}`), rows: [] as number[] }; tables.push(table); stack.push({ table }); }
      else if (part.name === 'tr') stack.at(-1)?.table.rows.push(0);
      else if (part.name === 'td' || part.name === 'th') { const rows = stack.at(-1)?.table.rows; if (rows?.length) rows[rows.length - 1]++; }
      else if (part.name === 'img') { const reference = read('src'); if (reference) addReference(reference, 'image'); }
      else if (part.name === 'a') {
        const reference = read('href'), attachment = read('title')?.trim().toLowerCase() === 'review:attach';
        if (reference && attachment) addReference(reference, 'attachment');
        else if (reference && isAuditedExternalReference(reference)) addLink(reference);
      }
    }
  };
  const markdownTables: Array<{ id: string; rows: number[] }> = [];
  for (const t of tokens) {
    if (t.type === 'table_open') { const table = { id: stableId('table', `${document}\0${tableOrdinal++}`), rows: [] as number[] }; tables.push(table); markdownTables.push(table); }
    if (t.type === 'table_close') markdownTables.pop();
    if (t.type === 'tr_open') markdownTables.at(-1)?.rows.push(0);
    if (t.type === 'td_open' || t.type === 'th_open') { const rows = markdownTables.at(-1)?.rows; if (rows?.length) rows[rows.length - 1]++; }
    if (t.type === 'html_block') inspectHtml(t.content);
    if (t.type === 'fence' && t.info.trim().split(/\s+/)[0].toLowerCase() === 'mermaid') {
      const text = t.content.trimEnd(), ordinal = diagramOrdinal++;
      diagrams.push({ id: stableId('diagram', `${document}\0${ordinal}\0${text}`), document, ordinal, source: text, sourceDigest: digest(text) });
    }
    const linkStack: Array<{ href: string; label: string; attachment: boolean }> = [];
    for (const c of t.children ?? []) {
      const role = c.type === 'image' ? 'image' : c.type === 'link_open' && c.attrGet('title')?.trim().toLowerCase() === 'review:attach' ? 'attachment' : undefined;
      if (role) { const reference = c.attrGet(role === 'image' ? 'src' : 'href')!; addReference(reference, role); }
      if (c.type === 'link_open') { const href = c.attrGet('href'); if (href) linkStack.push({ href, label: '', attachment: c.attrGet('title')?.trim().toLowerCase() === 'review:attach' }); }
      else if (c.type === 'link_close') { const link = linkStack.pop(); if (link && !link.attachment && isAuditedExternalReference(link.href)) addLink(link.href, link.label); }
      else if (linkStack.length && (c.type === 'text' || c.type === 'code_inline')) linkStack.at(-1)!.label += c.content;
      if (c.type === 'html_inline') inspectHtml(c.content);
    }
  }
  return { tokens, tables, diagrams, references, links, hasHtml, unsupportedHtmlTags: [...unsupportedHtmlTags].sort() };
}
export function validateSource(revision: Revision, document: string, source: string): void {
  const parsed = inspect(source, document, revision.renderer.markdownProfile), expected = revision.mermaidDiagrams.filter(d => d.document === document);
  requireRule(JSON.stringify(parsed.diagrams) === JSON.stringify(expected), `Mermaid descriptors differ from ${document}.`);
  for (const ref of parsed.references) requireRule(revision.resources.some(r => r.id === ref.id && r.document === document && r.role === ref.role), `Uncaptured ${ref.role}: ${ref.reference}`);
  for (const link of parsed.links) requireRule(revision.externalReferences.some(r => r.id === link.id && r.document === document), `Unrecorded external reference: ${link.uri}`);
}
export function validateAnchorEvent(event: Event, revision: Revision, sources: ReadonlyMap<string, string>): void {
  requireRule(event.reviewId === revision.reviewId && event.revisionId === revision.id, 'Event belongs to another revision.');
  if (!('anchor' in event)) return;
  const a = event.anchor, doc = revision.documents.find(d => d.path === a.document), source = sources.get(a.document);
  requireRule(doc && doc.digest === a.documentDigest && source !== undefined, 'Anchor has wrong document/digest.');
  const start = offsetAt(source, a.range.start), end = offsetAt(source, a.range.end);
  requireRule(start < end && source.slice(start, end) === a.quote.exact, 'Anchor quote does not match its exact source range.');
  if (a.quote.prefix) requireRule(source.slice(0, start).endsWith(a.quote.prefix), 'Anchor prefix differs.');
  if (a.quote.suffix) requireRule(source.slice(end).startsWith(a.quote.suffix), 'Anchor suffix differs.');
  const target = a.target;
  if (target?.kind === 'image') requireRule(revision.resources.some(r => r.id === target.resourceId && r.role === 'image' && r.document === a.document), 'Image target does not exist.');
  if (target?.kind === 'mermaid') requireRule(revision.mermaidDiagrams.some(d => d.id === target.diagramId && d.document === a.document), 'Diagram target does not exist.');
  if (target?.kind === 'table' || target?.kind === 'table-cell') {
    const table = inspect(source, a.document, revision.renderer.markdownProfile).tables.find(t => t.id === target.tableId);
    requireRule(table, 'Table target does not exist.');
    if (target.kind === 'table-cell') requireRule(target.row < table.rows.length && target.column < table.rows[target.row], 'Table cell does not exist.');
  }
}
