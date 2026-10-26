import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as local from '@open-markdown-review/slidev-parser-core';

test('v1 retained parser is byte-identical and behaviorally identical to the independent author fixture', async () => {
  const base = path.resolve('examples/slidev/node_modules/@slidev/parser');
  assert.equal(JSON.parse(await readFile(path.join(base, 'package.json'), 'utf8')).version, '52.19.1');
  const upstream = await import(pathToFileURL(path.join(base, 'dist/core.mjs')).href);
  for (const file of ['core.mjs', 'utils.mjs']) assert.deepEqual(await readFile(`third-party/slidev-parser-core/${file}`), await readFile(path.join(base, 'dist', file)));
  const inputs = [await readFile('examples/slidev/slides.md', 'utf8'), '# Single slide 😀\n', '---\ntheme: default\nbackground: /cover.svg\n---\n# Deck\n\n---\nsrc: ./pages/details.md#2,3\n---\n', '# Fence\n\n```md\n---\n```\n\n<!-- note\n---\n-->\n\n---\n# Second\n', '```yaml\ntitle: Block title\n```\n# Body\n\n![A](image.png)\n<img src="other.svg">\n'];
  for (let i = 0; i < 30; i++) inputs.push(`# Generated ${i} 😀\n${'text\n'.repeat(i)}\n---\nlayout: center\n---\n# Second ${i}\n<!-- note ${i} -->\n`);
  for (const input of inputs) for (const source of [input, input.replace(/\n/g, '\r\n')]) {
    const options = { preserveCR: true, noParseYAML: true };
    assert.deepEqual(local.parseSync(source, 'slides.md', options), upstream.parseSync(source, 'slides.md', options));
    assert.deepEqual(local.extractImagesUsage(source, { background: '/cover.svg' }), upstream.extractImagesUsage(source, { background: '/cover.svg' }));
  }
});
