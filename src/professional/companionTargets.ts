/** Client deployment choices, not protocol capabilities or review state. */
import { ProtocolError } from './types';
export const COMPANION_TARGETS = [
  { id: 'win32-x64', label: 'Windows x64', filename: 'StartReview-windows-x64.exe' },
  { id: 'darwin-arm64', label: 'macOS Apple Silicon', filename: 'StartReview-macos-arm64' },
  { id: 'linux-x64', label: 'Linux x64', filename: 'StartReview-linux-x64' },
] as const;
export type CompanionTarget = typeof COMPANION_TARGETS[number]['id'];
export function companionTargets(input: unknown): CompanionTarget[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.some(id => !COMPANION_TARGETS.some(target => target.id === id)) || new Set(input).size !== input.length) throw new ProtocolError('invalid', 'Select each supported companion platform at most once: win32-x64, darwin-arm64, linux-x64.');
  return COMPANION_TARGETS.filter(target => input.includes(target.id)).map(target => target.id);
}
