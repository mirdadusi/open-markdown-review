import { contained, NativeStorage } from './nativeStorage';
import { ReviewSession } from './session';
import { ProtocolError } from './types';

/** The webview supplies an admitted event ID, never an arbitrary native path. */
export async function verifiedExportFile(storage: NativeStorage, eventId: string): Promise<string> {
  if (typeof eventId !== 'string' || !eventId || eventId.length > 128) throw new ProtocolError('invalid', 'Choose an archived PDF export.');
  const session = new ReviewSession(storage); await session.open();
  const event = session.events.find(e => e.id === eventId && e.type === 'export.created');
  if (event?.type !== 'export.created') throw new ProtocolError('invalid', 'This review has no verified PDF export with that event ID.');
  if (!/^exports\/[a-f0-9]{64}\.pdf$/.test(event.pdf.path)) throw new ProtocolError('invalid', 'Invalid PDF export location.');
  await session.content({ ...event.pdf, blobPath: event.pdf.path }, true);
  return contained(storage.root, event.pdf.path);
}
