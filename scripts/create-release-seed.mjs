import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {verifyOfflineVsix} from './vsix-offline.mjs';
import {fileHash} from './companion-bundle.mjs';

assert.equal(process.argv.length,3,'Provide the locally qualified portable authoring VSIX.');
const catalog=JSON.parse(await readFile('companions/catalog.json','utf8')),source=path.resolve(process.argv[2]);
await verifyOfflineVsix(source,catalog);
const directory=path.resolve('output/release-seed',catalog.version);await mkdir(directory,{recursive:true});
const name=`open-markdown-review-${catalog.version}-authoring-seed.vsix`,target=path.join(directory,name),hash=await fileHash(source);
try{await copyFile(source,target,constants.COPYFILE_EXCL);}catch(error){if(error.code!=='EEXIST')throw error;assert.equal(await fileHash(target),hash,'Refusing to overwrite a different seed.');}
const checksum=hash.slice(7)+'  '+name+'\n';
try{await writeFile(target+'.sha256',checksum,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;assert.equal(await readFile(target+'.sha256','utf8'),checksum);}
console.log(JSON.stringify({version:catalog.version,seed:target,checksum:target+'.sha256',digest:hash,usage:'Attach only these two files to the source-bound draft before release CI. They are removed before publication.'},null,2));
