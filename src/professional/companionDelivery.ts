import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { COMPANION_TARGETS, CompanionTarget, companionTargets } from './companionTargets';
import { digest, encode, parseJson } from './bytes';
import { NativeStorage, contained } from './nativeStorage';
import { ProtocolError } from './types';
import { OperationControl, checkpoint } from './operation';
import { allowedCompanionRedirect, companionReleaseBase, companionReleaseResolver, CompanionToken } from './companionRelease';

export interface CompanionArtifact { filename: string; byteLength: number; digest: string; url?: string }
export interface CompanionBuild {
  schemaVersion: 'omr-go-build/1'; runtime: 'go'; version: string; target: CompanionTarget;
  toolchain: string; testFaults: false; digest: string; byteLength: number; qualified: boolean;
  inputs: { hostSource: string; core: string; toolbox: string; notices: string; goMod: string; goSum: string };
  codeSigning: string; qualification: string;
}
export interface CompanionCatalog {
  schemaVersion: 'omr-companion-catalog/2'; runtime: 'go'; version: string; companionDigest: string; toolboxDigest: string;
  /** Installed authoring clients must never download a missing offline payload. */
  delivery?: 'bundled-v1';
  targets: Array<{ target: CompanionTarget; executable: CompanionArtifact; notices: CompanionArtifact; build: CompanionBuild }>;
}
interface ReadyFile { source: string; filename: string; byteLength: number; digest: string }
export interface PreparedCompanions { targets: CompanionTarget[]; catalogDigest: string; files: ReadyFile[]; version: string }
const MAX_EXECUTABLE = 160 * 1024 * 1024, MAX_CATALOG = 1024 * 1024;
const flights = new Map<string, Promise<string>>();
const hex = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
function invalid(message: string): never { throw new ProtocolError('invalid', message); }

/** Streaming hashing avoids holding another complete native runtime in memory. */
export async function companionFileDigest(file: string, maximum = MAX_EXECUTABLE): Promise<{ digest: string; byteLength: number }> {
  const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) invalid('Companion artifact is not a bounded regular file.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat(), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024); let position = 0;
    if (!before.isFile() || before.size > maximum) invalid('Companion artifact changed or exceeds its limit.');
    while (position < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (!bytesRead) throw new ProtocolError('changed', 'Companion artifact became shorter.');
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new ProtocolError('changed', 'Companion artifact changed during verification.');
    return { digest: `sha256:${hash.digest('hex')}`, byteLength: position };
  } finally { await handle.close(); }
}
function releaseUrl(value: unknown, version: string): value is string {
  if (typeof value !== 'string') return false;
  const prefix = `${companionReleaseBase}/download/v${version}/`;
  return value.startsWith(prefix) && /^[A-Za-z0-9._-]+$/.test(value.slice(prefix.length));
}
export async function readCompanionCatalog(artifact: string, catalogFile = path.join(path.dirname(artifact), 'companion-catalog.json')): Promise<{ catalog: CompanionCatalog; bytes: Uint8Array }> {
  const info = await lstat(catalogFile); if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CATALOG) invalid('Use a trusted, bounded companion catalog shipped with the client.');
  const bytes = await readFile(catalogFile), catalog = parseJson<CompanionCatalog>(bytes, MAX_CATALOG);
  if (catalog.schemaVersion !== 'omr-companion-catalog/2' || catalog.runtime !== 'go' || !/^\d+\.\d+\.\d+$/.test(catalog.version) || !hex(catalog.companionDigest) || !hex(catalog.toolboxDigest) || !Array.isArray(catalog.targets) || catalog.targets.length !== COMPANION_TARGETS.length) invalid('A complete Go companion distribution catalog is required. Legacy Node is not a default or fallback.');
  if (catalog.delivery !== undefined && catalog.delivery !== 'bundled-v1') invalid('Unsupported companion delivery mode.');
  companionTargets(catalog.targets.map(entry => entry?.target));
  if ((await companionFileDigest(artifact, 64 * 1024 * 1024)).digest !== catalog.toolboxDigest || (await companionFileDigest(path.join(path.dirname(artifact), 'companion-core.js'), 16 * 1024 * 1024)).digest !== catalog.companionDigest) throw new ProtocolError('changed', 'Companion catalog is stale for this client build. Prepare matching Go distributions before creating a companion-enabled review.');
  for (const entry of catalog.targets) {
    const target = COMPANION_TARGETS.find(target => target.id === entry.target)!;
    for (const [kind, item] of [['executable', entry.executable], ['notices', entry.notices]] as const) {
      const expected = kind === 'executable' ? target.filename : `${target.filename}.NOTICES.txt`;
      if (!item || item.filename !== expected || !hex(item.digest) || !Number.isSafeInteger(item.byteLength) || item.byteLength < 1 || item.byteLength > (kind === 'executable' ? MAX_EXECUTABLE : 4 * 1024 * 1024) || !(catalog.delivery === 'bundled-v1' && item.url === undefined || releaseUrl(item.url, catalog.version))) invalid('Invalid pinned companion artifact.');
    }
    const build = entry.build;
    if (!build || build.schemaVersion !== 'omr-go-build/1' || build.runtime !== 'go' || build.version !== catalog.version || build.target !== entry.target || build.toolchain !== 'go1.27.3' || build.testFaults !== false || build.digest !== entry.executable.digest || build.byteLength !== entry.executable.byteLength || !build.inputs || !Object.values(build.inputs).every(hex) || build.inputs.core !== catalog.companionDigest || build.inputs.toolbox !== catalog.toolboxDigest || build.inputs.notices !== entry.notices.digest || !hex(build.inputs.hostSource) || !hex(build.inputs.goMod) || !hex(build.inputs.goSum) || typeof build.codeSigning !== 'string' || typeof build.qualification !== 'string') invalid('Go companion build receipt does not match the pinned production distribution.');
  }
  return { catalog, bytes };
}
async function matches(file: string, expected: Pick<CompanionArtifact, 'filename' | 'digest' | 'byteLength'>): Promise<boolean> {
  try { const actual = await companionFileDigest(file); if (actual.digest !== expected.digest || actual.byteLength !== expected.byteLength) throw new ProtocolError('integrity', `Companion artifact failed verification: ${expected.filename}`); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function resolveArtifact(item: CompanionArtifact, target: CompanionTarget, artifactRoot: string, cacheRoot: string, control: OperationControl, version: string, resolveRelease: ReturnType<typeof companionReleaseResolver>, bundled = false): Promise<string> {
  const localName = item.filename.endsWith('.NOTICES.txt') ? 'THIRD-PARTY-NOTICES.txt' : target.startsWith('win32') ? 'StartReview.exe' : 'StartReview';
  if (bundled) {
    const installed = path.join(artifactRoot, 'bundled-companions', target, localName);
    if (await matches(installed, item)) return installed;
  }
  const local = path.join(artifactRoot, 'companion-go', target, localName);
  if (await matches(local, item)) return local;
  if (bundled) throw new ProtocolError('missing', `The installed client is missing its bundled ${item.filename}. Reinstall the complete authoring VSIX. No download or authentication was attempted, and no review evidence was published.`);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const relative = `${item.digest.slice(7)}/${item.filename}`, file = await contained(cacheRoot, relative, true);
  if (await matches(file, item)) return file;
  const existing = flights.get(file); if (existing) return existing;
  const flight = (async () => {
    checkpoint(control, `Downloading ${item.filename} (${Math.ceil(item.byteLength / 1048576)} MiB)…`);
    const signal = control.signal ? AbortSignal.any([control.signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
    const asset = await resolveRelease(version, item.filename, item.byteLength, signal);
    let url = asset.url, response: Response | undefined;
    // Authenticate only the exact validated API asset URL. Never forward a
    // credential to a redirect, including a same-host redirect.
    for (let hop = 0; hop < 5; hop++) {
      if (hop > 0 && !allowedCompanionRedirect(url)) invalid('Unexpected companion download host.');
      response = await fetch(url, { redirect: 'manual', signal, credentials: 'omit', headers: hop === 0 ? asset.headers : { Accept: 'application/octet-stream' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) { const location = response.headers.get('location'); await response.body?.cancel(); if (!location) invalid('Companion redirect has no location.'); url = new URL(location, url).href; continue; }
      break;
    }
    if (!response?.ok || !response.body || response.status !== 200) throw new ProtocolError('missing', `Companion download is unavailable (HTTP ${response?.status ?? 'unknown'}). No review evidence was published. Install the matching trusted distribution in the client cache or retry after release publication.`);
    const length = response.headers.get('content-length'); if (length && Number(length) !== item.byteLength) { await response.body.cancel(); throw new ProtocolError('integrity', 'Companion download length differs from its catalog.'); }
    const temporary = await contained(cacheRoot, `${item.digest.slice(7)}/${item.filename}.${randomUUID()}.pending`), handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    const hash = createHash('sha256'); let size = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        checkpoint(control); size += chunk.length; if (size > item.byteLength) throw new ProtocolError('integrity', 'Companion download exceeds its pinned size.');
        hash.update(chunk); let offset = 0;
        while (offset < chunk.length) { const part = await handle.write(chunk, offset); if (!part.bytesWritten) throw new ProtocolError('uncertain', 'Companion cache write made no progress.'); offset += part.bytesWritten; }
      }
      if (size !== item.byteLength || `sha256:${hash.digest('hex')}` !== item.digest) throw new ProtocolError('integrity', 'Companion download failed its exact-byte checksum.');
      await handle.sync();
    } finally { await handle.close(); }
    checkpoint(control);
    if (!await matches(file, item)) await rename(temporary, file);
    await matches(file, item); return file;
  })();
  flights.set(file, flight); try { return await flight; } finally { if (flights.get(file) === flight) flights.delete(file); }
}
export async function prepareCompanions(options: OperationControl & { targets: unknown; artifact: string; journalRoot: string; catalogFile?: string; companionToken?: CompanionToken }): Promise<PreparedCompanions | undefined> {
  const targets = companionTargets(options.targets); if (!targets.length) return;
  const { catalog, bytes } = await readCompanionCatalog(options.artifact, options.catalogFile);
  const files: ReadyFile[] = [];
  const resolveRelease = companionReleaseResolver(options.companionToken);
  for (const target of targets) {
    const entry = catalog.targets.find(entry => entry.target === target); if (!entry) throw new ProtocolError('missing', `The trusted catalog has no ${target} companion. No review evidence was published.`);
    checkpoint(options, `Verifying the ${target} companion…`);
    for (const item of [entry.executable, entry.notices]) {
      const source = await resolveArtifact(item, target, path.dirname(options.artifact), path.join(options.journalRoot, 'companion-cache', catalog.version), options, catalog.version, resolveRelease, catalog.delivery === 'bundled-v1');
      // Notices remain verified in the trusted distribution and embedded in Go.
      // Only executable bytes are delivered to the participant's review folder.
      if (item === entry.executable) files.push({ ...item, source });
    }
  }
  return { targets, catalogDigest: digest(bytes), files, version: catalog.version };
}
export function companionMetadata(prepared: PreparedCompanions): Array<{ filename: string; bytes: Uint8Array }> {
  const selected = prepared.targets.map(id => COMPANION_TARGETS.find(target => target.id === id)!);
  const instructions = `Open Markdown Review ${prepared.version} — Go companion

Synchronize the COMPLETE review folder and make its contents available locally.
Run only a trusted, organization-approved companion. Keep it running until saves finish.

Available launchers:
${selected.map(target => `${target.label}: ${target.filename}${target.id === 'win32-x64' ? ' (double-click)' : ` (run ./${target.filename}; macOS may also open it from Finder)`}`).join('\n')}

The containing folder is the review. Your default browser opens a private 127.0.0.1 session, without a browser folder picker. Enter your invited email and display name. Email is self-asserted, not Windows/Entra authentication.
No Node.js, Python, Go or VS Code installation is needed for these executables. OS permissions and company application/localhost policies still apply. Never disable security controls.
Stop with the browser Stop local companion button or Ctrl+C, after pending saves/exports complete.
Each participant runs their own companion; OneDrive or the chosen transport synchronizes the review events.
For slow storage, keep the executable locally and use --store ABSOLUTE_REVIEW_FOLDER.

VS Code and the review-named HTML remain alternative clients for this SAME review. Direct HTML still needs browser directory permission.
Checksums, build receipts and signing status belong to the trusted authoring distribution/release, not this review folder. Verify launchers against that trusted channel; checksums alone are not publisher authentication.
License notices are embedded; run a launcher with --licenses to read them. macOS builds may require signing/notarization and Linux file managers differ in executable-launch behavior.
Node companions are legacy only. Do not launch executables in client-backups; use the current platform-named launcher above.
Review evidence stays in manifest.json, events/, revisions/, blobs/ and exports/. Do not edit or replace it.
`;
  return [{ filename: 'START-HERE.txt', bytes: encode(instructions) }];
}
export async function installCompanions(store: NativeStorage, prepared: PreparedCompanions, progress?: (message: string) => void): Promise<string[]> {
  const paths: string[] = [];
  for (const file of prepared.files) {
    progress?.(`Installing ${file.filename} (${Math.ceil(file.byteLength / 1048576)} MiB)…`);
    const expected = { digest: file.digest, byteLength: file.byteLength };
    const destination = await contained(store.root, file.filename);
    if (!await matches(destination, file)) {
      const actual = await companionFileDigest(file.source);
      if (actual.digest !== expected.digest || actual.byteLength !== expected.byteLength) throw new ProtocolError('changed', 'Companion source changed after creation preflight.');
      try { await copyFile(file.source, destination, constants.COPYFILE_EXCL); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !await matches(destination, file)) throw error; }
      await matches(destination, file);
      const handle = await open(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); try { await handle.chmod(0o755); } finally { await handle.close(); }
    }
    paths.push(destination);
  }
  for (const file of companionMetadata(prepared)) { await store.write(file.filename, file.bytes, false); paths.push(path.join(store.root, file.filename)); }
  return paths;
}
