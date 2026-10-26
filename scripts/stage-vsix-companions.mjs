import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {chmod,copyFile,lstat,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {extractVsix,verifyOfflineVsix} from './vsix-offline.mjs';
import {bundleName,fileHash,verifyBundle} from './companion-bundle.mjs';

/** Build-time only: use the immutable payloads/proof inside a verified authoring VSIX.
 * The installed extension remains fully offline. No companion release sidecars are needed.
 */
export async function stageVsixCompanions(file,root,catalog) {
  assert.ok(path.isAbsolute(file)&&path.isAbsolute(root));
  await verifyOfflineVsix(file,catalog);
  const extracted=await extractVsix(file),source=path.join(extracted,'dist');
  await verifyBundle(source,catalog);
  await mkdir(root,{recursive:true});
  const info=await lstat(root);assert.ok(info.isDirectory()&&!info.isSymbolicLink());
  const destination=path.join(root,'bundled-companions');
  await mkdir(destination,{recursive:true});
  assert.ok(!(await lstat(destination)).isSymbolicLink());
  for(const target of catalog.targets){
    const directory=path.join(destination,target.target);await mkdir(directory,{recursive:true});
    const stat=await lstat(directory);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());
    const names=[bundleName(target.target),'THIRD-PARTY-NOTICES.txt','build.json',...(target.target==='darwin-arm64'?['qualification.json']:[])];
    for(const name of names){
      const from=path.join(source,'bundled-companions',target.target,name),to=path.join(directory,name);
      try{await copyFile(from,to,constants.COPYFILE_EXCL);}
      catch(error){if(error.code!=='EEXIST')throw error;const existing=await lstat(to);assert.ok(existing.isFile()&&!existing.isSymbolicLink());assert.equal(await fileHash(to),await fileHash(from),'Refusing to overwrite different staged companion bytes. Use a clean build directory.');}
      if(name===bundleName(target.target)&&target.target!=='win32-x64'&&process.platform!=='win32')await chmod(to,0o755);
    }
  }
  await verifyBundle(root,catalog);
}
