// Cross-compilation produces candidate artifacts, never qualification by itself.
import { readFile, writeFile, mkdir, copyFile, readdir, mkdtemp, rename, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostSourceDigest } from './go-companion-inputs.mjs';
import {goDistributionEnvironment} from './go-companion-build-options.mjs';
import {buildCompanionCore} from './build-companion-core.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)), directory = path.join(root, 'clients/companion-go');
const targets = { 'darwin-arm64': ['darwin','arm64','StartReview'], 'linux-x64': ['linux','amd64','StartReview'], 'win32-x64': ['windows','amd64','StartReview.exe'] };
const requested = process.argv.slice(2), selected = requested.length ? requested : Object.keys(targets);
if (selected.some(t => !Object.hasOwn(targets,t)) || new Set(selected).size !== selected.length) throw Error('Use darwin-arm64, linux-x64 and/or win32-x64.');
const go = process.env.OMR_GO ?? 'go';
function run(args, env={}) { const result = spawnSync(go,args,{cwd:directory,env:{...goDistributionEnvironment(process.env),...env},encoding:'utf8'}); if(result.error || result.status!==0) throw Error(`${go} ${args.join(' ')} failed: ${result.error ?? result.stderr}`); return result.stdout.trim(); }
const hostToolchain = run(['version']), toolchain='go1.27.3';
if (!hostToolchain.startsWith('go version '+toolchain+' ')) throw Error('Build requires the pinned Go 1.27.3 toolchain.');
await mkdir(path.join(directory,'assets'),{recursive:true});
await buildCompanionCore();
await copyFile(path.join(root,'dist/companion-core.js'),path.join(directory,'assets/core.js'));
await copyFile(path.join(root,'dist/companion-core-metafile.json'),path.join(directory,'assets/core-metafile.json'));
await copyFile(path.join(root,'dist/OpenMarkdownReview.html'),path.join(directory,'assets/toolbox.html'));
await copyFile(path.join(root,'LICENSE'),path.join(directory,'assets/LICENSE'));
// go list resolves the embed directives while discovering actual dependencies.
// Bootstrap every named asset on a clean checkout, before asking it to do so.
// Startup rejects this incomplete provenance if a build is interrupted here.
for(const [name,text]of [['THIRD-PARTY-NOTICES.txt','BUILD INCOMPLETE'],['go-dependencies.json','[]'],['provenance.json','{"complete":false}']]) await writeFile(path.join(directory,'assets',name),text);
const modules = [...new Set(run(['list','-deps','-f','{{with .Module}}{{if not .Main}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}{{end}}','.']).split('\n').filter(Boolean))].sort();
run(['mod','verify']);
const licenses = [await readFile(path.join(root,'dist/companion-NOTICES.txt'),'utf8')];
licenses.push('Go toolchain\n'+await readFile(path.join(run(['env','GOROOT']),'LICENSE'),'utf8'));
const inventory=[];
for(const line of modules) {
  const [name,version,moduleDirectory] = line.split('\t');
  if(!name || !version || !path.isAbsolute(moduleDirectory??'')) throw Error('Module provenance is incomplete.');
  const names=(await readdir(moduleDirectory)).filter(file=>/^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/i.test(file));
  if(!names.length) throw Error('Missing license: '+name);
  for(const file of names) licenses.push(`${name}@${version} — ${file}\n${await readFile(path.join(moduleDirectory,file),'utf8')}`);
  inventory.push({name,version,licenseFiles:names});
}
await writeFile(path.join(directory,'assets/THIRD-PARTY-NOTICES.txt'),licenses.join('\n\n'+'='.repeat(72)+'\n\n'));
await writeFile(path.join(directory,'assets/go-dependencies.json'),JSON.stringify(inventory,null,2)+'\n');
const sha=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const inputs={ hostSource:await hostSourceDigest(directory), core:sha(await readFile(path.join(directory,'assets/core.js'))), toolbox:sha(await readFile(path.join(directory,'assets/toolbox.html'))), notices:sha(await readFile(path.join(directory,'assets/THIRD-PARTY-NOTICES.txt'))), goMod:sha(await readFile(path.join(directory,'go.mod'))), goSum:sha(await readFile(path.join(directory,'go.sum'))) };
const version=JSON.parse(await readFile(path.join(root,'package.json'))).version;
await writeFile(path.join(directory,'assets/provenance.json'),JSON.stringify({schemaVersion:'omr-go-build/1',complete:true,applicationVersion:version,toolchain,inputs,productionDefault:true},null,2));
for(const target of selected) {
  const [GOOS,GOARCH,filename]=targets[target], out=path.join(root,'dist/companion-go',target); await mkdir(out,{recursive:true});
  await copyFile(path.join(directory,'assets/THIRD-PARTY-NOTICES.txt'),path.join(out,'THIRD-PARTY-NOTICES.txt'));
  for(const test of [false,true]) {
    const executable=path.join(out,test?filename.replace(/(\.exe)?$/,'.test$1'):filename);
    const stage=await mkdtemp(path.join(out,'.build-')),pending=path.join(stage,filename);
    run(['build','-trimpath','-buildvcs=false',...(test?['-tags','omrtest']:[]),'-ldflags=-s -w','-o',pending,'.'],{GOOS,GOARCH});
    await rename(pending,executable);await rmdir(stage);
    const bytes=await readFile(executable), digest=sha(bytes);
    await writeFile(executable+'.sha256',`${digest.slice(7)}  ${path.basename(executable)}\n`);
    await writeFile(executable+'.build.json',JSON.stringify({schemaVersion:'omr-go-build/1',runtime:'go',version,target,toolchain,inputs,testFaults:test,digest,byteLength:bytes.length,qualified:false,codeSigning:GOOS==='darwin'?'Go linker ad-hoc signature; not notarized':'unsigned; organization approval may be required',qualification:'Packaging is not target-platform runtime qualification.'},null,2)+'\n');
    console.log(`${target} ${test?'TEST ONLY':'candidate'}: ${bytes.length} bytes ${digest}`);
  }
}
