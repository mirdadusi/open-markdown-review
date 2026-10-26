// Reproduce an explicitly pinned Git control without switching the worktree or
// modifying current source. Refuse a control whose generated core is not exact.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { hostSourceDigest } from './go-companion-inputs.mjs';
const ref=process.argv[2];assert.match(ref??'',/^[a-f0-9]{7,40}$/);
const root=process.cwd(),go=process.env.OMR_GO??'go',sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
function git(args){const r=spawnSync('git',args,{encoding:'utf8',maxBuffer:16*1024*1024});if(r.status!==0)throw Error(r.stderr);return r.stdout;}
const commit=git(['rev-parse',ref+'^{commit}']).trim();
const target=`${process.platform}-${process.arch}`,output=path.resolve('output/companion-performance',target,`control-${commit.slice(0,12)}`),source=path.join(output,'source'),assets=path.join(source,'assets');
const executable=path.join(output,process.platform==='win32'?'StartReview.exe':'StartReview');
let cached=false;try{await access(path.join(output,'control.json'));cached=true;}catch(error){if(error.code!=='ENOENT')throw error;}
if(cached){const record=JSON.parse(await readFile(path.join(output,'control.json')));assert.equal(record.commit,commit);assert.equal(sha(await readFile(executable)),record.digest);console.log(executable);process.exit(0);}
// A fresh reconstruction requires the retained pre-change receipt/assets.
// Never silently call current assets an original performance control.
const receipt=JSON.parse(await readFile('dist/companion-go/linux-x64/StartReview.build.json'));
await mkdir(output,{recursive:true});await mkdir(source);await mkdir(assets);
for(const name of git(['ls-tree','-r','--name-only',commit,'clients/companion-go']).trim().split('\n').filter(n=>n.endsWith('.go')&&!n.endsWith('_test.go')||/\/go\.(?:mod|sum)$/.test(n)))await writeFile(path.join(source,path.basename(name)),git(['show',`${commit}:${name}`]));
assert.equal(await hostSourceDigest(source),receipt.inputs.hostSource,'The reference receipt is not this original Go host.');
const generated=await build({entryPoints:[path.resolve('clients/companion-go/bridge.ts')],outfile:path.join(assets,'core.js'),bundle:true,platform:'neutral',mainFields:['module','main'],target:'es2022',format:'iife',globalName:'OMR',minify:true,write:false,plugins:[{name:'pinned-git-control',setup(build){build.onLoad({filter:/\.(?:ts|js|json)$/},args=>{
 const relative=path.relative(root,args.path).split(path.sep).join('/');if(relative.startsWith('node_modules/')||relative.startsWith('../'))return;
 const r=spawnSync('git',['show',`${commit}:${relative}`],{encoding:'utf8',maxBuffer:16*1024*1024});
 if(r.status!==0){if(relative.startsWith('src/professional/generated/'))return;throw Error('Missing pinned source: '+relative);}
 return{contents:r.stdout,resolveDir:path.dirname(args.path),loader:relative.endsWith('.ts')?'ts':relative.endsWith('.json')?'json':'js'};
});}}]});
assert.equal(sha(generated.outputFiles[0].contents),receipt.inputs.core,'Original neutral core could not be reproduced exactly.');
await writeFile(path.join(assets,'core.js'),generated.outputFiles[0].contents);
for(const [file,key]of [['toolbox.html','toolbox'],['THIRD-PARTY-NOTICES.txt','notices']]){
 const bytes=await readFile(path.join('clients/companion-go/assets',file));assert.equal(sha(bytes),receipt.inputs[key]);await writeFile(path.join(assets,file),bytes);
}
for(const name of ['LICENSE','go-dependencies.json'])await copyFile(path.join('clients/companion-go/assets',name),path.join(assets,name));
await writeFile(path.join(assets,'provenance.json'),JSON.stringify({schemaVersion:'omr-go-build/1',complete:true,applicationVersion:JSON.parse(git(['show',`${commit}:package.json`])).version,toolchain:receipt.toolchain,inputs:receipt.inputs,productionDefault:false},null,2));
const r=spawnSync(go,['build','-trimpath','-buildvcs=false','-ldflags=-s -w','-o',executable,'.'],{cwd:source,env:{...process.env,CGO_ENABLED:'0',GOTOOLCHAIN:'local'},encoding:'utf8',timeout:180000});assert.equal(r.status,0,r.stderr);
await writeFile(path.join(output,'control.json'),JSON.stringify({commit,target,referenceInputs:receipt.inputs,digest:sha(await readFile(executable)),scope:'Pinned original host and exact original embedded core/toolbox, rebuilt with the same pinned Go toolchain. Not a shipped client.'},null,2)+'\n');
console.log(executable);
