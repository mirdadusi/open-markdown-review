// Compare the embedded Go validation core with the unmodified Node parser.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const require=createRequire(import.meta.url),{inspect}=require('../out/src/professional/validation.js');
const sources=[
 '# Heading\n\nBare www.example.com and https://example.com must remain text.\n',
 '[Named link](https://example.com/a?q=b)\n\n![Image](assets/diagram.svg)\n\n[Attachment](appendix.txt "review:attach")',
 '| A | B |\n|---|---|\n| Příliš žluťoučký kůň | 😀 |\n',
 '```mermaid\nflowchart LR\n A[Read] --> B[Review]\n```\n',
 '<table><tr><td>A</td><td>B</td></tr></table>\n<img src="images/české.svg">\n<a href="https://example.com">external</a>',
 '[nested **label**](../doc.md#section) and `code`\n\n<https://example.com>\n',
 'A\\*b &amp; &#x1F600;\n\n<script>alert(1)</script>\n',
 '[ref]: https://example.com\n\n[reference][ref]\n\n![missing][nope]\n',
 ];
const vectors=[];
for(const profile of ['commonmark-gfm','commonmark-gfm+sanitized-html-v1'])for(const source of sources){
 const input={document:'docs/české.md',source,profile};
 try{vectors.push({...input,expected:inspect(source,input.document,profile)});}catch(error){vectors.push({...input,error:error.message});}
}
const out=path.resolve('output/companion-comparison',`${process.platform}-${process.arch}`);await mkdir(out,{recursive:true});
const file=path.join(out,'markdown-parity.json');await writeFile(file,JSON.stringify(vectors,null,2)+'\n');
const result=spawnSync(process.env.OMR_GO??'go',['test','-run=^TestEmbeddedMarkdownParity$','-v','.'],{cwd:path.resolve('clients/companion-go'),env:{...process.env,OMR_GO_MARKDOWN_VECTORS:file},encoding:'utf8',timeout:120000});
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
assert.equal(result.status,0,result.error?.message??'Embedded Markdown semantic parity failed');
