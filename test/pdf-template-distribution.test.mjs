import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPdfTemplateEdition } from '../scripts/verify-pdf-templates.mjs';

test('template bundling fails closed on cross-edition syncs, public presets and duplicate identities', () => {
  verifyPdfTemplateEdition({ edition: 'public', presets: [] }, { channel: 'marketplace' });
  const preset = { id: 'PrivatePreset', distribution: 'enterprise-only' };
  verifyPdfTemplateEdition({ edition: 'enterprise', presets: [preset] }, { channel: 'github-release' });
  assert.throws(() => verifyPdfTemplateEdition({ edition: 'enterprise', presets: [preset] }, { channel: 'marketplace' }), /different distribution/);
  assert.throws(() => verifyPdfTemplateEdition({ edition: 'public', presets: [preset] }, { channel: 'marketplace' }), /do not bundle/);
  assert.throws(() => verifyPdfTemplateEdition({ edition: 'enterprise', presets: [preset, preset] }, { channel: 'github-release' }), /Duplicate/);
  assert.throws(() => verifyPdfTemplateEdition({ edition: 'public', presets: [] }, { channel: 'unknown' }), /Unknown/);
});
