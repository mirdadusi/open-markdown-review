import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectPdf } from './inspect-pdf.mjs';

export async function verifyInteropExport(output) {
  const result=JSON.parse(await readFile(path.join(output,'result.json'),'utf8'));
  assert.match(result.pdfPath,/^exports\/[a-f0-9]{64}\.pdf$/);
  const file=path.join(result.root,result.pdfPath),bytes=await readFile(file);
  assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`,result.pdfDigest);
  const inspected=await inspectPdf(bytes);assert.deepEqual(inspected.violations,[]);
  const text=[...inspected.pages.map(page=>page.text),...inspected.annotations.map(a=>a.contents)].join('\n'),compact=text.replace(/\s+/g,'');
  for(const marker of ['VSCODE_CHALLENGE','NODE_RESPONSE','GO_RESPONSE','GO_CHALLENGE','CREATOR_RESOLUTION','alex@example.com','sam@example.com','waiting@example.com','Finished','Not started','Příliš žluťoučký kůň']) assert.ok(compact.includes(marker.replace(/\s+/g,'')),`Missing PDF evidence: ${marker}`);
  assert.ok(inspected.images.length>=2,'Frozen SVG and Mermaid must both appear.');
  assert.ok(inspected.annotations.some(a=>a.subtype==='Highlight'),'Findings must be native PDF annotations.');
  assert.ok(inspected.annotations.some(a=>a.subtype==='Text'&&a.inReplyTo),'Replies must have native parent references.');
  assert.ok(!inspected.links.some(link=>link.destination?.startsWith('omr-pdf-comment/')),'Temporary comment links must not remain.');
  assert.match(result.cleanPdfPath,/^exports\/[a-f0-9]{64}\.pdf$/);
  const cleanBytes=await readFile(path.join(result.root,result.cleanPdfPath)),clean=await inspectPdf(cleanBytes);
  assert.equal(`sha256:${createHash('sha256').update(cleanBytes).digest('hex')}`,result.cleanPdfDigest);
  assert.deepEqual(clean.violations,[]);assert.equal(clean.annotations.length,0);assert.equal(clean.attachments,null);
  const cleanText=clean.pages.map(p=>p.text).join('\n')+JSON.stringify(clean.metadata);
  for(const value of ['VSCODE_CHALLENGE','NODE_RESPONSE','GO_RESPONSE','CREATOR_RESOLUTION','alex@example.com','sam@example.com',result.reviewId])assert.ok(!cleanText.includes(value),`Clean output leaks review information: ${value}`);
  const directory=path.resolve('output/pdf');await mkdir(directory,{recursive:true});
  const final=path.join(directory,`mixed-client-review-${result.platform}-${result.arch}.pdf`);await copyFile(file,final);
  await writeFile(path.join(output,'pdf-verification.json'),JSON.stringify({pdfDigest:result.pdfDigest,pageCount:inspected.pageCount,images:inspected.images.length,links:inspected.links.length,violations:inspected.violations,markersVerified:true,finalPdf:final},null,2)+'\n');
  console.log(`Mixed-client final PDF verified: ${final} (${inspected.pageCount} pages)`);
}
