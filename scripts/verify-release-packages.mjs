import assert from 'node:assert/strict';
import {lstat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {authoringAssetNames} from './verify-companion-assets.mjs';
import {fileHash} from './companion-bundle.mjs';

export async function verifyReleasePackages(files,catalog,proofs,commit) {
  assert.match(commit,/^[a-f0-9]{40}$/);
  const names=files.map(file=>path.basename(file));
  assert.deepEqual([...names].sort(),authoringAssetNames(catalog,'complete'),'Require exactly two authoring VSIX packages and their checksums.');
  for(const file of files){const stat=await lstat(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink());assert.ok(stat.size>0&&stat.size<=(file.endsWith('.sha256')?1024:256*1024*1024));}
  const verified=[];
  for(const file of files.filter(file=>file.endsWith('.vsix'))){
    const name=path.basename(file),hash=await fileHash(file),checksum=files.find(f=>path.basename(f)===name+'.sha256');
    assert.equal(await readFile(checksum,'utf8'),hash.slice(7)+'  '+name+'\n','Release VSIX checksum mismatch.');
    const matches=proofs.filter(p=>p.artifact===name);assert.equal(matches.length,1,'Missing or ambiguous native VSIX qualification.');
    const proof=matches[0],platform=name.endsWith('-win32-x64.vsix')?'win32':'linux';
    assert.equal(proof.schemaVersion,'omr-offline-vsix-qualification/1');assert.equal(proof.version,catalog.version);
    assert.equal(proof.sourceCommit,commit);assert.equal(proof.artifactDigest,hash);assert.equal(proof.platform,platform);assert.equal(proof.arch,'x64');
    for(const field of ['offlineAllPlatformCreation','nativeBrowserAndLauncher','vscodeCliInstalled','installedExtensionCreationAndGoLaunch'])assert.equal(proof[field],true,`Missing native qualification: ${field}`);
    assert.deepEqual([...proof.companions].sort((a,b)=>a.target.localeCompare(b.target)),catalog.targets.map(t=>({target:t.target,digest:t.executable.digest,byteLength:t.executable.byteLength})).sort((a,b)=>a.target.localeCompare(b.target)));
    verified.push({path:file,name,digest:hash,size:(await lstat(file)).size},{path:checksum,name:name+'.sha256',digest:await fileHash(checksum),size:(await lstat(checksum)).size});
  }
  return verified;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const catalog=JSON.parse(await readFile('companions/catalog.json','utf8'));
  throw new Error('Call verifyReleasePackages with the exact source, packages and native qualification records.');
}
