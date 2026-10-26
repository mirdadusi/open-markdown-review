import assert from 'node:assert/strict';
import {authoringAssetNames,verifyEnterpriseDraft} from './verify-companion-assets.mjs';

/** Resumable publication plan: never overwrite an existing asset or alter a published release. */
export async function completeReleaseDraft({catalog,tag,commit,packages,adapter}) {
  assert.deepEqual(packages.map(p=>p.name).sort(),authoringAssetNames(catalog,'complete'));
  for(const p of packages){assert.match(p.digest,/^sha256:[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(p.size)&&p.size>0);}
  const seed=new Set(authoringAssetNames(catalog,'staged'));
  const inspect=async()=>{const record=await adapter.inspect();verifyEnterpriseDraft(record,tag,commit,catalog,'staged');return record;};
  let record=await inspect();
  const same=(asset,file)=>{assert.ok(asset,'Missing release package.');assert.equal(asset.digest,file.digest,'Refusing to replace a different release asset.');assert.equal(asset.size,file.size);};
  // Complete preflight before any upload or deletion, including interrupted-run remnants.
  for(const file of packages){const old=record.assets.find(a=>a.name===file.name);if(old)same(old,file);}
  for(const file of packages){
    record=await inspect();const old=record.assets.find(a=>a.name===file.name);
    if(old)same(old,file);else await adapter.upload(file);
  }
  record=await inspect();
  for(const file of packages)same(record.assets.find(a=>a.name===file.name),file);
  for(const name of seed){
    record=await inspect();const asset=record.assets.find(a=>a.name===name);
    if(asset)await adapter.removeSeed(asset); // Adapter deletes the exact snapshotted asset ID only.
  }
  record=await inspect();verifyEnterpriseDraft(record,tag,commit,catalog,'complete');
  await adapter.publish();
  const published=await adapter.inspect();
  assert.equal(published.isDraft,false);assert.equal(published.tagName,tag);assert.equal(published.targetCommitish,commit);
  assert.deepEqual(published.assets.map(a=>a.name).sort(),authoringAssetNames(catalog,'complete'));
  for(const file of packages)same(published.assets.find(a=>a.name===file.name),file);
  return published;
}
