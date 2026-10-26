import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifySlidevParser(root = path.resolve('third-party/slidev-parser-core')) {
  const origin = JSON.parse(await readFile(path.join(root, 'ORIGIN.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const files = ['core.mjs', 'utils.mjs', 'LICENSE'];
  if (origin.upstreamPackage !== '@slidev/parser' || origin.upstreamVersion !== '52.19.1' || pkg.name !== '@open-markdown-review/slidev-parser-core' || pkg.version !== '52.19.1-omr.1' || Object.keys(origin.files).sort().join() !== [...files].sort().join() || !/^sha512-/.test(origin.integrity)) throw new Error('Unsupported vendored Slidev parser provenance.');
  for (const file of files) {
    const hash = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
    if (hash !== origin.files[file]) throw new Error(`Vendored Slidev parser differs from its reviewed upstream bytes: ${file}`);
  }
  return origin;
}
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await verifySlidevParser();
  console.log('Verified unmodified MIT Slidev 52.19.1 pure parser modules and license.');
}
