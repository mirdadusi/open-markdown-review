import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pipeline} from 'node:stream/promises';
import yazl from 'yazl';

export function fixture() {
  const files = new Map(), hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const put = (name, value) => files.set(`extension/${name}`, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  put('package.json', { name: 'open-markdown-review', publisher: 'mirdadusi', version: '0.6.1' });
  put('dist/OpenMarkdownReview.html', 'inert test toolbox'); put('dist/companion-core.js', 'inert test runtime');
  const catalog = { schemaVersion: 'omr-companion-catalog/2', runtime: 'go', version: '0.6.1', delivery: 'bundled-v1', toolboxDigest: hash(files.get('extension/dist/OpenMarkdownReview.html')), companionDigest: hash(files.get('extension/dist/companion-core.js')), targets: [] };
  for (const target of ['darwin-arm64', 'linux-x64', 'win32-x64']) {
    const base = `dist/bundled-companions/${target}`, name = target === 'win32-x64' ? 'StartReview.exe' : 'StartReview';
    put(`${base}/${name}`, `inert ${target}`); put(`${base}/THIRD-PARTY-NOTICES.txt`, 'test notices');
    const item = { target };
    for (const [kind, file] of [['executable', name], ['notices', 'THIRD-PARTY-NOTICES.txt']]) {
      const bytes = files.get(`extension/${base}/${file}`); item[kind] = { digest: hash(bytes), byteLength: bytes.length };
    }
    item.build = { schemaVersion: 'omr-go-build/1', runtime: 'go', version: catalog.version, target, toolchain: 'go1.27.3', testFaults: false, digest: item.executable.digest, inputs: { core: catalog.companionDigest, toolbox: catalog.toolboxDigest, notices: item.notices.digest } };
    put(`${base}/build.json`, item.build); catalog.targets.push(item);
  }
  put('dist/bundled-companions/darwin-arm64/qualification.json', { schemaVersion: 'omr-local-qualification/1', runtime: 'go', version: catalog.version, platform: 'darwin', arch: 'arm64', toolchain: 'go1.27.3', executedAt: '2026-10-18T08:00:00Z', executableDigest: catalog.targets[0].executable.digest, toolboxDigest: catalog.toolboxDigest, companionDigest: catalog.companionDigest, suites: ['native-browser-and-launcher', 'vscode-native-creation'].map(name => ({ name, exitCode: 0, logDigest: hash('test log') })) });
  put('dist/companion-catalog.json', catalog);
  return { files, catalog };
}
export async function archive(files, duplicate, symlink, nativeMode = 0o100755) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omr-vsix-unit-')), file = path.join(directory, 'test.vsix'), zip = new yazl.ZipFile();
  for (const [name, bytes] of files) zip.addBuffer(bytes, name, { mode: name === symlink ? 0o120777 : /\/bundled-companions\/(darwin-arm64|linux-x64)\/StartReview$/.test(name) ? nativeMode : 0o100644 });
  if (duplicate) zip.addBuffer(Buffer.from('duplicate'), duplicate);
  zip.end(); await pipeline(zip.outputStream, createWriteStream(file, { flags: 'wx' })); return file;
}
