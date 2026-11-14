import test from 'node:test';
import assert from 'node:assert/strict';
import { svgWithoutLegacyDoctype, svgEmbeddedRaster, validateSvgCss } from '../src/professional/svg';
import { embeddedPng } from './svg.fixture';

const body = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="#2458a6"/></svg>';
const legacy = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">';
test('SVG CSS accepts quoted/unquoted same-document fragments without regex backtracking false positives', () => {
  for (const value of ['url(#local)', "url('#local')", 'url("#local")', 'url( #local )', 'url(\n"#local"\t)', 'fill:url(#a);filter:url(\'#b\')', '#2458a6', 'none']) assert.doesNotThrow(() => validateSvgCss(value), value);
  for (const value of ['url(https://example.com/a.svg#b)', "url('assets/other.svg#b')", 'url(data:image/png;base64,AA==)', 'url(#)', 'url("#local\')', 'url(#a) url(https://example.com)', 'url(\\23 local)', 'u\\72l(https://example.com)', 'url(/**/#local)', '@im/**/port "x"', 'expression(alert(1))']) assert.throws(() => validateSvgCss(value), /SVG CSS/, value);
});
test('SVG embedded raster validates exact MIME, base64, signature and pre-decode dimensions', () => {
  const png = svgEmbeddedRaster(`data:image/png;base64,${embeddedPng.slice(0, 44)}\n\t${embeddedPng.slice(44)}\r\n`);
  assert.equal(png.uri, `data:image/png;base64,${embeddedPng}`); assert.equal(png.pixels, 1); assert.equal(png.byteLength, Buffer.from(embeddedPng, 'base64').length);
  assert.equal(svgEmbeddedRaster('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7').pixels, 1);
  for (const uri of [
    'https://example.com/image.png', 'assets/picture.png', 'file:///private/picture.png',
    'data:image/svg+xml;base64,' + Buffer.from(body).toString('base64'), 'data:text/html;base64,PGh0bWw+',
    'data:image/png;charset=utf-8;base64,' + embeddedPng, 'data:image/png,not-base64', 'data:image/png;base64,',
    'data:image/png;base64,AAAA!', 'data:image/png;base64,AAAA=', 'data:image/png;base64,AA%3D%3D',
    'data:image/png;base64,' + embeddedPng + '\u00a0', 'data:image/jpeg;base64,' + embeddedPng,
    'data:image/png;base64,' + Buffer.from('<svg/>').toString('base64'),
  ]) assert.throws(() => svgEmbeddedRaster(uri), /SVG embedded image/, uri.slice(0, 80));
  const oversized = Buffer.from(embeddedPng, 'base64'); oversized.writeUInt32BE(5001, 16); oversized.writeUInt32BE(5000, 20);
  assert.throws(() => svgEmbeddedRaster('data:image/png;base64,' + oversized.toString('base64')), /25 million pixels/);
});
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
