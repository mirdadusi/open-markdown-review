import assert from 'node:assert/strict';
import {createWriteStream} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {fileHash} from './companion-bundle.mjs';
import {stageVsixCompanions} from './stage-vsix-companions.mjs';

export async function downloadAuthoringBundle({source,catalog,record,directory,destination,token,fetcher=fetch}) {
  assert.equal(source.host,'github.com');assert.equal(source.owner,'mirdadusi');assert.equal(source.repository,'open-markdown-review');
  assert.ok(path.isAbsolute(directory)&&path.isAbsolute(destination));
  const seed=`open-markdown-review-${catalog.version}-authoring-seed.vsix`,portable=`open-markdown-review-${catalog.version}-portable.vsix`;
  const name=record.isDraft&&[seed,seed+'.sha256'].every(n=>record.assets.some(a=>a.name===n))?seed:portable;
  const allowedHosts=new Set(['api.github.com',source.host,...source.assetRedirectHosts]);
  for(const filename of [name+'.sha256',name]) {
    const matches=record.assets.filter(a=>a.name===filename);assert.equal(matches.length,1,'Missing or ambiguous authoring VSIX/checksum.');
    const asset=matches[0],maximum=filename.endsWith('.sha256')?1024:256*1024*1024;
    assert.ok(Number.isSafeInteger(asset.id)&&asset.id>0&&Number.isSafeInteger(asset.size)&&asset.size>0&&asset.size<=maximum,'Invalid authoring asset bounds.');
    let url=`https://api.github.com/repos/${source.owner}/${source.repository}/releases/assets/${asset.id}`,response;
    for(let hop=0;hop<5;hop++) {
      const parsed=new URL(url);
      assert.ok(parsed.protocol==='https:'&&!parsed.username&&!parsed.password&&(!parsed.port||parsed.port==='443')&&allowedHosts.has(parsed.hostname),'Untrusted authoring asset redirect.');
      response=await fetcher(url,{credentials:'omit',redirect:'manual',signal:AbortSignal.timeout(300000),headers:hop===0?{...(token?{Authorization:`Bearer ${token}`} : {}),Accept:'application/octet-stream'}:{Accept:'application/octet-stream'}});
      if(![301,302,303,307,308].includes(response.status))break;
      const location=response.headers.get('location');await response.body?.cancel();assert.ok(location,'Missing redirect location.');url=new URL(location,url).href;
    }
    assert.equal(response?.status,200,'Authoring VSIX download failed.');assert.ok(response.body);
    const length=response.headers.get('content-length');if(length)assert.equal(Number(length),asset.size,'Authoring download length differs.');
    let size=0;const file=path.join(directory,filename);
    await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_,done){size+=chunk.length;done(size>asset.size?Error('Authoring download exceeds its declared size.'):null,chunk);}}),createWriteStream(file,{flags:'wx',mode:0o600}));
    assert.equal(size,asset.size,'Incomplete authoring VSIX download.');
    if(asset.digest!==undefined)assert.equal(await fileHash(file),asset.digest,'Authoring asset hash differs from release metadata.');
  }
  const file=path.join(directory,name),hash=await fileHash(file);
  assert.equal(await readFile(file+'.sha256','utf8'),hash.slice(7)+'  '+name+'\n','Authoring VSIX checksum mismatch.');
  await stageVsixCompanions(file,destination,catalog);
  return {filename:name,digest:hash};
}
