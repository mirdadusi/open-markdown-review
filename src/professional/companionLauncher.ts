#!/usr/bin/env node
// Authoring CLI launcher. Reviewers run the bundled Go executable directly.
import {spawn} from 'node:child_process';
import path from 'node:path';
import {goExecutable} from './goCompanion';
async function main(){
  const executable=await goExecutable(path.join(__dirname,'OpenMarkdownReview.html'));
  const child=spawn(executable,process.argv.slice(2),{stdio:'inherit',shell:false});
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{if(child.exitCode===null)child.kill(signal);});
  child.once('error',error=>{console.error(error.message);process.exitCode=1;});
  child.once('exit',code=>{process.exitCode=code??1;});
}
void main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
