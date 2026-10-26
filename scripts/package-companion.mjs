// Go is required for default distributions. Node is an explicit legacy build.
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const args=process.argv.slice(2);
if(args.some(t=>!['win32-x64','linux-x64','darwin-arm64'].includes(t)))throw Error('Use win32-x64, linux-x64 and/or darwin-arm64. For legacy Node use package:companion:legacy.');
const result=spawnSync(process.execPath,[path.resolve('scripts/build-go-companion.mjs'),...(args.length?args:[`${process.platform}-${process.arch}`])],{stdio:'inherit',env:process.env,shell:false});
if(result.error)throw result.error;
process.exitCode=result.status??1;
