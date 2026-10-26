/** Client deployment bytes, never review evidence or a received executable. */
export const COMPANION_SEA_MAIN = 'omr-companion.cjs';
export const COMPANION_SEA_PAYLOAD = 'omr-companion.assets.json';
export function companionSeaConfiguration() {
  // Node serializes main verbatim and its assets map has host-dependent order.
  // One fixed relative entry and one payload keep builds independent of both.
  return { main: COMPANION_SEA_MAIN, output: 'sea.blob', disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets: { payload: COMPANION_SEA_PAYLOAD } };
}
export function encodeCompanionAssets(toolbox: string, licenses: string): string {
  return JSON.stringify({ schemaVersion: 'omr-companion-assets/1', toolbox, licenses });
}
export function decodeCompanionAssets(payload: string): { toolbox: string; licenses: string } {
  const value = JSON.parse(payload);
  if (!value || value.schemaVersion !== 'omr-companion-assets/1' || typeof value.toolbox !== 'string' || typeof value.licenses !== 'string') throw new Error('Invalid embedded companion assets.');
  return { toolbox: value.toolbox, licenses: value.licenses };
}
