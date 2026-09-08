import { Manifest, ProtocolError, Revision, StoredContent } from '../types';
import { loadSlidev, PRESENTATION_CAPABILITY, SLIDEV_ID } from './slidev';

/** Client-side adapter registry. Core schemas and events contain no framework fields. */
export async function loadProfiles(manifest: Manifest, revision: Revision, sources: ReadonlyMap<string, string>, read: (c: StoredContent) => Promise<Uint8Array>): Promise<ReadonlyMap<string, unknown>> {
  const result = new Map<string, unknown>();
  if (manifest.requiredCapabilities.includes(PRESENTATION_CAPABILITY) && (!manifest.extensions?.length || manifest.extensions.some(e => e.id !== SLIDEV_ID))) throw new ProtocolError('unsupported', 'This client cannot interpret the declared presentation profile; participation is disabled.');
  const slidev = await loadSlidev(manifest, revision, sources, read);
  if (slidev) result.set(SLIDEV_ID, slidev);
  return result;
}
