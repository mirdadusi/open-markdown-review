/** Explicit tooling-only upgrade. Never re-author, regenerate or replace review evidence. */
import {constants} from 'node:fs';
import {copyFile,open,rename} from 'node:fs/promises';
import path from 'node:path';
import {installedClientFile,previewClientUpdate,updateClient} from './authoring';
import {digest,jsonBytes,newId} from './bytes';
import {companionFileDigest,companionMetadata,prepareCompanions} from './companionDelivery';
import {COMPANION_TARGETS,CompanionTarget} from './companionTargets';
import {COMPANION_SIDECARS} from './clientArtifacts';
import {contained,NativeStorage} from './nativeStorage';
import {checkpoint,OperationControl} from './operation';
import {inspectReviewPackage,PackageFile} from './relocation';
import {ProtocolError} from './types';

const isEvidence=(file:PackageFile)=>file.path==='manifest.json'||/^(events|revisions|blobs|exports)\//.test(file.path);
const isTooling=(file:PackageFile)=>!file.path.includes('/')&&!isEvidence(file)&&file.path!=='.gitattributes'&&!['.DS_Store','desktop.ini','Thumbs.db'].includes(file.path);
const retiredExecutables=['StartReview.exe','StartReview'];
export interface ClientUpgradeInspection {
  reviewId:string; manifestDigest:string; clientDigest:string; toolingFingerprint:string;
  tooling:PackageFile[]; evidence:PackageFile[];
}
export async function inspectClientUpgrade(store:NativeStorage):Promise<ClientUpgradeInspection>{
  const inventory=await inspectReviewPackage(store.root),client=await installedClientFile(store),tooling=inventory.files.filter(isTooling);
  return{reviewId:inventory.reviewId,manifestDigest:inventory.files.find(f=>f.path==='manifest.json')!.digest,clientDigest:inventory.files.find(f=>f.path===client)!.digest,toolingFingerprint:digest(jsonBytes(tooling)),tooling,evidence:inventory.files.filter(isEvidence)};
}
async function sameFile(store:NativeStorage,file:PackageFile):Promise<void>{
  const actual=await companionFileDigest(await contained(store.root,file.path),Math.max(file.byteLength,1));
  if(actual.digest!==file.digest||actual.byteLength!==file.byteLength)throw new ProtocolError('changed',`File changed during the client upgrade: ${file.path}`);
}
export async function upgradeReviewClient(options:OperationControl&{
  store:NativeStorage; artifact:string; targets:CompanionTarget[];
  expectManifestDigest:string; expectClientDigest:string; expectToolingFingerprint:string;
}):Promise<{reviewId:string;backupPath:string;browserClientPath:string;companionPaths:string[];preservedEvidenceFiles:number}>{
  const {store}=options,before=await inspectClientUpgrade(store);
  if(before.manifestDigest!==options.expectManifestDigest||before.clientDigest!==options.expectClientDigest||before.toolingFingerprint!==options.expectToolingFingerprint)throw new ProtocolError('changed','Review identity or tooling changed since confirmation. Inspect and confirm the upgrade again.');
  const required=COMPANION_TARGETS.filter(t=>before.tooling.some(f=>f.path===t.filename)).map(t=>t.id);
  if(before.tooling.some(f=>f.path==='StartReview.exe'))required.push('win32-x64');
  if(required.some(t=>!options.targets.includes(t)))throw new ProtocolError('invalid','Include every currently installed companion platform in the upgrade.');
  // Complete preflight precedes even a backup write; missing, stale or untrusted Go fails closed.
  const preview=await previewClientUpdate(store,options.artifact);
  const prepared=await prepareCompanions({targets:options.targets,artifact:options.artifact,journalRoot:store.journalRoot,signal:options.signal,progress:options.progress});
  if(!prepared)throw new ProtocolError('invalid','Select at least one Go companion platform.');
  const backup=`client-backups/${newId('go_upgrade')}`;
  const replacements:Array<{path:string;staged:string;digest:string;byteLength:number;executable:boolean}>=[];
  async function copyVerified(source:string,relative:string,expected:{digest:string;byteLength:number},executable=false){
    const target=await contained(store.root,relative,true);
    await copyFile(source,target,constants.COPYFILE_EXCL);
    // Windows FlushFileBuffers requires write access, even when copyFile already
    // wrote the bytes. Keep the durability check; do not ignore a failed flush.
    const handle=await open(target,constants.O_RDWR|(constants.O_NOFOLLOW??0));
    try{if(executable)await handle.chmod(0o755);await handle.sync();}finally{await handle.close();}
    await sameFile(store,{path:relative,...expected});
  }
  try{
    await store.write(`${backup}/plan.json`,jsonBytes({schemaVersion:'omr-tooling-upgrade/1',runtime:'go',version:prepared.version,reviewId:before.reviewId,manifestDigest:before.manifestDigest,toolingFingerprint:before.toolingFingerprint,targets:prepared.targets,previous:before.tooling}),false);
    for(const file of before.tooling){checkpoint(options,`Backing up ${file.path}…`);await sameFile(store,file);await copyVerified(await contained(store.root,file.path),`${backup}/previous/${file.path}`,file);}
    for(const file of prepared.files){checkpoint(options,`Staging ${file.filename}…`);const staged=`${backup}/staged/${file.filename}`,executable=COMPANION_TARGETS.some(t=>t.filename===file.filename);await copyVerified(file.source,staged,file,executable);replacements.push({path:file.filename,staged,digest:file.digest,byteLength:file.byteLength,executable});}
    for(const file of companionMetadata(prepared)){const staged=`${backup}/staged/${file.filename}`;await store.write(staged,file.bytes,false);replacements.push({path:file.filename,staged,digest:digest(file.bytes),byteLength:file.bytes.length,executable:false});}
    const ready=await inspectClientUpgrade(store);
    if(ready.manifestDigest!==before.manifestDigest||ready.toolingFingerprint!==before.toolingFingerprint)throw new ProtocolError('changed','Review tooling changed during staging. No replacement was made; backups were retained.');
    checkpoint(options,'Installing Go launchers. Keep existing companions stopped until this upgrade completes.');
    // Each rename is atomic, not a cross-file transaction. An interrupted upgrade is
    // reported as uncertain with recoverable backups, never as a successful migration.
    for(const [names,directory] of [[retiredExecutables,'legacy-node'],[COMPANION_SIDECARS,'retired-sidecars']] as const){
      for(const name of names){const prior=before.tooling.find(f=>f.path===name);if(prior){await sameFile(store,prior);await rename(await contained(store.root,name),await contained(store.root,`${backup}/${directory}/${name}`,true));}}
    }
    for(const file of replacements){const prior=before.tooling.find(f=>f.path===file.path);if(prior)await sameFile(store,prior);else{try{await companionFileDigest(await contained(store.root,file.path));throw new ProtocolError('changed',`New tooling appeared during the upgrade: ${file.path}`);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      await sameFile(store,{path:file.staged,digest:file.digest,byteLength:file.byteLength});
      await rename(await contained(store.root,file.staged),await contained(store.root,file.path));await sameFile(store,file);
    }
    const client=await updateClient(store,options.artifact,before.clientDigest,preview.sourceDigest);
    const after=await inspectReviewPackage(store.root),current=new Map(after.files.map(f=>[f.path,f]));
    for(const name of COMPANION_SIDECARS)if(current.has(name))throw new ProtocolError('changed',`A retired sidecar reappeared during the client upgrade: ${name}`);
    // Concurrent peer publications are permitted; every pre-existing byte must remain.
    for(const old of before.evidence){const now=current.get(old.path);if(!now||now.digest!==old.digest||now.byteLength!==old.byteLength)throw new ProtocolError('integrity',`Pre-existing review evidence changed: ${old.path}`);}
    if(after.reviewId!==before.reviewId)throw new ProtocolError('integrity','The review identity changed during upgrade.');
    await store.write(`${backup}/completed.json`,jsonBytes({schemaVersion:'omr-tooling-upgrade/1',runtime:'go',version:prepared.version,reviewId:before.reviewId,preservedEvidenceFiles:before.evidence.length,completedAt:new Date().toISOString()}),false);
    return{reviewId:before.reviewId,backupPath:path.join(store.root,backup),browserClientPath:client.path,companionPaths:replacements.map(f=>path.join(store.root,f.path)),preservedEvidenceFiles:before.evidence.length};
  }catch(error){throw new ProtocolError('uncertain',`Client upgrade did not complete. Do not launch the package until repaired or retried. Backups and staging are retained at ${path.join(store.root,backup)}. No review evidence was intentionally modified. ${error instanceof Error?error.message:String(error)}`);}
}
