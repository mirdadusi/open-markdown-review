import { ProtocolError } from './types';

export interface OperationControl {
  signal?: AbortSignal;
  progress?: (message: string) => void;
}
export function checkpoint(control?: OperationControl, message?: string): void {
  if (control?.signal?.aborted) throw new ProtocolError('cancelled', 'Cancelled before final publication. Captured checkpoints remain available for an explicit same-operation resume.');
  if (message) control?.progress?.(message);
  if (control?.signal?.aborted) throw new ProtocolError('cancelled', 'Cancelled before final publication. Captured checkpoints remain available for an explicit same-operation resume.');
}
