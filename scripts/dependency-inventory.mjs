import { readFile, readdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const profile = process.argv[2] ?? 'runtime';
if (!['toolbox', 'runtime'].includes(profile)) throw new Error('Unknown dependency inventory profile.');
const root = process.cwd(), seeds = new Set();
const metadata = profile === 'toolbox' ? ['toolbox'] : ['toolbox', 'extension', 'cli'];
for (const name of metadata) {
  const meta = JSON.parse(await readFile(path.join(root, 'dist', `${name}-metafile.json`), 'utf8'));
  for (const input of Object.keys(meta.inputs)) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (match) seeds.add(path.resolve(match[1]));
  }
}
if (profile === 'runtime') seeds.add(path.join(root, 'node_modules/sharp'));
async function dependency(directory, name) {
  for (let cursor = directory; ; cursor = path.dirname(cursor)) {
    const candidate = path.join(cursor, 'node_modules', name);
    try { await access(path.join(candidate, 'package.json')); return candidate; } catch { /* Search ordinary Node resolution parents. */ }
    if (path.dirname(cursor) === cursor) return undefined;
  }
}
const packages = new Map(), queue = [...seeds], missing = [];
while (queue.length) {
  const directory = queue.shift(); if (packages.has(directory)) continue;
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  packages.set(directory, pkg);
  // Prebundled pdfmake and Mermaid contain dependencies not individually visible
  // in esbuild metadata. Include their conservative production closure as well.
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    const resolved = await dependency(directory, name);
    if (resolved) queue.push(resolved);
    else if (!pkg.optionalDependencies?.[name]) missing.push(`${pkg.name}: ${name}`);
  }
}
if (missing.length) throw new Error(`Incomplete dependency inventory: ${missing.join(', ')}`);
const components = [], notices = [];
for (const [directory, pkg] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name) || a[1].version.localeCompare(b[1].version))) {
  const files = (await readdir(directory)).filter(name => /^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/i.test(name));
  const licenses = [];
  for (const file of files) { try { const text = await readFile(path.join(directory, file), 'utf8'); licenses.push({ file, sha256: createHash('sha256').update(text).digest('hex') }); notices.push(`${pkg.name}@${pkg.version} — ${file}\n${text}`); } catch { /* Some distributions have a license directory. */ } }
  components.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? 'UNDECLARED', packagePath: path.relative(root, directory).split(path.sep).join('/'), directlyVisibleToBundler: seeds.has(directory), notices: licenses });
}
for (const file of ['LICENSE', 'third-party/UNICODE.txt', 'third-party/ROBOTO.txt']) {
  try { notices.push(`${file}\n${await readFile(file, 'utf8')}`); } catch { if (file.startsWith('third-party/')) throw new Error(`Required data/font notice is missing: ${file}`); }
}
const inventory = { schemaVersion: 'omr-runtime-inventory/1', profile, interpretation: 'Conservative production dependency closure seeded from actual bundle inputs; includes upstream prebundled transitives. Optional packages absent on this platform are not asserted to be shipped.', components };
await writeFile(`dist/${profile}-dependencies.json`, JSON.stringify(inventory, null, 2) + '\n');
await writeFile(`dist/${profile}-NOTICES.txt`, notices.join('\n\n' + '='.repeat(72) + '\n\n'));
console.log(`Inventoried ${components.length} ${profile} dependency packages.`);
