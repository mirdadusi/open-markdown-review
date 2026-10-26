import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, parseJson } from '../src/professional/bytes';
import { parseCompanionRequest } from '../src/professional/companionRpc';

test('strict JSON ASCII acceleration preserves printable characters and escaped/non-ASCII values', () => {
  const values = ['', ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
    'a"b\\c\nd', 'Příliš žluťoučký kůň', '😀', '\\ud800', '\u007f', '\u0080', 'key\tvalue'];
  for (const value of values) {
    const source = JSON.stringify({ [value]: value });
    assert.deepEqual(parseJson(encode(source)), JSON.parse(source), source);
  }
  // Deterministic valid-scalar combinations, independent of the fast-path
  // implementation. Compare with the native decoder only for valid inputs.
  let seed = 0x12345678;
  for (let i = 0; i < 1000; i++) {
    let value = '';
    for (let j = 0; j < 24; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; value += values[seed % values.length]; }
    const source = JSON.stringify({ [value]: value });
    assert.deepEqual(parseJson(encode(source)), JSON.parse(source));
  }
});

test('ASCII acceleration never admits duplicate keys, malformed escapes, controls or surrogate code units', () => {
  for (const source of [
    '{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a\\"b":1,"a\\u0022b":2}',
    '{"x":"unterminated}', '{"x":"bad\\x00"}', '{"x":"bad\\u123"}', '{"x":"bad\\"}',
    '{"x":"\\ud800"}', '{"x":"\\udc00"}', '{"x":"\\ud800x"}', '{"\\ud800":0}',
    ...Array.from({ length: 32 }, (_, unit) => '{"x":"before' + String.fromCharCode(unit) + 'after"}'),
  ]) {
    assert.throws(() => parseJson(encode(source)), source);
  }
});

test('large base64 requests still use the same strict envelope, size and duplicate-key rules', () => {
  const value = Buffer.alloc(1048576, 173).toString('base64');
  const expected = { method: 'write', args: ['blobs/sha256/aa/' + 'a'.repeat(64), value, false] };
  const source = JSON.stringify(expected);
  assert.deepEqual(parseCompanionRequest(encode(source)), expected);
  assert.throws(() => parseCompanionRequest(encode(source.slice(0, -1) + ',"method":"read"}')));
  assert.throws(() => parseCompanionRequest(encode(source.replace(value.slice(0, 64), '\\ud800'))));
});
