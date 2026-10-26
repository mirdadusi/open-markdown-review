import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
export async function hostSourceDigest(directory) {
  const files=(await readdir(directory)).filter(name=>name.endsWith('.go')&&!name.endsWith('_test.go')).sort();
  if(!files.includes('main.go')||!files.includes('runtime.go'))throw Error('Incomplete Go host source.');
  const hash=createHash('sha256');
  for(const file of files){const bytes=await readFile(path.join(directory,file));hash.update(file+'\0'+bytes.length+'\0');hash.update(bytes);}
  return `sha256:${hash.digest('hex')}`;
}
