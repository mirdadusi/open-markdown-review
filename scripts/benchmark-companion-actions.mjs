// Complement read throughput with actual validated comments/publications/journals.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
const require=createRequire(import.meta.url),{companionFixture}=require('../out/test/companion.fixture.js'),{jsonBytes}=require('../out/src/professional/bytes.js');
const label=process.argv[2]??'current';assert.match(label,/^[a-z0-9-]{1,40}$/);
const target=`${process.platform}-${process.arch}`,file=process.platform==='win32'?'StartReview.exe':'StartReview',out=path.resolve('output/companion-performance',target,label);
await mkdir(out,{recursive:true});
for(const name of ['OMR_GO_COMPANION','OMR_PROCESS_COMPANION','OMR_TEST_COMPANION','OMR_EXPERIMENTAL_COMPANION'])delete process.env[name];
const fixture=await companionFixture();await fixture.helper.close();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),bytes=Buffer.alloc(1048576);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
const hash=sha(bytes),blob=`blobs/sha256/${hash.slice(0,2)}/${hash}`,base64=bytes.toString('base64');
const report={schemaVersion:'omr-companion-actions/1',measuredAt:new Date().toISOString(),host:{platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model},workload:{rounds:3,publicationBytes:bytes.length,commentBytes:8192,scope:'Independent copies of the same initial disposable evidence, fresh private journals, actual native binaries, bounded loopback RPC. Timings include validation, hashes, fsync, reread verification and response. Not SMB/OneDrive or peak RSS.'},clients:{}};
const executableFor=name=>name==='go'&&process.env.OMR_GO_ACTIONS_CONTROL?path.resolve(process.env.OMR_GO_ACTIONS_CONTROL):path.resolve(name==='go'?'dist/companion-go':'dist/legacy-node',target,file);
for(const name of ['node','go']){const executable=executableFor(name);report.clients[name]={executableSha256:sha(await readFile(executable)),publicationMs:[],commentMs:[],journalRoundTripMs:[]};}
for(let round=0;round<3;round++)for(const name of round%2?['go','node']:['node','go']){
 const executable=executableFor(name),root=path.join(fixture.temporary,`${name}-${round}`),journal=path.join(fixture.temporary,`${name}-${round}-private`);
 await cp(fixture.root,root,{recursive:true,mode:constants.COPYFILE_FICLONE,filter:source=>!source.endsWith('.html')});
 const child=spawn(executable,['--store',root,'--recovery-root',journal,'--no-open'],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',b=>{stderr+=b;});
 const exited=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
 const url=await new Promise((resolve,reject)=>{let stdout='';const timer=setTimeout(()=>{child.kill();reject(Error('Native startup timed out: '+stderr));},30000);child.stdout.on('data',b=>{stdout+=b;const m=/http:\/\/127\.0\.0\.1:\d+\/#omr-session=[a-f0-9]{64}/.exec(stdout);if(m){clearTimeout(timer);resolve(new URL(m[0]));}});child.once('exit',code=>{clearTimeout(timer);reject(Error(`Native startup exited ${code}: ${stderr}`));});child.once('error',reject);});
 const token=new URLSearchParams(url.hash.slice(1)).get('omr-session');
 const rpc=async(method,args=[])=>{const response=await fetch(url.origin+'/api/rpc',{method:'POST',headers:{Origin:url.origin,'Content-Type':'application/json','X-OMR-Session':token},body:JSON.stringify({method,args}),signal:AbortSignal.timeout(120000)});const body=await response.json();assert.equal(body.ok,true,body.error);return body.value;};
 try{
  await rpc('info');
  let start=performance.now();await rpc('write',[blob,base64,false]);report.clients[name].publicationMs.push(performance.now()-start);
  assert.equal(sha(Buffer.from(await rpc('read',[blob,bytes.length]),'base64')),hash);
  const event=fixture.session.makeEvent(fixture.session.context({id:'alex@example.com'}),{type:'comment.created',threadId:`perf_thread_${round}_${name}`,commentId:`perf_comment_${round}_${name}`,anchor:fixture.anchor,body:{format:'markdown',text:'x'.repeat(8192)}}),eventBytes=jsonBytes(event),eventFile=`events/${sha(eventBytes)}.json`;
  start=performance.now();await rpc('write',[eventFile,Buffer.from(eventBytes).toString('base64'),false]);report.clients[name].commentMs.push(performance.now()-start);
  assert.deepEqual(await readFile(path.join(root,eventFile)),Buffer.from(eventBytes));
  start=performance.now();await rpc('journalPut',['performance-binary',{path:blob,bytes:base64,digest:`sha256:${hash}`,acknowledged:false}]);const record=await rpc('journalGet',['performance-binary']);assert.equal(record.bytes,base64);assert.equal(record.acknowledged,false);report.clients[name].journalRoundTripMs.push(performance.now()-start);
  console.log(`${name} round ${round+1}: publication ${report.clients[name].publicationMs.at(-1).toFixed(1)} ms, comment ${report.clients[name].commentMs.at(-1).toFixed(1)} ms, journal ${report.clients[name].journalRoundTripMs.at(-1).toFixed(1)} ms`);
 }finally{await rpc('stop');assert.equal(await exited,0,stderr);}
}
await writeFile(path.join(out,'actions.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
