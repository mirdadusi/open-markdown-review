// Profile the actual shared core without exposing pprof/debug routes to reviewers.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { goCompanionBuildOptions } from './go-companion-build-options.mjs';
const require=createRequire(import.meta.url),{companionFixture}=require('../out/test/companion.fixture.js');
const label=process.argv[2]??'baseline';
assert.match(label,/^[a-z0-9-]{1,40}$/);
const output=path.resolve('output/companion-performance',`${process.platform}-${process.arch}`,label);
await mkdir(output,{recursive:true});
const env={...process.env};for(const key of ['OMR_GO_COMPANION','OMR_PROCESS_COMPANION','OMR_TEST_COMPANION','OMR_EXPERIMENTAL_COMPANION'])delete env[key];
for(const key of ['OMR_GO_COMPANION','OMR_PROCESS_COMPANION','OMR_TEST_COMPANION','OMR_EXPERIMENTAL_COMPANION'])delete process.env[key];
const fixture=await companionFixture();await fixture.helper.close();
const {jsonBytes}=require('../out/src/professional/bytes.js'),requests=[];
for(let i=0;i<128;i++){
 const event=fixture.session.makeEvent(fixture.session.context({id:'alex@example.com'}),{type:'comment.created',threadId:`profile_thread_${i}`,commentId:`profile_comment_${i}`,anchor:fixture.anchor,body:{format:'markdown',text:'x'.repeat(8192)}}),raw=Buffer.from(jsonBytes(event));
 requests.push(JSON.stringify({method:'write',args:[`events/${createHash('sha256').update(raw).digest('hex')}.json`,raw.toString('base64'),false]}));
}
const events=path.join(output,'events.json');await writeFile(events,JSON.stringify(requests));
const bytes=Buffer.alloc(1048576);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
const hash=createHash('sha256').update(bytes).digest('hex'),blob=`blobs/sha256/${hash.slice(0,2)}/${hash}`;
await fixture.store.write(blob,bytes,false);
const primitives=path.join(output,'primitives.js');
await build({...goCompanionBuildOptions,stdin:{contents:"export {digest} from './src/professional/bytes';export {parseCompanionRequest} from './src/professional/companionRpc';",resolveDir:process.cwd()},outfile:primitives,bundle:true,platform:'neutral',mainFields:['module','main'],target:'es2022',format:'iife',globalName:'PERF',minify:true});
const go=process.env.OMR_GO??'go',binary=path.join(output,'performance.test');
const filter=process.env.OMR_GO_PERF_FILTER??'BenchmarkCompanionStages';
const args=['test','-run=^$',`-bench=${filter}`,'-benchtime=400ms','-count=2','-benchmem',`-cpuprofile=${path.join(output,'cpu.pprof')}`,`-memprofile=${path.join(output,'heap.pprof')}`,'-o',binary,'.'];
const started=Date.now(),result=spawnSync(go,args,{cwd:path.resolve('clients/companion-go'),env:{...env,CGO_ENABLED:'0',GOTOOLCHAIN:'local',OMR_GO_PERF_REVIEW:fixture.root,OMR_GO_PERF_BLOB:blob,OMR_GO_PERF_PRIMITIVES:primitives,OMR_GO_PERF_EVENTS:events},encoding:'utf8',timeout:300000,maxBuffer:16*1024*1024});
await writeFile(path.join(output,'benchmarks.log'),(result.stdout??'')+(result.stderr??''));
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
assert.equal(result.status,0,result.error?.message??'Go profiling failed.');
for(const [file,profile]of [['cpu-top.log','cpu.pprof'],['allocations-top.log','heap.pprof']]){
 const p=spawnSync(go,['tool','pprof','-top','-nodecount=25',...(file.startsWith('allocations')?['-alloc_space']:[]),binary,path.join(output,profile)],{env:{...env,GOTOOLCHAIN:'local'},encoding:'utf8',timeout:30000});
 assert.equal(p.status,0,p.stderr);await writeFile(path.join(output,file),p.stdout);process.stdout.write(p.stdout);
}
await writeFile(path.join(output,'run.json'),JSON.stringify({label,executedAt:new Date().toISOString(),durationMs:Date.now()-started,review:fixture.root,blob,blobDigest:`sha256:${hash}`,primitivesDigest:`sha256:${createHash('sha256').update(await readFile(primitives)).digest('hex')}`,scope:'Stage diagnostics, not the end-to-end transport benchmark. No production profiling API.'},null,2)+'\n');
