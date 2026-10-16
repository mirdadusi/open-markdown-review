import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { verifySlidevParser } from '../scripts/verify-slidev-parser.mjs';
import { verifyFixtureAudit } from '../scripts/fixture-audit-policy.mjs';

const advisory = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';
function fixture() {
  const lockBytes = Buffer.from(JSON.stringify({ packages: { 'node_modules/braces': { version: '3.0.3' } } }));
  const policy = { schemaVersion: 'omr-fixture-audit-policy/2', approval: 'explicit-project-owner-approval', reviewedOn: '2026-10-16', reviewAfter: '2026-11-15', lockDigest: `sha256:${createHash('sha256').update(lockBytes).digest('hex')}`, advisories: [advisory], reviewedNodes: { 'node_modules/braces': '3.0.3' } };
  const audit = { metadata: { vulnerabilities: { high: 1, critical: 0 } }, vulnerabilities: { braces: { severity: 'high', nodes: ['node_modules/braces'], via: [{ name: 'braces', severity: 'high', url: advisory }] } } };
  return { audit, policy, lockBytes, today: '2026-10-16' };
}
test('retained MIT parser verifies exact upstream module and license bytes', async () => {
  const origin = await verifySlidevParser(); assert.equal(origin.upstreamVersion, '52.19.1');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'omr-parser-integrity-')); await cp('third-party/slidev-parser-core', temp, { recursive: true });
  await writeFile(path.join(temp, 'core.mjs'), '// altered source\n');
  await assert.rejects(verifySlidevParser(temp), /differs from its reviewed upstream bytes/);
});
test('all client inventories retain parser attribution and upstream provenance without the unused toolchain', async () => {
  for (const profile of ['toolbox', 'runtime', 'companion']) {
    const inventory = JSON.parse(await readFile(`dist/${profile}-dependencies.json`, 'utf8'));
    const parser = inventory.components.find(p => p.name === '@open-markdown-review/slidev-parser-core');
    assert.equal(parser?.upstream.upstreamVersion, '52.19.1'); assert.ok(parser.notices.some(n => n.file === 'LICENSE'));
    assert.ok((await readFile(`dist/${profile}-NOTICES.txt`, 'utf8')).includes('Copyright (c) 2020-PRESENT Anthony Fu'));
    assert.ok(!inventory.components.some(p => ['braces', '@slidev/types', 'vite-plugin-static-copy'].includes(p.name)));
  }
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  assert.ok(!Object.keys(lock.packages).some(name => /(?:^|\/)node_modules\/(?:braces|@slidev\/types)$/.test(name)));
});
test('fixture exception admits only the reviewed advisory graph during its manually approved 30-day window', () => {
  const f = fixture(); assert.deepEqual(verifyFixtureAudit(f), ['braces']);
  assert.deepEqual(verifyFixtureAudit({ ...f, today: '2026-11-15' }), ['braces']);
  for (const change of [{ today: '2026-11-16' }, { today: '2026-10-15' }, { policy: { ...f.policy, reviewAfter: '2026-11-16' } }, { policy: { ...f.policy, approval: 'automatic' } }, { policy: { ...f.policy, reviewedOn: '2026-02-31' } }, { lockBytes: Buffer.concat([f.lockBytes, Buffer.from('\n')]) }, { policy: { ...f.policy, reviewedNodes: { 'node_modules/braces': '3.0.4' } } }]) assert.throws(() => verifyFixtureAudit({ ...f, ...change }));
});
test('fixture approval cannot admit new advisories, critical findings, unknown packages or unavailable audits', () => {
  const f = fixture();
  const bad = [
    { ...f.audit, error: { message: 'Network unavailable' } },
    { vulnerabilities: {} },
    { ...f.audit, vulnerabilities: {} },
    { ...f.audit, metadata: { vulnerabilities: { high: 1, critical: 1 } } },
    { ...f.audit, vulnerabilities: { braces: { ...f.audit.vulnerabilities.braces, severity: 'critical' } } },
    { ...f.audit, vulnerabilities: { braces: { ...f.audit.vulnerabilities.braces, via: [{ name: 'braces', severity: 'high', url: 'https://github.com/advisories/new-advisory' }] } } },
    { ...f.audit, vulnerabilities: { unknown: f.audit.vulnerabilities.braces } },
    { ...f.audit, vulnerabilities: { braces: { ...f.audit.vulnerabilities.braces, via: ['missing-propagation'] } } },
  ];
  for (const audit of bad) assert.throws(() => verifyFixtureAudit({ ...f, audit }));
  assert.throws(() => verifyFixtureAudit({ ...f, policy: { ...f.policy, advisories: [advisory, 'another'] } }));
});
