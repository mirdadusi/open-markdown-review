import { sha256 as hash } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { ProtocolError, Sha256Digest, LIMITS } from './types';
export const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
export const digest = (value: Uint8Array | string): Sha256Digest => `sha256:${bytesToHex(hash(typeof value === 'string' ? encode(value) : value))}`;
export const jsonBytes = (value: unknown): Uint8Array => encode(JSON.stringify(value, null, 2) + '\n');
export const ascii = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const stableId = (prefix: string, input: string): string => `${prefix}_${digest(input).slice(7, 31)}`;
export const newId = (prefix = 'evt'): string => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  // Chunk on three-byte boundaries so padding occurs only in the last chunk.
  for (let offset = 0; offset < bytes.length; offset += 12288) parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 12288))));
  return parts.join('');
}
export function fromBase64(value: string): Uint8Array {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.length % 4 || /[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding))) throw new ProtocolError('invalid', 'Malformed base64 recovery bytes.');
  const bytes = new Uint8Array(value.length / 4 * 3 - padding);
  for (let offset = 0; offset < value.length; offset += 16384) {
    const binary = atob(value.slice(offset, offset + 16384)), start = offset / 4 * 3;
    for (let i = 0; i < binary.length; i++) bytes[start + i] = binary.charCodeAt(i);
  }
  return bytes;
}
export function decode(bytes: Uint8Array): string {
  try {
    if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) throw new Error('BOM');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { throw new ProtocolError('invalid', 'Expected UTF-8 without a BOM.'); }
}
/** Parse duplicate keys before JSON.parse discards them. Same implementation in all hosts. */
export function parseJson<T = unknown>(bytes: Uint8Array, limit: number = LIMITS.event): T {
  if (bytes.length > limit) throw new ProtocolError('unsupported', `JSON exceeds ${limit} bytes.`);
  const source = decode(bytes); let cursor = 0;
  const fail = (): never => { throw new ProtocolError('invalid', `Invalid JSON near offset ${cursor}.`); };
  const space = () => { while (/[ \t\r\n]/.test(source[cursor] ?? 'x')) cursor++; };
  const string = (): string => {
    const start = cursor++;
    while (cursor < source.length) {
      const char = source[cursor++];
      if (char === '\\') { cursor++; continue; }
      if (char === '"') {
        let value: string; try { value = JSON.parse(source.slice(start, cursor)); } catch { return fail(); }
        if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail();
        return value;
      }
    }
    return fail();
  };
  const value = (depth: number): void => {
    if (depth > 64) throw new ProtocolError('unsupported', 'JSON nesting exceeds 64.');
    space(); const char = source[cursor];
    if (char === '"') { string(); return; }
    if (char === '{' || char === '[') {
      const object = char === '{', end = object ? '}' : ']'; const keys = new Set<string>(); cursor++; space();
      if (source[cursor] === end) { cursor++; return; }
      while (cursor < source.length) {
        space(); if (object) {
          if (source[cursor] !== '"') fail(); const key = string();
          if (keys.has(key)) throw new ProtocolError('invalid', `Duplicate JSON key: ${key}`); keys.add(key);
          space(); if (source[cursor++] !== ':') fail();
        }
        value(depth + 1); space(); const separator = source[cursor++];
        if (separator === end) return;
        if (separator !== ',') fail();
      }
      fail();
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(cursor));
    if (!match) fail();
    if (/^-?\d/.test(match![0]) && !Number.isFinite(Number(match![0]))) fail();
    cursor += match![0].length;
  };
  value(0); space(); if (cursor !== source.length || source.trimStart()[0] !== '{') fail();
  try { return JSON.parse(source) as T; } catch { return fail(); }
}
export function safePath(value: string): string {
  const segments = value.split('/');
  if (!value || encode(value).length > 1024 || segments.length > 32 || segments.some(s => !s || s === '.' || s === '..' || s !== s.normalize('NFC') || /[\\:<>"|?*\x00-\x1f\x7f]|[. ]$/.test(s) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(s) || encode(s).length > 255)) throw new ProtocolError('invalid', `Unsafe protocol path: ${value}`);
  return value;
}
export function pointAt(source: string, offset: number): { line: number; character: number } {
  const pieces = source.slice(0, offset).split(/\r\n|\r|\n/);
  return { line: pieces.length - 1, character: pieces.at(-1)!.length };
}
export function offsetAt(source: string, point: { line: number; character: number }): number {
  const breaks = [...source.matchAll(/\r\n|\r|\n/g)];
  const start = point.line === 0 ? 0 : breaks[point.line - 1] ? breaks[point.line - 1].index! + breaks[point.line - 1][0].length : -1;
  const end = breaks[point.line]?.index ?? source.length;
  const offset = start + point.character;
  if (start < 0 || point.character < 0 || offset > end || (offset > 0 && /[\uD800-\uDBFF]/.test(source[offset - 1]) && /[\uDC00-\uDFFF]/.test(source[offset] ?? ''))) throw new ProtocolError('invalid', 'Anchor position is outside the source or splits a surrogate pair.');
  return offset;
}
