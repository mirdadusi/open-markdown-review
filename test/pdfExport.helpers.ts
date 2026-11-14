import { Frame, Page } from 'playwright';
/** Exercise the public confirmation flow, rather than bypassing it for test exports. */
export async function confirmPdfOptions(surface: Page | Frame, mode?: 'review' | 'clean') {
  await surface.locator('#export').click();
  await surface.locator('#pdf-template-dialog').waitFor({ state: 'visible' });
  if (mode) await surface.locator('#export-mode').selectOption(mode);
  await surface.locator('#pdf-export-confirm').click();
}
