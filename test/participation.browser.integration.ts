import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, Page } from 'playwright';
import { authorReview } from '../src/professional/authoring';
import { runCli } from '../src/professional/cli';
import { NativeStorage } from '../src/professional/nativeStorage';
import { storageResponse } from '../src/professional/bridge';
import { ActorRef, AuditInventory, Event, LIMITS } from '../src/professional/types';
import { digest, parseJson } from '../src/professional/bytes';
import { ReviewSession } from '../src/professional/session';
import { reviewerRoster } from '../src/professional/reviewer';

async function submit(page: Page) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.waitForFunction(() => !(document.getElementById('save') as HTMLButtonElement).disabled);
    await page.locator('#save').click();
    await page.waitForFunction(() => !(document.getElementById('composer') as HTMLDialogElement).open || !!document.getElementById('composer-error')?.textContent);
    if (!await page.locator('#composer').evaluate((dialog: HTMLDialogElement) => dialog.open)) return;
    assert.match(await page.locator('#composer-error').innerText(), /New review activity|Observed review state changed|confirm again/);
  }
  assert.fail('The review did not settle sufficiently to confirm the action.');
}
async function feedback(page: Page, text: string) {
  await page.locator('#document [data-source-map]').filter({ hasText: 'A concrete design.' }).evaluate(span => {
    const range = document.createRange(); range.selectNodeContents(span);
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await page.locator('#comment').click(); await page.locator('#body').fill(text); await submit(page);
}

for (const mode of ['vscode-bridge', 'browser-directory'] as const) test(`${mode}: email roster, independent finish/reopen, creator progress, private identity and offline PDF`, { timeout: 180000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), `omr-participation-${mode}-`)), source = path.join(temporary, 'source'), root = path.join(temporary, 'review'), journalRoot = path.join(temporary, 'journal');
  await mkdir(source); await writeFile(path.join(source, 'a.md'), '# Review\n\nA concrete design.\n');
  await writeFile(path.join(source, 'b.md'), '# Other document\n\nThe whole scope remains in the archive.\n');
  const actor = { id: 'initiator', displayName: 'Review Initiator' }, artifact = path.resolve('dist/OpenMarkdownReview.html');
  const longEmail = `${'a'.repeat(64)}@${'b'.repeat(60)}.${'c'.repeat(40)}.example`;
  const reviewerEmails = ['alex@example.com', 'sam@example.com', longEmail];
  const request = { source, store: root, rootDocument: 'a.md', title: 'Email participation review', actor, operationId: 'participation_fixture', clientArtifact: artifact, journalRoot, reviewerEmails };
  const created = await authorReview(request), store = new NativeStorage(root, journalRoot), initial = new ReviewSession(store); await initial.open();
  const revisionId = created.revisionId!, alexId = initial.manifest.reviewers!.find(r => r.email === 'alex@example.com')!.id;
  const originalManifest = await readFile(path.join(root, 'manifest.json'));
  await assert.rejects(authorReview({ ...request, operationId: 'refused_roster_change', parents: [revisionId], reviewerEmails: ['someone-else@example.com'] }), /reviewer email list is immutable/);
  assert.equal(digest(await readFile(path.join(root, 'manifest.json'))), digest(originalManifest));
  const bad = await runCli(['review', 'create', '--source', source, '--store', path.join(temporary, 'bad-review'), '--root-document', 'a.md', '--actor-id', actor.id, '--reviewer-email', 'not-an-email', '--dry-run']);
  assert.equal(bad.exitCode, 2);
  const cli = await runCli(['review', 'create', '--source', source, '--store', path.join(temporary, 'cli-review'), '--root-document', 'a.md', '--actor-id', actor.id, '--operation-id', 'cli_roster', '--reviewer-email', 'ALEX@EXAMPLE.COM', '--reviewer-email', 'sam@example.com'], artifact);
  assert.equal(cli.exitCode, 0, JSON.stringify(cli.result));
  const cliManifest = JSON.parse(await readFile(path.join(temporary, 'cli-review/manifest.json'), 'utf8'));
  assert.deepEqual(cliManifest.reviewers.map((r: { email: string }) => r.email), ['alex@example.com', 'sam@example.com']);
  const browser = await chromium.launch({ headless: true, channel: 'chromium', ...(process.env.OMR_TEST_BROWSER ? { executablePath: process.env.OMR_TEST_BROWSER } : {}) });
  const errors: string[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), html = await readFile(created.browserClientPath, 'utf8');
    const packageFiles: Array<{ path: string; bytes: number[] }> = [];
    const collect = async (directory: string) => {
      for (const file of await readdir(path.join(root, directory), { withFileTypes: true })) {
        const relative = directory ? `${directory}/${file.name}` : file.name;
        if (file.isDirectory()) await collect(relative);
        else if (!file.name.endsWith('.html')) packageFiles.push({ path: relative, bytes: Array.from(await readFile(path.join(root, relative))) });
      }
    };
    if (mode === 'browser-directory') {
      await collect('');
      await context.route('https://email-review.invalid/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      await context.addInitScript(() => {
        const fileSystem = globalThis as typeof globalThis & { FileSystemHandle?: { prototype: Record<string, unknown> } }, prototype = fileSystem.FileSystemHandle?.prototype;
        if (prototype && !prototype.queryPermission) Object.defineProperty(prototype, 'queryPermission', { value: async () => 'granted' });
        if (prototype && !prototype.requestPermission) Object.defineProperty(prototype, 'requestPermission', { value: async () => 'granted' });
        window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('review', { create: true });
      });
    }
    let seeded = false, failPatInvitation = mode === 'vscode-bridge';
    const open = async (reviewer?: ActorRef) => {
      const page = mode === 'browser-directory' ? await context.newPage() : await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.on('pageerror', error => errors.push(error.message));
      if (mode === 'vscode-bridge') {
        let saved = reviewer;
        await page.exposeFunction('omrHost', async (method: string, args: unknown[]) => {
          if (method === 'info') return { ok: true, value: { identity: store.identity, writable: true, canRememberReviewer: true, reviewer: saved } };
          if (method === 'rememberReviewer') { saved = args[0] as ActorRef; return { ok: true, value: true }; }
          if (method === 'write' && failPatInvitation && String(args[0]).startsWith('events/')) {
            const event = parseJson<Event>(new Uint8Array(args[1] as number[]));
            if (event.type === 'reviewer.invited' && event.reviewer.email === 'pat@example.com') { failPatInvitation = false; return { ok: false, code: 'uncertain', error: 'Simulated interrupted invitation batch.' }; }
          }
          return storageResponse(store, method, args);
        });
        await page.goto(pathToFileURL(created.browserClientPath).href);
      } else {
        await page.goto('https://email-review.invalid/review');
        if (!seeded) {
          await page.evaluate(async files => {
            const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('review', { create: true });
            for (const file of files) {
              const parts = file.path.split('/'), name = parts.pop()!; let parent = root;
              for (const segment of parts) parent = await parent.getDirectoryHandle(segment, { create: true });
              const writer = await (await parent.getFileHandle(name, { create: true })).createWritable(); await writer.write(new Uint8Array(file.bytes)); await writer.close();
            }
          }, packageFiles);
          seeded = true; await page.locator('#connect').click();
        }
      }
      await page.waitForSelector('#document [data-source-map]');
      if (reviewer) { await page.locator('#actor-id').fill(reviewer.id); await page.locator('#actor-name').fill(reviewer.displayName ?? ''); await page.locator('#actor-name').press('Tab'); }
      return page;
    };
    const alex = await open();
    await alex.locator('#actor-id').fill('outsider@example.com');
    assert.equal(await alex.locator('#comment').isDisabled(), true); assert.equal(await alex.locator('#finish-review').isDisabled(), true);
    await alex.locator('#actor-id').fill('ALEX@EXAMPLE.COM'); await alex.locator('#actor-name').fill('Alex Reviewer'); await alex.locator('#actor-name').press('Tab');
    await feedback(alex, 'Alex challenged this design.');
    const creator = await open(actor), sam = await open({ id: 'sam@example.com', displayName: 'Sam Reviewer' });
    await alex.locator('#finish-review').click(); await alex.locator('#body').fill('First pass complete.'); await submit(alex);
    assert.match(await alex.locator('#completion-status').innerText(), /finished/);
    assert.match(await alex.locator('#stance-status').innerText(), /not set/);
    assert.equal(await alex.locator('#comment').isDisabled(), true); assert.equal(await alex.locator('#approve').isDisabled(), true);
    await creator.locator('#refresh').click(); await creator.waitForSelector(`[data-reviewer-id="${alexId}"][data-reviewer-status="finished"]`);
    assert.match(await creator.locator(`[data-reviewer-id="${alexId}"] small`).innerText(), /\d{4}-\d{2}-\d{2}T/);
    await feedback(sam, 'Sam can continue while Alex is finished.');
    await alex.locator('#reopen-review').click(); await alex.locator('#body').fill('Checking the additional concern.'); await submit(alex);
    assert.equal(await alex.locator('#comment').isDisabled(), false);
    await creator.locator('#refresh').click(); await creator.waitForSelector(`[data-reviewer-id="${alexId}"][data-reviewer-status="reopened"]`);
    await alex.locator('#finish-review').click(); await alex.locator('#body').fill('Final pass complete.'); await submit(alex);
    await alex.reload(); await alex.waitForSelector('#document [data-source-map]');
    assert.equal(await alex.locator('#actor-id').inputValue(), 'alex@example.com');
    assert.match(await alex.locator('#completion-status').innerText(), /finished/);
    await creator.locator('#refresh').click(); await creator.waitForSelector(`[data-reviewer-id="${alexId}"][data-reviewer-status="finished"]`);
    await creator.locator('#actor-id').fill(actor.id); await creator.locator('#actor-name').fill(actor.displayName);
    assert.equal(await alex.locator('#add-reviewers').isVisible(), false); assert.equal(await sam.locator('#add-reviewers').isVisible(), false);
    assert.equal(await creator.locator('#add-reviewers').isVisible(), true);
    const denied = await sam.evaluate(async reviewer => {
      const session = window.omrAutomation!.session()!, context = session.context({ id: 'sam@example.com' });
      try { await session.save(context, session.makeEvent(context, { type: 'reviewer.invited', reviewer })); return ''; }
      catch (error) { return (error as Error).message; }
    }, reviewerRoster(['outsider@example.com'])[0]);
    assert.match(denied, /Only the review initiator/);
    await creator.locator('#add-reviewers').click(); await creator.locator('#body').fill('not-an-email'); await creator.locator('#save').click();
    await creator.waitForFunction(() => document.getElementById('composer-error')?.textContent?.includes('valid reviewer email'));
    await creator.locator('#body').fill(' Nina@Example.com,pat@example.com,alex@example.com\nnina@example.com ');
    if (mode === 'vscode-bridge') {
      await creator.locator('#save').click(); await creator.waitForFunction(() => document.getElementById('composer-error')?.textContent?.includes('Simulated interrupted invitation batch'));
      assert.equal(await creator.evaluate(() => window.omrAutomation!.session()!.events.filter(e => e.type === 'reviewer.invited').length), 1, 'A partial batch preserves its first published invitation.');
    }
    await submit(creator);
    const ninaId = reviewerRoster(['nina@example.com'])[0].id;
    await creator.waitForSelector(`[data-reviewer-id="${ninaId}"][data-reviewer-status="not-started"]`);
    await creator.locator('#add-reviewers').click(); await creator.locator('#body').fill('nina@example.com'); await creator.locator('#save').click();
    await creator.waitForFunction(() => document.getElementById('composer-error')?.textContent?.includes('already invited')); await creator.locator('#cancel').click();
    await alex.locator('#refresh').click(); await alex.waitForSelector(`[data-reviewer-id="${ninaId}"][data-reviewer-status="not-started"]`);
    assert.match(await alex.locator('#completion-status').innerText(), /finished/, 'An invitation does not reopen an already finished participant.');
    const nina = await open({ id: 'nina@example.com', displayName: 'Nina Added Later' });
    assert.equal(await nina.locator('#add-reviewers').isVisible(), false);
    await feedback(nina, 'Feedback from a reviewer invited after creation.');
    await nina.locator('#finish-review').click(); await nina.locator('#body').fill('Late participant finished.'); await submit(nina);
    await nina.reload(); await nina.waitForSelector('#document [data-source-map]');
    assert.equal(await nina.locator('#actor-id').inputValue(), 'nina@example.com');
    assert.match(await nina.locator('#completion-status').innerText(), /finished/);
    await creator.locator('#refresh').click(); await creator.waitForSelector(`[data-reviewer-id="${ninaId}"][data-reviewer-status="finished"]`);
    await creator.locator('#export').click();
    await creator.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('Saved exports/'), undefined, { timeout: 45000 });
    const exported = await creator.evaluate(() => window.omrAutomation!.session()!.events.find((event): event is Extract<Event, { type: 'export.created' }> => event.type === 'export.created'));
    assert.ok(exported);
    if (mode === 'browser-directory') {
      const received = await creator.evaluate(async () => {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('review');
        const files: Array<{ path: string; bytes: number[] }> = [];
        const walk = async (directory: FileSystemDirectoryHandle, prefix: string) => {
          const iterable = directory as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
          for await (const [name, entry] of iterable.entries()) {
            const relative = prefix ? `${prefix}/${name}` : name;
            if (entry.kind === 'directory') await walk(entry as FileSystemDirectoryHandle, relative);
            else files.push({ path: relative, bytes: Array.from(new Uint8Array(await (await (entry as FileSystemFileHandle).getFile()).arrayBuffer())) });
          }
        };
        await walk(root, ''); return files;
      });
      for (const file of received) { await mkdir(path.dirname(path.join(root, file.path)), { recursive: true }); await writeFile(path.join(root, file.path), new Uint8Array(file.bytes)); }
    }
    const pdf = await readFile(path.join(root, exported.pdf.path)), inventory = parseJson<AuditInventory>(await readFile(path.join(root, exported.inventory.path)), LIMITS.inventory);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-'); assert.equal(digest(pdf), inventory.pdf.digest);
    const fresh = new ReviewSession(store); await fresh.open(); await fresh.pin(revisionId); await fresh.audit(fresh.context(actor));
    assert.deepEqual(fresh.diagnostics, []);
    const completionEvents = fresh.events.filter(e => e.type === 'review.completed' || e.type === 'review.reopened');
    assert.equal(completionEvents.length, 4); assert.ok(completionEvents.every(e => inventory.representedEventIds.includes(e.id)));
    const invitations = fresh.events.filter(e => e.type === 'reviewer.invited'); assert.equal(invitations.length, 2);
    assert.ok(invitations.every(e => inventory.representedEventIds.includes(e.id)));
    const ninaEvents = fresh.events.filter(e => e.actor.id === ninaId); assert.ok(ninaEvents.every(e => !!e.reviewerInvitationId));
    assert.equal(digest(await readFile(path.join(root, 'manifest.json'))), digest(originalManifest));
    assert.equal(fresh.events.filter(e => e.type === 'review.approved').length, 0);
    await creator.locator('#reviewer-progress').screenshot({ path: path.join(temporary, 'reviewer-progress.png') });
    if (mode === 'vscode-bridge') {
      const next = await authorReview({ ...request, operationId: 'participation_next_revision', parents: [revisionId] });
      await creator.locator('#refresh').click(); await creator.waitForSelector(`#revisions option[value="${next.revisionId}"]`, { state: 'attached' });
      await creator.locator('#revisions').selectOption(next.revisionId!);
      await creator.waitForFunction(() => document.querySelectorAll('[data-reviewer-status="not-started"]').length === 5);
      await creator.locator('#revisions').selectOption(revisionId);
      await creator.waitForSelector(`[data-reviewer-id="${alexId}"][data-reviewer-status="finished"]`);
    }
    for (const width of [320, 768, 1440]) { await alex.setViewportSize({ width, height: 1000 }); assert.equal(await alex.locator('#reopen-review').isVisible(), true); assert.equal(await alex.locator('#actor-id').isVisible(), true); }
    assert.deepEqual(errors, []);
    process.stdout.write(`Participant archive (${mode}): ${path.join(root, exported.pdf.path)}\n`);
  } finally { await browser.close(); }
});
