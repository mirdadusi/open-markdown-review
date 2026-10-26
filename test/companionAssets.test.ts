import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { COMPANION_SEA_MAIN, COMPANION_SEA_PAYLOAD, companionSeaConfiguration, decodeCompanionAssets, encodeCompanionAssets } from '../src/professional/companionAssets';

test('embedded client payload preserves Unicode toolbox and notices and rejects invalid versions', () => {
  const value = { toolbox: '<html>Český Δ review 👋</html>', licenses: 'MIT\nCopyright © 2026\n' };
  assert.deepEqual(decodeCompanionAssets(encodeCompanionAssets(value.toolbox, value.licenses)), value);
  for (const bad of ['null', '{}', '{"schemaVersion":"other","toolbox":"","licenses":""}', '{"schemaVersion":"omr-companion-assets/1","toolbox":1,"licenses":""}']) assert.throws(() => decodeCompanionAssets(bad));
});
test('SEA preparation uses a fixed relative entry and a single asset, independent of staging directory', async () => {
  const blobs: Buffer[] = [];
  for (let i = 0; i < 2; i++) {
    const stage = await mkdtemp(path.join(os.tmpdir(), 'omr-sea-reproducibility-'));
    const config = companionSeaConfiguration();
    assert.equal(config.main, COMPANION_SEA_MAIN); assert.equal(path.isAbsolute(config.main), false);
    assert.deepEqual(Object.keys(config.assets), ['payload']);
    assert.equal(config.useSnapshot, false); assert.equal(config.useCodeCache, false);
    await writeFile(path.join(stage, COMPANION_SEA_MAIN), 'console.log("reproducible client");\n');
    await writeFile(path.join(stage, COMPANION_SEA_PAYLOAD), encodeCompanionAssets('toolbox α', 'MIT ©'));
    await writeFile(path.join(stage, 'sea.json'), JSON.stringify(config));
    const built = spawnSync(process.execPath, ['--experimental-sea-config', 'sea.json'], { cwd: stage, encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    const bytes = await readFile(path.join(stage, config.output)); assert.equal(bytes.includes(Buffer.from(stage)), false); blobs.push(bytes);
  }
  assert.deepEqual(blobs[0], blobs[1]);
});
