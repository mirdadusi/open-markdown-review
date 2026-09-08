import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { releasePolicy, vsixChannelArgs } from '../scripts/release-policy.mjs';

const pkg = { version: '0.5.0' };
const record = () => ({
  schemaVersion: 'omr-release-qualification/1',
  version: '0.5.0',
  professionalPilotApproved: false,
  blockingGates: ['Unqualified native folder permissions'],
  statusReport: 'spec/IMPLEMENTATION-STATUS.md',
  publication: { channel: 'evaluation', approved: true, approvedBy: 'user', approvedOn: '2026-09-08' },
});

test('release policy keeps the default professional gate closed despite evaluation approval', () => {
  assert.throws(() => releasePolicy(pkg, record()), /Professional pilot release is not approved/);
  assert.throws(() => releasePolicy(pkg, { ...record(), publication: undefined }, true), /not approved/);
});

test('release policy authorizes only explicit evaluation publication without mutating gates', () => {
  const qualification = record();
  const before = structuredClone(qualification);
  assert.deepEqual(releasePolicy(pkg, qualification, true), {
    channel: 'evaluation', prerelease: true, notesFile: 'docs/releases/0.5.0.md',
  });
  assert.deepEqual(qualification, before);
  for (const change of [{ approved: false }, { approved: 'true' }, { approvedBy: 'automation' }, { approvedOn: '' }]) {
    assert.throws(() => releasePolicy(pkg, { ...qualification, publication: { ...qualification.publication, ...change } }, true), /explicit recorded user approval/);
  }
});

test('explicit standard publication is not a pre-release and never grants professional approval', () => {
  const qualification = record();
  qualification.publication.channel = 'standard';
  const before = structuredClone(qualification);
  assert.deepEqual(releasePolicy(pkg, qualification, true), {
    channel: 'standard', prerelease: false, notesFile: 'docs/releases/0.5.0.md',
  });
  assert.deepEqual(qualification, before);
  assert.throws(() => releasePolicy(pkg, qualification), /Professional pilot release is not approved/);
  for (const change of [{ approved: false }, { approved: 'true' }, { approvedBy: 'automation' }, { approvedOn: '' }]) {
    assert.throws(() => releasePolicy(pkg, { ...qualification, publication: { ...qualification.publication, ...change } }, true), /explicit recorded user approval/);
  }
});

test('release policy refuses unknown channels and malformed or stale qualification', () => {
  for (const change of [
    { version: '0.4.6' }, { schemaVersion: 'unknown' }, { blockingGates: null },
    { blockingGates: [''] }, { professionalPilotApproved: 'false' },
    { publication: { ...record().publication, channel: 'evaluation\nprerelease=false' } },
  ]) assert.throws(() => releasePolicy(pkg, { ...record(), ...change }, true));
  assert.throws(() => releasePolicy({ version: '../0.5.0' }, { ...record(), version: '../0.5.0' }, true));
});

test('professional publication still requires approval and zero remaining gates', () => {
  const qualification = { ...record(), publication: { channel: 'professional' }, professionalPilotApproved: true };
  assert.throws(() => releasePolicy(pkg, qualification, true), /not approved/);
  qualification.blockingGates = [];
  assert.equal(releasePolicy(pkg, qualification, true).prerelease, false);
  qualification.professionalPilotApproved = false;
  assert.throws(() => releasePolicy(pkg, qualification, true), /not approved/);
});

test('evaluation VSIX packages are marked pre-release and unknown channels fail closed', () => {
  assert.deepEqual(vsixChannelArgs('evaluation'), ['--pre-release']);
  assert.deepEqual(vsixChannelArgs('professional'), []);
  assert.deepEqual(vsixChannelArgs('standard'), []);
  assert.deepEqual(vsixChannelArgs(), []);
  assert.throws(() => vsixChannelArgs('preview'), /Unknown VSIX release channel/);
});

test('checked-in release discloses limitations and cannot bypass the professional CLI gate', async () => {
  const actualPkg = JSON.parse(await readFile('package.json', 'utf8'));
  const qualification = JSON.parse(await readFile('release-qualification.json', 'utf8'));
  const policy = releasePolicy(actualPkg, qualification, true);
  const notes = await readFile(policy.notesFile, 'utf8');
  if (policy.prerelease) {
    assert.match(notes, /evaluation pre-release/i);
  }
  if (!qualification.professionalPilotApproved) {
    assert.match(notes, /not approved for the professional pilot/i);
    assert.match(notes, /SMB.*untested/i);
  }
  const defaultGate = spawnSync(process.execPath, ['scripts/verify-release-qualification.mjs'], { encoding: 'utf8' });
  assert.equal(defaultGate.status, qualification.professionalPilotApproved && !qualification.blockingGates.length ? 0 : 1);
  const publicationGate = spawnSync(process.execPath, ['scripts/verify-release-qualification.mjs', '--publication'], {
    encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' },
  });
  assert.equal(publicationGate.status, 0, publicationGate.stderr);
});
