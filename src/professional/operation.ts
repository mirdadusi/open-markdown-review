import { ProtocolError } from './types';

export interface OperationControl {
  signal?: AbortSignal;
  progress?: (message: string) => void;
}
export function checkpoint(control?: OperationControl, message?: string): void {
  if (control?.signal?.aborted) throw new ProtocolError('cancelled', 'Operation cancelled before its final publication boundary. Existing review evidence is unchanged; any private recovery checkpoint remains available for an explicit retry.');
  if (message) control?.progress?.(message);
  if (control?.signal?.aborted) throw new ProtocolError('cancelled', 'Operation cancelled before its final publication boundary. Existing review evidence is unchanged; any private recovery checkpoint remains available for an explicit retry.');
}

/** Stop waiting at the next safe async boundary; the underlying operation may
 * finish privately but its result cannot cross the caller's publication path. */
export function interruptible<T>(work: Promise<T>, control?: OperationControl): Promise<T> {
  if (!control?.signal) return work;
  checkpoint(control);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => { if (settled) return; settled = true; control.signal!.removeEventListener('abort', abort); action(); };
    const abort = () => finish(() => reject(new ProtocolError('cancelled', 'Operation cancelled before its final publication boundary. Existing review evidence is unchanged.')));
    control.signal!.addEventListener('abort', abort, { once: true });
    work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
