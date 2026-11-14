import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// Fail closed before bundling: a cross-edition source sync must not ship private presets.
export function verifyPdfTemplateEdition(registry, updateSource) {
  const edition = updateSource.channel === 'marketplace' ? 'public' : updateSource.channel === 'github-release' ? 'enterprise' : undefined;
  assert.ok(edition, 'Unknown distribution channel for PDF template packaging.');
  assert.equal(registry.edition, edition, 'PDF template registry belongs to a different distribution.');
  assert.deepEqual(Object.keys(registry).sort(), ['edition', 'presets']);
  assert.ok(Array.isArray(registry.presets));
  if (edition === 'public') assert.equal(registry.presets.length, 0, 'Public builds do not bundle edition-specific presets.');
  const ids = new Set();
  for (const preset of registry.presets) {
    assert.equal(preset.distribution, 'enterprise-only');
    assert.ok(typeof preset.id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(preset.id) && preset.id !== 'Default' && !ids.has(preset.id), 'Duplicate/invalid PDF template preset identity.');
    ids.add(preset.id);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  verifyPdfTemplateEdition(JSON.parse(await readFile(path.join(root, 'release/pdf-templates.json'), 'utf8')), JSON.parse(await readFile(path.join(root, 'release/update-source.json'), 'utf8')));
  console.log('Verified PDF template edition boundary.');
}
