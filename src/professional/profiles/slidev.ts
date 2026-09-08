import schema from '../../../protocol/profiles/slidev/v1.schema.json';
import validator from '../generated/slidev';
import { digest, jsonBytes, parseJson, pointAt, offsetAt, safePath, stableId } from '../bytes';
import { Manifest, ProtocolError, Revision, StoredContent } from '../types';
import { rasterDimensions } from '../imageLimits';
import { collectSlidev } from './slidevSource';
import { mapWithConcurrency } from '../../protocol/concurrency';

export const PRESENTATION_CAPABILITY = 'presentation-profiles-v1';
export const SLIDEV_ID = 'urn:open-markdown-review:profile:slidev:1';
export const SLIDEV_VERSION = '52.19.1';
export const SLIDEV_SCHEMA_BYTES = jsonBytes(schema);
export interface SourceRange { start: number; end: number }
export interface Slide {
  id: string; number: number; title: string; document: string; documentDigest: `sha256:${string}`;
  sourceIndex: number; occurrence: number[]; range: SourceRange; contentRange: SourceRange; noteRange?: SourceRange;
  previewResourceId: string;
}
export interface SlidevProfile {
  profile: typeof SLIDEV_ID; entryDocument: string; parserVersion: typeof SLIDEV_VERSION; rendererVersion: typeof SLIDEV_VERSION;
  notes: 'included' | 'excluded'; capture: 'slidev-png-static'; slides: Slide[]; limitations: string[];
}
export function slideIdentity(document: string, occurrence: number[]): string { return stableId('slide', `${document}\0${occurrence.join('/')}`); }
export function slidevDeclaration(): NonNullable<Manifest['extensions']>[number] {
  const hash = digest(SLIDEV_SCHEMA_BYTES);
  return { id: SLIDEV_ID, schemaUri: schema.$id, schemaDigest: hash, schemaBlobPath: `blobs/sha256/${hash.slice(7, 9)}/${hash.slice(7)}`, affectsState: false };
}
export function validateSlidev(value: unknown, revision: Revision, sources: ReadonlyMap<string, string>): SlidevProfile {
  if (!validator(value)) throw new ProtocolError('invalid', 'Slidev profile does not conform to its versioned JSON schema.');
  const p = value as SlidevProfile;
  if (p.entryDocument !== revision.rootDocument || new Set(p.slides.map(s => s.id)).size !== p.slides.length || new Set(p.slides.map(s => s.previewResourceId)).size !== p.slides.length) throw new ProtocolError('invalid', 'Slidev root or slide identities are inconsistent.');
  for (const [i, slide] of p.slides.entries()) {
    safePath(slide.document);
    const doc = revision.documents.find(d => d.path === slide.document), source = sources.get(slide.document);
    const preview = revision.resources.find(r => r.id === slide.previewResourceId);
    if (!doc || source === undefined || doc.digest !== slide.documentDigest || slide.number !== i + 1 || slide.id !== slideIdentity(slide.document, slide.occurrence) || slide.sourceIndex !== slide.occurrence.at(-1)) throw new ProtocolError('integrity', 'Slidev source binding is inconsistent.');
    if (!preview || preview.document !== slide.document || preview.role !== 'image' || preview.mediaType !== 'image/png' || preview.originalReference !== `${SLIDEV_ID}:preview:${slide.id}` || preview.id !== stableId('resource', `${slide.document}\0${preview.originalReference}`)) throw new ProtocolError('integrity', 'A Slidev preview is missing or belongs to another source.');
    for (const r of [slide.range, slide.contentRange, ...(slide.noteRange ? [slide.noteRange] : [])]) {
      if (r.start > r.end || r.end > source.length || r.start < slide.range.start || r.end > slide.range.end) throw new ProtocolError('invalid', 'Slidev range is outside its frozen source.');
      for (const offset of [r.start, r.end]) if (offsetAt(source, pointAt(source, offset)) !== offset) throw new ProtocolError('invalid', 'Slidev range splits a source line ending.');
    }
    if (slide.range.start === slide.range.end) throw new ProtocolError('invalid', 'A slide needs a nonempty source anchor.');
    if (slide.noteRange && slide.noteRange.start < slide.contentRange.end) throw new ProtocolError('invalid', 'Slidev note and body ranges overlap.');
    if (p.notes === 'excluded' && slide.noteRange && /[^ \r\n]/.test(source.slice(slide.noteRange.start, slide.noteRange.end))) throw new ProtocolError('integrity', 'Excluded notes remain in the frozen source.');
  }
  return p;
}
/** Profile blobs use the same content-addressed attachment and inventory rules as every resource. */
export async function loadSlidev(manifest: Manifest, revision: Revision, sources: ReadonlyMap<string, string>, read: (c: StoredContent) => Promise<Uint8Array>): Promise<SlidevProfile | undefined> {
  const declared = manifest.extensions?.filter(e => e.id === SLIDEV_ID) ?? [];
  const descriptors = revision.resources.filter(r => r.originalReference === SLIDEV_ID);
  if (!declared.length && !descriptors.length) return;
  if (declared.length !== 1 || descriptors.length !== 1 || !manifest.requiredCapabilities.includes(PRESENTATION_CAPABILITY)) throw new ProtocolError('invalid', 'Slidev requires one declared profile and one revision binding.');
  const declaration = declared[0], expected = slidevDeclaration();
  if (Object.keys(expected).some(k => declaration[k as keyof typeof declaration] !== expected[k as keyof typeof expected])) throw new ProtocolError('unsupported', 'Unsupported Slidev profile schema or semantics.');
  const schemaResource = revision.resources.find(r => r.blobPath === declaration.schemaBlobPath && r.originalReference === declaration.schemaUri);
  if (!schemaResource || schemaResource.document !== revision.rootDocument || schemaResource.role !== 'attachment' || schemaResource.mediaType !== 'application/json' || schemaResource.id !== stableId('resource', `${revision.rootDocument}\0${declaration.schemaUri}`) || digest(await read(schemaResource)) !== expected.schemaDigest) throw new ProtocolError('integrity', 'Slidev schema evidence is missing.');
  const descriptor = descriptors[0];
  if (descriptor.role !== 'attachment' || descriptor.mediaType !== 'application/json' || descriptor.document !== revision.rootDocument || descriptor.id !== stableId('resource', `${revision.rootDocument}\0${SLIDEV_ID}`)) throw new ProtocolError('invalid', 'Invalid Slidev profile attachment.');
  const profile = validateSlidev(parseJson(await read(descriptor), 1048576), revision, sources);
  const mapped = await collectSlidev(profile.entryDocument, async document => { const source = sources.get(document); if (source === undefined) throw new ProtocolError('integrity', 'Slidev import is missing from the frozen revision.'); return source; });
  if (mapped.slides.length !== profile.slides.length) throw new ProtocolError('integrity', 'Slidev profile does not cover the expanded deck.');
  for (const [i, expectedSlide] of mapped.slides.entries()) {
    const actual = profile.slides[i];
    for (const key of ['id', 'number', 'title', 'document', 'sourceIndex', 'occurrence', 'range', 'contentRange'] as const) if (JSON.stringify(actual[key]) !== JSON.stringify(expectedSlide[key])) throw new ProtocolError('integrity', `Slidev ${key} differs from its frozen source mapping.`);
    if (profile.notes === 'included' && JSON.stringify(actual.noteRange) !== JSON.stringify(expectedSlide.noteRange)) throw new ProtocolError('integrity', 'Slidev included-note mapping differs from source.');
  }
  // Image headers are checked before a browser can allocate the declared raster.
  await mapWithConcurrency(profile.slides, 4, async slide => rasterDimensions(await read(revision.resources.find(r => r.id === slide.previewResourceId)!), 'image/png'));
  return profile;
}
