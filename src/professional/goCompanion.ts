import {spawn} from 'node:child_process';
import path from 'node:path';
import type {Companion,CompanionOptions} from './companion';
import {companionFileDigest,readCompanionCatalog} from './companionDelivery';
import {fromBase64,parseJson} from './bytes';
import {LIMITS,ProtocolError} from './types';

/** Always use this installation's pinned Go binary, never executable review content. */
export async function goExecutable(artifact:string,development=false):Promise<string>{
  const target=`${process.platform}-${process.arch}`;
  const {catalog}=await readCompanionCatalog(artifact),entry=catalog.targets.find(e=>e.target===target);
  if(!entry)throw new ProtocolError('unsupported',`No bundled Go companion supports ${target}.`);
  const name=process.platform==='win32'?'StartReview.exe':'StartReview',base=path.dirname(artifact);
  const candidates=[path.join(base,'bundled-companions',target,name),...(development?[path.join(base,'companion-go',target,name)]:[])];
  for(const file of candidates){
    try{const actual=await companionFileDigest(file);if(actual.digest!==entry.executable.digest||actual.byteLength!==entry.executable.byteLength)throw new ProtocolError('integrity','The installed Go companion differs from its pinned distribution. Reinstall the complete extension.');return file;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  throw new ProtocolError('missing',`The installed ${target} Go companion is missing. Reinstall the complete authoring VSIX for this extension version. Node is legacy only; no fallback or download was attempted.`);
}

export async function startGoCompanion(options:Omit<CompanionOptions,'html'>&{artifact:string;development?:boolean}):Promise<Companion>{
  const executable=await goExecutable(options.artifact,options.development);
  const args=['--store',options.root,'--recovery-root',options.journalRoot,'--no-open'];
  if(options.idleTimeoutMs!==undefined)args.push('--idle-ms',String(options.idleTimeoutMs));
  const child=spawn(executable,args,{stdio:['ignore','pipe','pipe'],shell:false});
  let stderr='';child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-8192);});
  const exited=new Promise<number|null>((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  // Attach immediately; startup failures must not leave an unhandled rejection.
  void exited.catch(()=>undefined);
  try{
    const url=await new Promise<string>((resolve,reject)=>{
      let output='';
      const cleanup=()=>{clearTimeout(timer);child.stdout.removeListener('data',onData);child.removeListener('error',onError);child.removeListener('exit',onExit);};
      const onError=(error:Error)=>{cleanup();reject(error);};
      const onExit=(code:number|null)=>onError(new Error(`The Go companion exited before startup (${code}): ${stderr}`));
      const onData=(b:Buffer)=>{
        output+=b.toString();if(output.length>131072){onError(new Error('Unexpected Go startup output.'));return;}
        const m=/http:\/\/127\.0\.0\.1:\d+\/#omr-session=[a-f0-9]{64}/.exec(output);if(m){cleanup();resolve(m[0]);}
      };
      const timer=setTimeout(()=>onError(new Error('The Go companion did not become ready within 30 seconds.')),30000);
      child.stdout.on('data',onData);child.once('error',onError);child.once('exit',onExit);
    });
    const local=new URL(url),token=new URLSearchParams(local.hash.slice(1)).get('omr-session')!;
    const rpc=async(method:string,args:unknown[]=[])=>{
      const response=await fetch(local.origin+'/api/rpc',{method:'POST',headers:{Origin:local.origin,'Content-Type':'application/json','X-OMR-Session':token},body:JSON.stringify({method,args}),signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error(`Go companion HTTP ${response.status}.`);
      const result=await response.json() as {ok:boolean;value:unknown;error?:string};
      if(!result.ok)throw new Error(result.error??'Go companion operation failed.');return result.value;
    };
    const manifest=parseJson<{reviewId:string}>(fromBase64(await rpc('read',['manifest.json',LIMITS.manifest]) as string),LIMITS.manifest);
    const closed=exited.then(code=>{if(code!==0)throw new Error(`The Go companion stopped unexpectedly (${code}): ${stderr}`);});
    void closed.catch(()=>undefined);
    let stopping:Promise<void>|undefined;
    return{root:options.root,reviewId:manifest.reviewId,url,origin:local.origin,closed,close:()=>stopping??=(async()=>{if(child.exitCode===null&&child.signalCode===null)await rpc('stop');await closed;})()};
  }catch(error){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited.catch(()=>undefined);throw error;}
}
