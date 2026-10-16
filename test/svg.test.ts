import test from 'node:test';
import assert from 'node:assert/strict';
import { svgWithoutLegacyDoctype } from '../src/professional/svg';

const body = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="#2458a6"/></svg>';
const legacy = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">';
test('SVG rendering drops only allowlisted legacy public declarations without changing the frozen input', () => {
  assert.equal(svgWithoutLegacyDoctype(body), body);
  for (const prefix of ['', '<?xml version="1.0" encoding="UTF-8"?>\n', '\uFEFF<?xml version="1.0"?>\n<!-- static diagram -->\n']) {
    const original = prefix + legacy + '\n' + body;
    assert.equal(svgWithoutLegacyDoctype(original), prefix + '\n' + body);
    assert.ok(original.includes(legacy));
  }
  assert.equal(svgWithoutLegacyDoctype(legacy.replace('http:', 'https:') + body), body);
  const svg10 = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.0//EN" "http://www.w3.org/TR/2001/REC-SVG-20010904/DTD/svg10.dtd">';
  assert.equal(svgWithoutLegacyDoctype(svg10 + body), body);
});
test('SVG prolog compatibility rejects custom DTDs, entities, internal subsets and misplaced/duplicate declarations', () => {
  for (const unsafe of [
    legacy.replace('www.w3.org', 'attacker.invalid') + body,
    legacy.replace('/1.1/', '/1.0/') + body,
    '<!DOCTYPE svg SYSTEM "https://attacker.invalid/dtd">' + body,
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///private/secret">]>' + body,
    legacy.replace('>', ' [<!ENTITY x "expansion">]>') + body,
    legacy.replace('>', ' []>') + body,
    legacy + legacy + body, body + legacy,
    '<!--' + legacy + '-->' + body,
    legacy + body.replace('/>', '/><!ENTITY x "late">'),
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd?redirect=evil">' + body,
  ]) assert.throws(() => svgWithoutLegacyDoctype(unsafe), /SVG document types and entity declarations/);
});
