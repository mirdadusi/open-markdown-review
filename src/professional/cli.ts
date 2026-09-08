#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { authorReview, installClient, updateClient } from './authoring';
import { NativeStorage } from './nativeStorage';
import { ReviewSession } from './session';
import { storageResponse } from './bridge';
import { parseJson } from './bytes';
import { LIMITS, ProtocolError } from './types';
import { validate } from './validation';
import { applyAcceptedSuggestion } from './applySuggestion';
import { checkpoint, OperationControl } from './operation';

export async function runCli(argv: string[], artifact = path.resolve(__dirname, 'OpenMarkdownReview.html'), control: OperationControl = {}): Promise<{ exitCode: number; result: unknown }> {
  if (!argv.length || argv.includes('--help')) return { exitCode: 0, result: { schemaVersion: 'omr-cli-result/1', ok: true, outcome: 'completed', help: 'omr review create --source PATH --store PATH --root-document FILE --actor-id ID --operation-id ID [--include FILE] [--include-dir DIR] [--exclude PATH] [--resource-root PATH] [--policy FILE] [--dry-run] [--resume]\nomr revision create (same parameters, plus repeatable --parent REVISION)\nomr review inspect|validate --store PATH [--revision ID]\nomr review export --store PATH --actor-id ID --operation-id ID [--revision ID] [--browser-executable PATH]\nomr client install --store PATH\nomr client update --store PATH --expect-client-digest sha256:HEX\nomr suggestion apply --store PATH --source PATH --revision ID --suggestion ID --expect-source-digest sha256:HEX --actor-id ID --operation-id ID [--resume]\nAll commands emit JSON; --json is accepted explicitly. Node 22+ is required. Export additionally requires the Playwright Chromium runtime.' } };
  const [group, command, ...raw] = argv, flags = new Map<string, string[]>();
  const booleans = new Set(['json', 'dry-run', 'full', 'resume']);
  const known = new Set(['source', 'store', 'title', 'include', 'include-dir', 'exclude', 'root-document', 'actor-id', 'actor-name', 'operation-id', 'parent', 'resource-root', 'policy', 'revision', 'browser-executable', 'suggestion', 'expect-source-digest', 'expect-client-digest', ...booleans]);
  const result: Record<string, unknown> = { schemaVersion: 'omr-cli-result/1', command: `${group} ${command}`, ok: false, outcome: 'failed' };
  try {
    checkpoint(control);
    for (let i = 0; i < raw.length; i++) { const key = raw[i].replace(/^--/, ''); if (!raw[i].startsWith('--') || !known.has(key)) throw new ProtocolError('invalid', `Unknown parameter: ${raw[i]}`); const value = booleans.has(key) ? 'true' : raw[++i]; if (!value || value.startsWith('--')) throw new ProtocolError('invalid', `Missing value for --${key}`); flags.set(key, [...(flags.get(key) ?? []), value]); }
    const creation = ['source', 'title', 'include', 'include-dir', 'exclude', 'root-document', 'actor-id', 'actor-name', 'operation-id', 'resource-root', 'policy', 'dry-run', 'resume'];
    const supported: Record<string, string[]> = { 'review create': creation, 'revision create': [...creation, 'parent'], 'review inspect': [], 'review validate': ['revision', 'full'], 'review export': ['revision', 'actor-id', 'actor-name', 'operation-id', 'browser-executable'], 'client install': [], 'client update': ['expect-client-digest'], 'suggestion apply': ['source', 'revision', 'suggestion', 'expect-source-digest', 'actor-id', 'actor-name', 'operation-id', 'resume'] };
    const accepted = supported[`${group} ${command}`];
    if (!accepted) throw new ProtocolError('invalid', 'Unknown command. Run omr --help.');
    for (const key of flags.keys()) if (!['store', 'json', ...accepted].includes(key)) throw new ProtocolError('invalid', `--${key} does not apply to ${group} ${command}.`);
    const one = (key: string, required = false) => { const values = flags.get(key); if ((values?.length ?? 0) > 1) throw new ProtocolError('invalid', `--${key} may appear only once.`); if (required && !values?.[0]) throw new ProtocolError('invalid', `--${key} is required.`); return values?.[0]; };
    const root = path.resolve(one('store', true)!), journalRoot = path.join(os.homedir(), '.open-markdown-review', 'recovery'), store = new NativeStorage(root, journalRoot);
    const actor = () => ({ id: one('actor-id', true)!, ...(one('actor-name') ? { displayName: one('actor-name') } : {}) });
    const operation = () => one('operation-id', true)!;
    if (group === 'suggestion' && command === 'apply') {
      const expected = one('expect-source-digest', true)!; if (!/^sha256:[a-f0-9]{64}$/.test(expected)) throw new ProtocolError('invalid', 'Expected source digest must be a SHA-256 digest.');
      const applied = await applyAcceptedSuggestion({ store, source: path.resolve(one('source', true)!), revisionId: one('revision', true)!, suggestionId: one('suggestion', true)!, expectedSourceDigest: expected as `sha256:${string}`, actor: actor(), operationId: operation(), resume: flags.has('resume') });
      return { exitCode: 0, result: { ...result, ok: true, ...applied } };
    }
    if (group === 'review' && command === 'create' || group === 'revision' && command === 'create') {
      const policyFile = one('policy');
      const created = await authorReview({ source: path.resolve(one('source', true)!), store: root, title: one('title'), include: flags.get('include'), includeDir: flags.get('include-dir'), exclude: flags.get('exclude'), rootDocument: one('root-document', true)!, actor: actor(), operationId: flags.has('dry-run') ? one('operation-id') ?? 'dry_run' : operation(), parents: group === 'revision' ? flags.get('parent') ?? [] : undefined, resourceRoots: flags.get('resource-root'), policy: policyFile ? validate('policy', parseJson(await readFile(policyFile), LIMITS.policy)) : undefined, dryRun: flags.has('dry-run'), resume: flags.has('resume'), clientArtifact: artifact, journalRoot, ...control });
      Object.assign(result, created, { operationId: one('operation-id'), ok: created.outcome !== 'review-created-client-failed' });
      return { exitCode: created.outcome === 'review-created-client-failed' ? 7 : 0, result };
    }
    if (group === 'client' && command === 'install') { const target = await installClient(store, artifact); return { exitCode: 0, result: { ...result, ok: true, outcome: 'completed', browserClientPath: target } }; }
    if (group === 'client' && command === 'update') { const updated = await updateClient(store, artifact, one('expect-client-digest', true)!); return { exitCode: 0, result: { ...result, ok: true, outcome: 'completed', ...updated } }; }
    if (group !== 'review' || !['inspect', 'validate', 'export'].includes(command)) throw new ProtocolError('invalid', 'Supported commands: review create/inspect/validate/export, revision create, client install.');
    const session = new ReviewSession(store); await session.open();
    if (command === 'inspect') return { exitCode: session.diagnostics.length ? 3 : 0, result: { ...result, ok: !session.diagnostics.length, outcome: 'completed', manifest: session.manifest, revisions: [...session.revisions.values()].map(r => ({ id: r.id, parents: r.parents, rootDocument: r.rootDocument })), heads: session.heads.map(r => r.id), events: session.events.length, diagnostics: session.diagnostics } };
    const revision = one('revision') ?? session.revision?.id; if (!revision) throw new ProtocolError('invalid', 'Choose --revision explicitly when there are multiple heads.'); await session.pin(revision);
    if (command === 'validate') { const audit = await session.audit(session.context({ id: 'validation' })); return { exitCode: 0, result: { ...result, ok: true, outcome: 'completed', inventory: audit.inventory } }; }
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true, channel: 'chromium', ...(one('browser-executable') ? { executablePath: one('browser-executable') } : {}) });
    try {
      const page = await browser.newPage(); await page.exposeFunction('omrHost', (method: string, args: unknown[]) => storageResponse(store, method, args));
      await page.goto(pathToFileURL(artifact).href); await page.waitForFunction(() => !!window.omrAutomation?.session()?.revision, { timeout: 60000 });
      const exported = await page.evaluate(async ({ actor, revision, operation }) => window.omrAutomation!.export(actor, revision, operation), { actor: actor(), revision, operation: operation() });
      return { exitCode: 0, result: { ...result, ok: true, outcome: 'completed', ...exported as object } };
    } finally { await browser.close(); }
  } catch (error) {
    const nativeCode = (error as NodeJS.ErrnoException).code;
    const code = error instanceof ProtocolError ? error.code : nativeCode === 'ENOENT' ? 'missing' : nativeCode === 'EACCES' || nativeCode === 'EPERM' ? 'permission' : 'uncertain';
    const message = error instanceof Error ? error.message : String(error);
    Object.assign(result, { error: { code, message }, diagnostics: [{ code, severity: 'error', message }], outcome: code === 'uncertain' ? 'uncertain' : 'failed' });
    return { exitCode: code === 'invalid' || code === 'unsupported' ? 2 : code === 'integrity' ? 3 : code === 'changed' ? 5 : code === 'cancelled' ? 6 : code === 'uncertain' ? 7 : 4, result };
  }
}
if (require.main === module) {
  const controller = new AbortController(), cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  void runCli(process.argv.slice(2), undefined, { signal: controller.signal, progress: message => process.stderr.write(message + '\n') }).then(({ exitCode, result }) => {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = exitCode;
  });
}
