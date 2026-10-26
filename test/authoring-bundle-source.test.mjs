import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fixture,archive} from './vsix.fixture.mjs';
import {downloadAuthoringBundle} from '../scripts/authoring-bundle-source.mjs';
import {verifyReleasePackages} from '../scripts/verify-release-packages.mjs';

const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const source={host:'github.com',owner:'mirdadusi',repository:'open-markdown-review',assetRedirectHosts:['assets.example.com']};
async function downloadFixture(isDraft=false){
  const f=fixture(),zip=await archive(f.files),bytes=await readFile(zip),directory=await mkdtemp(path.join(os.tmpdir(),'omr-authoring-source-')),destination=path.join(directory,'dist');
  const name=`open-markdown-review-${f.catalog.version}-${isDraft?'authoring-seed':'portable'}.vsix`,checksum=Buffer.from(hash(bytes).slice(7)+'  '+name+'\n');
  const payloads=new Map([[1,bytes],[2,checksum]]),record={isDraft,assets:[{id:1,name,size:bytes.length,digest:hash(bytes)},{id:2,name:name+'.sha256',size:checksum.length,digest:hash(checksum)}]};
  const calls=[];
  const fetcher=async(url,options)=>{calls.push({url,options});if(url.startsWith('https://assets.example.com/'))return new Response(payloads.get(Number(url.split('/').pop())));const id=Number(url.split('/').pop());return new Response(null,{status:302,headers:{location:`https://assets.example.com/${id}`}});};
  return {...f,directory,destination,record,fetcher,calls,payloads};
}
test('build acquisition extracts all three clients and Mac proof from published VSIX or draft seed, without credential forwarding',async()=>{
  for(const draft of [false,true]){
    const f=await downloadFixture(draft);const result=await downloadAuthoringBundle({...f,source,token:'unit-only-token'});
    assert.match(result.filename,draft?/authoring-seed/:/portable/);
    for(const target of f.catalog.targets)assert.ok((await readFile(path.join(f.destination,'bundled-companions',target.target,target.target==='win32-x64'?'StartReview.exe':'StartReview'))).length);
    assert.ok((await readFile(path.join(f.destination,'bundled-companions/darwin-arm64/qualification.json'))).length);
    for(const call of f.calls){assert.equal(call.options.credentials,'omit');assert.equal(call.options.redirect,'manual');assert.equal(call.options.headers.Authorization,call.url.startsWith('https://api.github.com/')?'Bearer unit-only-token':undefined);}
  }
});
test('build acquisition rejects unknown redirects, incorrect checksums, changed bytes and invalid VSIX before staging',async()=>{
  for(const fault of ['redirect','checksum','zip','size','duplicate']){
    const f=await downloadFixture();let fetcher=f.fetcher;
    if(fault==='redirect')fetcher=async()=>new Response(null,{status:302,headers:{location:'https://untrusted.invalid/asset'}});
    if(fault==='checksum'){const value=Buffer.from('0'.repeat(64)+'  '+f.record.assets[0].name+'\n');f.payloads.set(2,value);f.record.assets[1].digest=hash(value);}
    if(fault==='zip'){const value=Buffer.from('not a zip');f.payloads.set(1,value);Object.assign(f.record.assets[0],{size:value.length,digest:hash(value)});const checksum=Buffer.from(hash(value).slice(7)+'  '+f.record.assets[0].name+'\n');f.payloads.set(2,checksum);Object.assign(f.record.assets[1],{size:checksum.length,digest:hash(checksum)});}
    if(fault==='size')f.record.assets[0].size++;
    if(fault==='duplicate')f.record.assets.push(f.record.assets[0]);
    await assert.rejects(downloadAuthoringBundle({...f,source,token:'unit-only-token',fetcher}));
  }
});
test('public published build inputs can be acquired anonymously without any authorization header',async()=>{
  const f=await downloadFixture();
  await downloadAuthoringBundle({...f,source});
  assert.ok(f.calls.length>0);
  for(const call of f.calls)assert.equal(call.options.headers.Authorization,undefined);
});
test('release publication binds both exact VSIX checksums to native qualifications from this source and catalog',async()=>{
  const {catalog}=fixture(),directory=await mkdtemp(path.join(os.tmpdir(),'omr-release-proof-')),commit='a'.repeat(40),files=[],proofs=[];
  for(const platform of ['portable','win32-x64']){
    const name=`open-markdown-review-${catalog.version}-${platform}.vsix`,bytes=Buffer.from(`qualified ${platform}`),file=path.join(directory,name);
    await writeFile(file,bytes);await writeFile(file+'.sha256',hash(bytes).slice(7)+'  '+name+'\n');files.push(file,file+'.sha256');
    proofs.push({schemaVersion:'omr-offline-vsix-qualification/1',version:catalog.version,sourceCommit:commit,artifact:name,artifactDigest:hash(bytes),platform:platform==='portable'?'linux':'win32',arch:'x64',offlineAllPlatformCreation:true,nativeBrowserAndLauncher:true,vscodeCliInstalled:true,installedExtensionCreationAndGoLaunch:true,companions:catalog.targets.map(t=>({target:t.target,digest:t.executable.digest,byteLength:t.executable.byteLength}))});
  }
  assert.equal((await verifyReleasePackages(files,catalog,proofs,commit)).length,4);
  for(const patch of [{sourceCommit:'b'.repeat(40)},{artifactDigest:'sha256:'+'0'.repeat(64)},{platform:'darwin'},{nativeBrowserAndLauncher:false},{companions:[] }])await assert.rejects(verifyReleasePackages(files,catalog,[{...proofs[0],...patch},proofs[1]],commit));
  await assert.rejects(verifyReleasePackages(files,catalog,[proofs[0],proofs[0],proofs[1]],commit));
  await writeFile(files[0],Buffer.from('changed VSIX'));await assert.rejects(verifyReleasePackages(files,catalog,proofs,commit));
});
