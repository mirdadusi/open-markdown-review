import {build} from 'esbuild';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {goCompanionBuildOptions} from './go-companion-build-options.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
export async function buildCompanionCore(){
 const result=await build({...goCompanionBuildOptions,entryPoints:[path.join(root,'clients/companion-go/bridge.ts')],outfile:path.join(root,'dist/companion-core.js'),bundle:true,platform:'neutral',mainFields:['module','main'],target:'es2022',format:'iife',globalName:'OMR',minify:true,metafile:true});
 await writeFile(path.join(root,'dist/companion-core-metafile.json'),JSON.stringify(result.metafile,null,2)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await buildCompanionCore();
