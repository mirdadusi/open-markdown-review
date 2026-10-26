// Explicit suite results; never convert a failed gate into migration approval.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const target=`${process.platform}-${process.arch}`,filename=process.platform==='win32'?'StartReview.exe':'StartReview',output=path.resolve('output/companion-comparison',target);await mkdir(output,{recursive:true});
const candidate=path.resolve('dist/companion-go',target,filename),testCandidate=candidate.replace(/(\.exe)?$/,'.test$1'),node=path.resolve('dist/legacy-node',target,filename),go=process.env.OMR_GO??'go';
const clean={...process.env};for(const key of ['OMR_GO_COMPANION','OMR_EXPERIMENTAL_COMPANION','OMR_TEST_COMPANION','OMR_COMPANION_TEST_FAULTS','OMR_PROCESS_COMPANION'])delete clean[key];
const {readCompanionCatalog,companionFileDigest}=await import('../out/src/professional/companionDelivery.js');
const {catalog}=await readCompanionCatalog(path.resolve('dist/OpenMarkdownReview.html'));
const pinned=catalog.targets.find(entry=>entry.target===target);assert.ok(pinned,'Missing native Go distribution pin.');
assert.deepEqual(await companionFileDigest(candidate),{digest:pinned.executable.digest,byteLength:pinned.executable.byteLength},'The natively rebuilt Go binary must equal the release-pinned artifact, not merely pass tests as a different executable.');
const suites=[
  ['node-security',process.execPath,['--test','out/test/companion.test.js'],{}],
  ['go-unit-vet',go,['test','-v','./...'],{cwd:path.resolve('clients/companion-go')}],
  ['go-markdown-semantic-parity',process.execPath,['scripts/test-go-markdown-parity.mjs'],{}],
  ['go-security-with-isolated-fault-injection',process.execPath,['--test','out/test/companion.test.js'],{env:{...clean,OMR_GO_COMPANION:testCandidate,OMR_COMPANION_TEST_FAULTS:'true'}}],
  ['go-distribution-security',process.execPath,['--test','--test-skip-pattern=host-owned publication recovery','out/test/companion.test.js'],{env:{...clean,OMR_GO_COMPANION:candidate}}],
  ['node-native-browser-launcher',process.execPath,['--test','--test-concurrency=1','out/test/companion.browser.integration.js','out/test/companion.launcher.integration.js'],{env:{...clean,OMR_PROCESS_COMPANION:node}}],
  ['go-native-browser-launcher',process.execPath,['--test','--test-concurrency=1','out/test/companion.browser.integration.js','out/test/companion.launcher.integration.js'],{env:{...clean,OMR_GO_COMPANION:candidate}}],
];
const results=[];
for(const [name,command,args,options]of suites){const result=spawnSync(command,args,{env:clean,encoding:'utf8',timeout:300000,maxBuffer:16*1024*1024,...options});const log=(result.stdout??'')+(result.stderr??'')+(result.error?.message??'');await writeFile(path.join(output,name+'.log'),log);results.push({name,exitCode:result.status,signal:result.signal,logDigest:`sha256:${createHash('sha256').update(log).digest('hex')}`});console.log(`${result.status===0?'PASS':'FAIL'} ${name}`);if(result.status!==0)console.error(log);}
const digest=async file=>`sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}`;
const report={schemaVersion:'omr-companion-comparison/2',executedAt:new Date().toISOString(),target,executables:{node:await digest(node),go:await digest(candidate),testOnlyGo:await digest(testCandidate)},results,localCorrectnessPassed:results.every(r=>r.exitCode===0),productionMigrationApproved:false,scope:'Actual native binaries and shared protocol assertions. Test-only partial-write injection is never in the distributable build. Windows/Linux execution requires the corresponding CI job; cross-building on Mac is not execution. Managed execution policies, signing/notarization and SMB remain unqualified.'};
await writeFile(path.join(output,'correctness.json'),JSON.stringify(report,null,2)+'\n');
assert.ok(report.localCorrectnessPassed,'A correctness/security gate failed. See retained logs.');
const benchmark=spawnSync(process.execPath,['scripts/benchmark-companions.mjs'],{env:clean,stdio:'inherit',timeout:300000});assert.equal(benchmark.status,0,'Native comparison benchmark failed.');
const actions=spawnSync(process.execPath,['scripts/benchmark-companion-actions.mjs','current'],{env:clean,stdio:'inherit',timeout:300000});assert.equal(actions.status,0,'Validated comment/publication/journal benchmark failed.');
console.log('Local correctness and benchmark complete. This is not cross-platform migration approval.');
