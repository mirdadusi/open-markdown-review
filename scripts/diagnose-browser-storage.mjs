import { chromium } from 'playwright';

// Only synthetic OPFS data. The shell comparison is diagnostic; the supported
// full-Chromium probe is required. This never grants or bypasses a disk permission.
const results = [];
for (const channel of [undefined, 'chromium']) {
  const name = channel ?? 'headless-shell';
  let server, browser, phase = 'launch';
  try {
    server = await chromium.launchServer({ headless: true, ...(channel ? { channel } : {}), ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
    server.process().stderr?.on('data', chunk => process.stderr.write(`${name}: ${chunk}`));
    server.process().on('exit', (code, signal) => console.log(`${name}: process exit ${code}, signal ${signal}`));
    browser = await chromium.connect(server.wsEndpoint());
    console.log(`${name}: ${browser.version()}`);
    const context = await browser.newContext();
    context.setDefaultTimeout(15000);
    await context.route('https://storage-test.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Storage probe</title><button>Connect</button>' }));
    for (let participant = 0; participant < 2; participant++) {
      phase = `participant ${participant + 1}: page`;
      console.log(`${name}: ${phase}`);
      const page = await context.newPage();
      page.on('crash', () => console.log(`${name}: page crashed during ${phase}`));
      await page.goto('https://storage-test.invalid/');
      if (participant) {
        phase = 'participant 2: restore serialized directory handle';
        console.log(`${name}: ${phase}`);
        await page.evaluate(async () => {
          const remembered = await new Promise((resolve, reject) => {
            const opening = indexedDB.open('probe', 1);
            opening.onerror = () => reject(opening.error);
            opening.onsuccess = () => {
              const db = opening.result, transaction = db.transaction('handles');
              const read = transaction.objectStore('handles').get('review');
              transaction.oncomplete = () => { db.close(); resolve(read.result); };
              transaction.onabort = () => { db.close(); reject(transaction.error); };
            };
          });
          if (!(await (await remembered.root.getFileHandle('manifest.json')).getFile()).size) throw new Error('Remembered handle lost file access.');
        });
      }
      phase = `participant ${participant + 1}: OPFS + IndexedDB directory handle`;
      console.log(`${name}: ${phase}`);
      await page.evaluate(async () => {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('fixture', { create: true });
        const file = await root.getFileHandle('manifest.json', { create: true });
        const stream = await file.createWritable(); await stream.write('{"fixture":true}'); await stream.close();
        if ((await root.resolve(file))?.join('/') !== 'manifest.json') throw new Error('Incorrect rooted resolution.');
        await new Promise((resolve, reject) => {
          const opening = indexedDB.open('probe', 1);
          opening.onupgradeneeded = () => opening.result.createObjectStore('handles');
          opening.onerror = () => reject(opening.error);
          opening.onsuccess = () => {
            const db = opening.result, transaction = db.transaction('handles', 'readwrite');
            transaction.objectStore('handles').put({ root }, 'review');
            transaction.oncomplete = () => { db.close(); resolve(); };
            transaction.onabort = () => { db.close(); reject(transaction.error); };
          };
        });
      });
      phase = `participant ${participant + 1}: pointer action`;
      console.log(`${name}: ${phase}`);
      await page.locator('button').click();
    }
    results.push({ name, ok: true });
  } catch (error) { results.push({ name, ok: false, phase, error: String(error) }); }
  finally { await browser?.close().catch(() => undefined); await server?.close().catch(() => undefined); }
}
console.log(JSON.stringify(results, null, 2));
if (!results.find(result => result.name === 'chromium')?.ok) process.exitCode = 1;
