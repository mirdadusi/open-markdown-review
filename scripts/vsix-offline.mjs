import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, lstat, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import os from 'node:os';
import yauzl from 'yauzl';
import { bundleName, verifyMacQualification } from './companion-bundle.mjs';

const unixCompanion = /^extension\/dist\/bundled-companions\/(darwin-arm64|linux-x64)\/StartReview$/;
function safeName(name) {
  assert.ok(typeof name === 'string' && !name.includes('\\') && !name.includes('\0') && !name.startsWith('/') && !/^[A-Za-z]:/.test(name));
  assert.ok(!name.split('/').some(part => part === '..' || part === '.'));
}
async function openArchive(file) {
  const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value)));
  const entries = new Map(), centralOffsets = new Map(); let total = 0;
  try {
    for (;;) {
      const centralOffset = zip.readEntryCursor;
      const entry = await new Promise((resolve, reject) => {
        const cleanup = () => { zip.removeListener('entry', onEntry); zip.removeListener('end', onEnd); zip.removeListener('error', onError); };
        const onEntry = value => { cleanup(); resolve(value); }, onEnd = () => { cleanup(); resolve(undefined); }, onError = error => { cleanup(); reject(error); };
        zip.once('entry', onEntry); zip.once('end', onEnd); zip.once('error', onError); zip.readEntry();
      });
      if (!entry) break;
      safeName(entry.fileName); assert.ok(!entries.has(entry.fileName), 'Duplicate VSIX entry.');
      assert.notEqual((entry.externalFileAttributes >>> 16) & 0xf000, 0xa000, 'Linked VSIX entries are refused.');
      assert.ok(!entry.fileName.startsWith('extension/experiments/'), 'Experimental clients must never ship in the authoring VSIX.');
      total += entry.uncompressedSize; assert.ok(entries.size < 20000 && total < 1024 * 1024 * 1024, 'VSIX exceeds bounded verification limits.');
      entries.set(entry.fileName, entry);
      centralOffsets.set(entry.fileName, centralOffset);
    }
    return { zip, entries, centralOffsets };
  } catch (error) { zip.close(); throw error; }
}
/** Seal only the two known POSIX executables in a freshly built VSIX.
 * Windows filesystems cannot represent their execute bits. ZIP metadata can.
 * Change twelve central-directory bytes; never recompress or alter a payload.
 * The complete archive/hash verifier must run afterwards, before checksumming.
 */
export async function sealNativeExecutableModes(file) {
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 256 * 1024 * 1024);
  const { zip, entries, centralOffsets } = await openArchive(file);
  const selected = [...entries.values()].filter(entry => unixCompanion.test(entry.fileName));
  try {
    assert.equal(selected.length, 2, 'Both known POSIX companions are required before mode sealing.');
    for (const entry of selected) assert.equal((entry.externalFileAttributes >>> 16) & 0xf000, 0x8000, 'Only regular companion files may be sealed.');
  } finally { zip.close(); }
  const handle = await open(file, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    assert.ok(current.isFile()); assert.equal(current.ino, info.ino); assert.equal(current.dev, info.dev); assert.equal(current.size, info.size);
    const edits = [];
    for (const entry of selected) {
      const offset = centralOffsets.get(entry.fileName), name = Buffer.from(entry.fileName, 'utf8'), header = Buffer.alloc(46 + name.length);
      assert.ok(Number.isSafeInteger(offset) && offset >= 0 && offset + header.length <= current.size);
      assert.equal((await handle.read(header, 0, header.length, offset)).bytesRead, header.length);
      assert.equal(header.readUInt32LE(0), 0x02014b50); assert.equal(header.readUInt16LE(28), name.length);
      assert.deepEqual(header.subarray(46), name);
      assert.equal(header.readUInt16LE(4), entry.versionMadeBy); assert.equal(header.readUInt32LE(38), entry.externalFileAttributes);
      const producer = Buffer.alloc(2), attributes = Buffer.alloc(4);
      producer.writeUInt16LE((3 << 8) | (entry.versionMadeBy & 0xff)); // Unix creator, even when packaged on Windows.
      attributes.writeUInt32LE((0o100755 << 16) >>> 0);
      edits.push([offset + 4, producer], [offset + 38, attributes]);
    }
    for (const [position, value] of edits) assert.equal((await handle.write(value, 0, value.length, position)).bytesWritten, value.length);
    await handle.sync();
  } finally { await handle.close(); }
}
async function stream(zip, entry) {
  assert.ok(entry, 'A required VSIX entry is missing.');
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
}
async function bytes(zip, entry, maximum) {
  assert.ok(entry && entry.uncompressedSize <= maximum, 'Required VSIX metadata is missing or excessive.');
  const chunks = []; for await (const chunk of await stream(zip, entry)) chunks.push(chunk);
  return Buffer.concat(chunks);
}
export async function verifyOfflineVsix(file, expectedCatalog) {
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 256 * 1024 * 1024, 'VSIX exceeds the new updater budget or is not a regular file.');
  const { zip, entries } = await openArchive(file);
  const get = name => entries.get(`extension/${name}`);
  try {
    const pkg = JSON.parse(await bytes(zip, get('package.json'), 1024 * 1024));
    const catalog = JSON.parse(await bytes(zip, get('dist/companion-catalog.json'), 1024 * 1024));
    assert.equal(pkg.version, catalog.version); assert.equal(catalog.delivery, 'bundled-v1');
    assert.equal(catalog.schemaVersion,'omr-companion-catalog/2');assert.equal(catalog.runtime,'go','Only Go companions may be bundled by default.');
    assert.equal(pkg.name, 'open-markdown-review');
    assert.equal(pkg.publisher, 'mirdadusi');
    if (expectedCatalog) assert.deepEqual(catalog, expectedCatalog, 'Packaged catalog differs from source.');
    assert.deepEqual(catalog.targets.map(item => item.target).sort(), ['darwin-arm64', 'linux-x64', 'win32-x64']);
    const requiredBundle = catalog.targets.flatMap(item => {
      const base = `extension/dist/bundled-companions/${item.target}/`;
      return [bundleName(item.target), 'THIRD-PARTY-NOTICES.txt', 'build.json', ...(item.target === 'darwin-arm64' ? ['qualification.json'] : [])].map(name => base + name);
    }).sort();
    assert.deepEqual([...entries.keys()].filter(name => name.startsWith('extension/dist/bundled-companions/') && !name.endsWith('/')).sort(), requiredBundle, 'Unexpected or missing bundled VSIX payloads.');
    const hashEntry = async (name, digest, length) => {
      const entry = get(name); assert.ok(entry, `Missing bundled file ${name}`);
      if (length !== undefined) assert.equal(entry.uncompressedSize, length);
      const hash = createHash('sha256'); for await (const chunk of await stream(zip, entry)) hash.update(chunk);
      assert.equal(`sha256:${hash.digest('hex')}`, digest, `Packaged checksum mismatch: ${name}`);
    };
    await hashEntry('dist/OpenMarkdownReview.html', catalog.toolboxDigest);
    await hashEntry('dist/companion-core.js', catalog.companionDigest);
    for (const item of catalog.targets) {
      assert.equal(item.build.schemaVersion,'omr-go-build/1');assert.equal(item.build.runtime,'go');assert.equal(item.build.testFaults,false,'Test-only binaries must never ship.');
      assert.equal(item.build.digest,item.executable.digest);assert.equal(item.build.inputs.core,catalog.companionDigest);assert.equal(item.build.inputs.toolbox,catalog.toolboxDigest);
      const base = `dist/bundled-companions/${item.target}`;
      if (item.target !== 'win32-x64') {
        const entry = get(`${base}/${bundleName(item.target)}`);
        assert.ok(entry, 'Missing POSIX companion.');
        assert.equal(entry.versionMadeBy >>> 8, 3, 'POSIX companion requires Unix ZIP metadata.');
        assert.equal(entry.externalFileAttributes >>> 16, 0o100755, 'POSIX companion must retain executable mode 0755 in the VSIX.');
      }
      await hashEntry(`${base}/${bundleName(item.target)}`, item.executable.digest, item.executable.byteLength);
      await hashEntry(`${base}/THIRD-PARTY-NOTICES.txt`, item.notices.digest, item.notices.byteLength);
      assert.deepEqual(JSON.parse(await bytes(zip, get(`${base}/build.json`), 16384)), item.build);
    }
    verifyMacQualification(JSON.parse(await bytes(zip, get('dist/bundled-companions/darwin-arm64/qualification.json'), 65536)), catalog);
    return catalog;
  } finally { zip.close(); }
}
/** Extract a verified authoring artifact to a fresh private test directory. */
export async function extractVsix(file) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omr-offline-vsix-'));
  const { zip, entries } = await openArchive(file);
  try {
    for (const entry of entries.values()) {
      if (entry.fileName.endsWith('/')) continue;
      const target = path.join(root, ...entry.fileName.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      // Our private test extraction must preserve only the known native payloads'
      // execution bit, as VS Code's installer does; no arbitrary archive modes.
      const native = unixCompanion.test(entry.fileName);
      if (native) assert.equal(entry.externalFileAttributes >>> 16, 0o100755, 'Extraction must not repair a broken executable mode.');
      await pipeline(await stream(zip, entry), createWriteStream(target, { flags: 'wx', mode: native ? 0o700 : 0o600 }));
    }
    return path.join(root, 'extension');
  } finally { zip.close(); }
}
