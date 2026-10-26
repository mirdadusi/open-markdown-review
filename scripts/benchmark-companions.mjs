// Same bytes, alternating native processes. Not a disk-only or SMB benchmark.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, stat, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createDeflateRaw } from 'node:zlib';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { hostSourceDigest } from './go-companion-inputs.mjs';
import { goCompanionBuildOptions } from './go-companion-build-options.mjs';
const require=createRequire(import.meta.url),{companionFixture}=require('../out/test/companion.fixture.js');
const target=`${process.platform}-${process.arch}`,filename=process.platform==='win32'?'StartReview.exe':'StartReview';
const output=path.resolve('output/companion-comparison',target);await mkdir(output,{recursive:true});
const executables={node:path.resolve('dist/legacy-node',target,filename),go:path.resolve('dist/companion-go',target,filename)};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const source={node:sha(await readFile('dist/companion-node-legacy.js')),toolbox:sha(await readFile('dist/OpenMarkdownReview.html'))};
const nodeReceipt=JSON.parse(await readFile(path.join(path.dirname(executables.node),'build.json'))),goReceipt=JSON.parse(await readFile(executables.go+'.build.json'));
assert.equal(nodeReceipt.companionSha256,source.node,'Rebuild Node: never benchmark an older protocol implementation against Go.');assert.equal(nodeReceipt.toolboxSha256,source.toolbox);
assert.equal(goReceipt.inputs.toolbox,`sha256:${source.toolbox}`);assert.equal(goReceipt.testFaults,false);
assert.equal(goReceipt.inputs.hostSource,await hostSourceDigest(path.resolve('clients/companion-go')),'Rebuild Go: its host source is stale.');
const core=await build({...goCompanionBuildOptions,entryPoints:[path.resolve('clients/companion-go/bridge.ts')],outfile:path.resolve('clients/companion-go/assets/core.js'),bundle:true,platform:'neutral',mainFields:['module','main'],target:'es2022',format:'iife',globalName:'OMR',minify:true,write:false});
assert.equal(goReceipt.inputs.core,`sha256:${sha(core.outputFiles[0].contents)}`,'Rebuild Go: its shared protocol core is stale.');
const summarize=values=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:sorted.length,median:sorted[Math.floor(sorted.length/2)],p95:sorted[Math.ceil(sorted.length*.95)-1],minimum:sorted[0],maximum:sorted.at(-1)};};
async function size(file){const hash=createHash('sha256'),zip=createDeflateRaw({level:6});let compressed=0;const input=createReadStream(file);input.on('data',bytes=>hash.update(bytes));input.pipe(zip);for await(const bytes of zip)compressed+=bytes.length;return{bytes:(await stat(file)).size,deflateLevel6Bytes:compressed,sha256:hash.digest('hex')};}
const report={schemaVersion:'omr-companion-benchmark/2',measuredAt:new Date().toISOString(),host:{platform:process.platform,arch:process.arch,osRelease:os.release(),cpu:os.cpus()[0].model,memoryBytes:os.totalmem()},workload:{launchPairs:7,warmupCalls:2,infoCalls:10,readCallsPerSize:5,sizes:[65536,1048576,8388608],scope:'Warm local temporary filesystem; native executable-to-ready; end-to-end loopback RPC/base64/JSON plus SHA-256 verification. No SMB/OneDrive, no browser in RSS, not peak memory. No tail-latency certification.'},clients:{}};
const savedEnv={...process.env};delete process.env.OMR_GO_COMPANION;delete process.env.OMR_PROCESS_COMPANION;delete process.env.OMR_EXPERIMENTAL_COMPANION;delete process.env.OMR_TEST_COMPANION;
const f=await companionFixture();await f.helper.close();
const blobs=[];for(const length of report.workload.sizes){const bytes=Buffer.alloc(length,'x'),hash=sha(bytes),file=`blobs/sha256/${hash.slice(0,2)}/${hash}`;await f.store.write(file,bytes,false);blobs.push({length,file,hash});}
for(const [name,executable]of Object.entries(executables))report.clients[name]={size:await size(executable),launchMs:[],infoMs:[],reads:Object.fromEntries(blobs.map(blob=>[blob.length,[]])),rssMiB:[],shutdownMs:[]};
assert.equal(report.clients.node.size.sha256,nodeReceipt.executableSha256);assert.equal(`sha256:${report.clients.go.size.sha256}`,goReceipt.digest);
function rss(pid){assert.ok(Number.isSafeInteger(pid)&&pid>0);const windows=process.platform==='win32';const child=spawnSync(windows?'powershell.exe':'/bin/ps',windows?['-NoProfile','-Command',`(Get-Process -Id ${pid}).WorkingSet64`]:['-p',String(pid),'-o','rss='],{encoding:'utf8',timeout:15000});assert.equal(child.status,0,child.stderr);const value=Number(child.stdout.trim());assert.ok(value>0);return value/(windows?1048576:1024);}
for(let iteration=0;iteration<7;iteration++)for(const name of iteration%2?['go','node']:['node','go']){
  const values=report.clients[name],journal=path.join(f.temporary,`${name}-${iteration}`);await mkdir(journal);const start=performance.now();
  const child=spawn(executables[name],['--store',f.root,'--recovery-root',journal,'--no-open'],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',bytes=>{stderr+=bytes;});
  const exited=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  const url=await new Promise((resolve,reject)=>{let stdout='';const timer=setTimeout(()=>{child.kill();reject(Error('Benchmark startup timed out: '+stderr));},30000);child.stdout.on('data',bytes=>{stdout+=bytes;const match=/http:\/\/127\.0\.0\.1:\d+\/#omr-session=[a-f0-9]{64}/.exec(stdout);if(match){clearTimeout(timer);resolve(new URL(match[0]));}});child.once('exit',code=>{clearTimeout(timer);reject(Error(`Benchmark exited ${code}: ${stderr}`));});child.once('error',reject);});
  values.launchMs.push(performance.now()-start);const token=new URLSearchParams(url.hash.slice(1)).get('omr-session');
  const rpc=async(method,args=[])=>{const response=await fetch(url.origin+'/api/rpc',{method:'POST',headers:{Origin:url.origin,'Content-Type':'application/json','X-OMR-Session':token},body:JSON.stringify({method,args})});const body=await response.json();assert.equal(body.ok,true,body.error);return body.value;};
  try{
    for(let n=0;n<12;n++){const start=performance.now();await rpc('info');if(n>=2)values.infoMs.push(performance.now()-start);}
    for(const blob of blobs)for(let n=0;n<7;n++){const start=performance.now(),data=await rpc('read',[blob.file,blob.length]);assert.equal(sha(Buffer.from(data,'base64')),blob.hash);if(n>=2)values.reads[blob.length].push(performance.now()-start);}
    values.rssMiB.push(rss(child.pid));
  }finally{const stop=performance.now();await rpc('stop');assert.equal(await exited,0,stderr);values.shutdownMs.push(performance.now()-stop);}
}
for(const client of Object.values(report.clients)){for(const key of ['launchMs','infoMs','rssMiB','shutdownMs'])client[key]=summarize(client[key]);for(const size of Object.keys(client.reads))client.reads[size]=summarize(client.reads[size]);}
await writeFile(path.join(output,'benchmark.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
Object.assign(process.env,savedEnv);
