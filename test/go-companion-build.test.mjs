import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {goDistributionEnvironment} from '../scripts/go-companion-build-options.mjs';

test('distribution builds ignore inherited test tags, overlays, workspace substitutions and host-specific CPU tuning',()=>{
  const inherited={GOFLAGS:'-buildvcs=true -tags=omrtest -overlay=/unexpected.json -modfile=/other.mod',GOWORK:'/other/go.work',GOENV:'/other/env',GOEXPERIMENT:'arbitrary',GOAMD64:'v4',GOARM64:'v9.5',GOTOOLCHAIN:'auto',CGO_ENABLED:'1',GOPATH:'/trusted/cache',GOPROXY:'https://approved-proxy.example',PATH:'/toolchain/bin'};
  const clean=goDistributionEnvironment(inherited);
  assert.equal(clean.GOFLAGS,'-buildvcs=false -mod=readonly -p=1');assert.equal(clean.GOWORK,'off');assert.equal(clean.GOENV,'off');
  assert.equal(clean.GOEXPERIMENT,'');assert.equal(clean.GOAMD64,'v1');assert.equal(clean.GOARM64,'v8.0');assert.equal(clean.CGO_ENABLED,'0');assert.equal(clean.GOTOOLCHAIN,'local');
  for(const key of ['GOPATH','GOPROXY','PATH'])assert.equal(clean[key],inherited[key],'Retain explicitly configured cache/proxy/toolchain locations.');
  assert.match(inherited.GOFLAGS,/omrtest/,'Do not mutate the caller environment.');
});

// The source-only suite does not require a Go SDK. Both native companion CI jobs
// install one before npm test, so this regression executes on Linux and Windows.
const go=process.env.OMR_GO??'go', sdk=spawnSync(go,['version'],{encoding:'utf8'});
test('Go dependency discovery works in a foreign-owned checkout without widening Git trust', {skip:sdk.status!==0?'Go SDK unavailable; native companion CI requires it.':false}, async()=>{
  const temporary=await realpath(await mkdtemp(path.join(os.tmpdir(),'omr-go-owner-'))), root=path.join(temporary,'checkout with spaces'), global=path.join(temporary,'isolated.gitconfig');
  await mkdir(root);await writeFile(global,'# isolated Go checkout test\n');
  await writeFile(path.join(root,'go.mod'),'module example.com/omr-checkout-fixture\n\ngo 1.22\n');
  await writeFile(path.join(root,'main.go'),'package main\nfunc main() {}\n');
  const env={...process.env,GIT_CONFIG_GLOBAL:global,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_COUNT:'0',GIT_CONFIG_PARAMETERS:'',GIT_TEST_ASSUME_DIFFERENT_OWNER:'0',LANG:'C',LC_ALL:'C'};
  const git=args=>spawnSync('git',args,{env,encoding:'utf8'});
  const initialized=git(['init','--object-format=sha1',root]);assert.equal(initialized.status,0,initialized.stderr);
  const committed=git(['-C',root,'-c','user.name=Go Checkout Fixture','-c','user.email=fixture@example.com','-c','commit.gpgsign=false','-c',`core.hooksPath=${path.join(temporary,'no-hooks')}`,'commit','--allow-empty','-m','fixture']);assert.equal(committed.status,0,committed.stderr);
  const foreign={...env,GIT_TEST_ASSUME_DIFFERENT_OWNER:'1'}, clean=goDistributionEnvironment(foreign);
  const refused=spawnSync('git',['-C',root,'rev-parse','HEAD'],{env:foreign,encoding:'utf8'});assert.notEqual(refused.status,0);assert.match(refused.stderr,/dubious ownership/);
  const args=['list','-deps','-f','{{with .Module}}{{if .Main}}{{.Path}}{{end}}{{end}}','.'];
  const stamped=spawnSync(go,args,{cwd:root,env:{...clean,GOFLAGS:'-buildvcs=true -mod=readonly -p=1'},encoding:'utf8'});
  assert.notEqual(stamped.status,0,'The fixture must reproduce the failing VCS lookup.');assert.match(stamped.stderr,/error obtaining VCS status/);
  const listed=spawnSync(go,args,{cwd:root,env:clean,encoding:'utf8'});assert.equal(listed.status,0,listed.stderr);assert.equal(listed.stdout.trim(),'example.com/omr-checkout-fixture');
  assert.equal(await readFile(global,'utf8'),'# isolated Go checkout test\n');
  assert.notEqual(spawnSync('git',['-C',root,'rev-parse','HEAD'],{env:foreign}).status,0,'Go dependency discovery must not change checkout trust.');
});
