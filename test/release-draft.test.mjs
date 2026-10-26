import test from 'node:test';
import assert from 'node:assert/strict';
import {authoringAssetNames} from '../scripts/verify-companion-assets.mjs';
import {completeReleaseDraft} from '../scripts/complete-release-draft.mjs';

function fixture() {
  const catalog={version:'0.6.4'},commit='a'.repeat(40),tag='v0.6.4';
  const packages=authoringAssetNames(catalog,'complete').map((name,i)=>({name,path:'/unit/'+name,digest:'sha256:'+String(i).repeat(64),size:100+i}));
  const record={tagName:tag,targetCommitish:commit,isDraft:true,assets:authoringAssetNames(catalog,'staged').map((name,i)=>({id:'seed-'+i,name}))};
  const calls=[],adapter={inspect:async()=>structuredClone(record),upload:async file=>{calls.push('upload:'+file.name);record.assets.push({...file,id:'final-'+file.name});},removeSeed:async asset=>{calls.push('remove:'+asset.name);record.assets=record.assets.filter(a=>a.id!==asset.id);},publish:async()=>{calls.push('publish');record.isDraft=false;}};
  return {catalog,commit,tag,packages,record,calls,adapter};
}
test('release publishes exactly two VSIX packages/checksums and retires only draft seed inputs',async()=>{
  const f=fixture(),result=await completeReleaseDraft(f);
  assert.equal(result.isDraft,false);assert.deepEqual(result.assets.map(a=>a.name).sort(),f.packages.map(a=>a.name));
  assert.equal(f.calls.filter(c=>c.startsWith('upload:')).length,4);assert.equal(f.calls.filter(c=>c.startsWith('remove:')).length,2);assert.equal(f.calls.at(-1),'publish');
  assert.ok(!f.calls.some(c=>c.includes('StartReview')));
});
test('published, wrong-source, duplicate and unknown assets are refused before mutation',async()=>{
  for(const mutate of [f=>f.record.isDraft=false,f=>f.record.targetCommitish='b'.repeat(40),f=>f.record.assets.push(f.record.assets[0]),f=>f.record.assets.push({name:'StartReview-unexpected'})]){
    const f=fixture();mutate(f);await assert.rejects(completeReleaseDraft(f));assert.deepEqual(f.calls,[]);
  }
});
test('an interrupted upload resumes without overwriting uploaded packages or deleting evidence early',async()=>{
  const f=fixture(),upload=f.adapter.upload;let count=0;
  f.adapter.upload=async file=>{if(++count===3)throw Error('connection lost');await upload(file);};
  await assert.rejects(completeReleaseDraft(f),/connection lost/);assert.equal(f.record.isDraft,true);assert.ok(!f.calls.some(c=>c.startsWith('remove:')));
  f.adapter.upload=upload;await completeReleaseDraft(f);
  assert.equal(f.calls.filter(c=>c.startsWith('upload:')).length,4);assert.equal(f.record.assets.length,4);
});
test('different existing package bytes block publication before uploads or seed deletion',async()=>{
  const f=fixture();f.record.assets.push({...f.packages[0],digest:'sha256:'+'f'.repeat(64)});
  await assert.rejects(completeReleaseDraft(f),/different release asset/);assert.deepEqual(f.calls,[]);
});
test('interrupted seed cleanup resumes from the remaining exact seed without replacing final files',async()=>{
  const f=fixture(),remove=f.adapter.removeSeed;let count=0;
  f.adapter.removeSeed=async asset=>{if(++count===2)throw Error('interrupted cleanup');await remove(asset);};
  await assert.rejects(completeReleaseDraft(f),/interrupted cleanup/);assert.equal(f.record.isDraft,true);assert.equal(f.record.assets.length,5);
  f.adapter.removeSeed=remove;await completeReleaseDraft(f);
  assert.equal(f.calls.filter(c=>c.startsWith('upload:')).length,4);assert.equal(f.record.assets.length,4);
});
