import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, Frame, Page } from 'playwright';
import { ProfessionalHost } from '../src/professional/extensionHost';
import { AuthorRequest } from '../src/professional/authoring';
import { startNativeCompanion } from './companionHost';
import { NativeStorage } from '../src/professional/nativeStorage';
import { ReviewSession } from '../src/professional/session';
import { digest } from '../src/professional/bytes';
import { memento } from './reviewer.extension.integration';
import { creationSetup } from './creation.extension.integration';
import packageJson from '../package.json';
import { ReviewSetupPanel } from '../src/setupView';

type Surface=Frame|Page;
async function save(surface:Surface,body:string) {
  await surface.locator('#composer').waitFor({state:'visible'}); await surface.locator('#body').fill(body);await surface.locator('#save').click();
  await surface.waitForFunction(()=>!(document.getElementById('composer') as HTMLDialogElement).open || (document.getElementById('composer-error')?.textContent??'').includes('Press Save event again'),{timeout:60000});
  if(await surface.locator('#composer').isVisible()) await surface.locator('#save').click();
  await surface.locator('#composer').waitFor({state:'hidden',timeout:60000});
}
async function selectText(surface:Surface,exact:string) {
  await surface.evaluate(exact=>{
    const walker=document.createTreeWalker(document.getElementById('document')!,NodeFilter.SHOW_TEXT);let node:Node|null;
    while((node=walker.nextNode())) { const offset=node.textContent!.indexOf(exact);if(offset<0)continue;
      const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+exact.length);const selection=getSelection()!;selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));return;
    }
    throw Error('Exact rendered text was not found.');
  },exact);
}
async function sees(surface:Surface,text:string) {
  await surface.waitForFunction(text=>document.getElementById('threads')?.textContent?.includes(text),text,{timeout:30000});
}

/** Actual Electron webview + two native loopback hosts, one unchanged review. */
export async function run():Promise<void> {
  const extension=vscode.extensions.getExtension(`${packageJson.publisher}.${packageJson.name}`);assert.ok(extension);await extension.activate();
  assert.ok(process.env.OMR_GO_COMPANION && path.isAbsolute(process.env.OMR_GO_COMPANION),'Use the actual native Go candidate.');
  assert.ok(process.env.OMR_NODE_COMPANION && path.isAbsolute(process.env.OMR_NODE_COMPANION),'Use the actual native Node distribution.');
  assert.equal(process.env.OMR_COMPANION_TEST_FAULTS,undefined,'Mixed-client E2E must use the distribution build, not fault injection.');
  const temporary=await mkdtemp(path.join(os.tmpdir(),'omr-mixed-clients-')),source=path.join(temporary,'source'),root=path.join(temporary,'review');
  await vscode.workspace.getConfiguration('workbench').update('colorTheme','Default Light Modern',vscode.ConfigurationTarget.Global);
  await creationSetup(extension.extensionPath,temporary);
  await mkdir(source);
  await writeFile(path.join(source,'index.md'),'# Cross-client review\n\nFrozen paragraph with Příliš žluťoučký kůň.\n\n[Second document](second.md)\n\n| Requirement | State |\n|---|---|\n| Shared evidence | Required |\n\n![Frozen SVG](image.svg)\n\n```mermaid\nflowchart LR\n A[Create] --> B[Review] --> C[Archive]\n```\n');
  await writeFile(path.join(source,'second.md'),'# Second document\n\nSecond document challenge target.\n');
  await writeFile(path.join(source,'image.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="60"><rect width="160" height="60" fill="#2563a6"/></svg>');
  const creator={id:'creator@example.com',displayName:'Review Initiator'},journalRoot=path.join(temporary,'vscode-private');
  const context={extensionPath:extension.extensionPath,extensionUri:vscode.Uri.file(extension.extensionPath),globalState:memento(),workspaceState:memento(),globalStorageUri:vscode.Uri.file(journalRoot)} as vscode.ExtensionContext;
  const host=new ProfessionalHost(context);
  const cdp=await chromium.connectOverCDP(`http://127.0.0.1:${process.env.OMR_TEST_CDP_PORT}`);
  let node:Awaited<ReturnType<typeof startNativeCompanion>>|undefined,go:Awaited<ReturnType<typeof startNativeCompanion>>|undefined;
  const browser=await chromium.launch({headless:true,channel:'chromium',...(process.env.OMR_TEST_BROWSER?{executablePath:process.env.OMR_TEST_BROWSER}:{})});
  const output=process.env.OMR_INTEROP_OUTPUT!;await mkdir(output,{recursive:true});
  const external:string[]=[],pageErrors:string[]=[];
  const rendererErrors:string[]=[];
  const watch=(page:Page)=>{page.on('pageerror',error=>rendererErrors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&rendererErrors.length<100)rendererErrors.push(message.text());});};
  for(const ctx of cdp.contexts()){ctx.pages().forEach(watch);ctx.on('page',watch);}
  try {
    if (process.env.OMR_CAPTURE_DOCS === 'true') {
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('notifications.clearAll');
      const setup = ReviewSetupPanel.show(context, { initialized: false, workspaceName: 'Documentation example', title: 'Design review', availableDocuments: ['index.md', 'second.md'], selectedDocuments: ['index.md', 'second.md'], rootDocument: 'index.md', sourceRoot: source, storageRoot: root, storageEditable: true, portableBrowserDefault: true, reviewerEmails: ['alex@example.com', 'sam@example.com'], companionTargets: ['win32-x64', 'darwin-arm64', 'linux-x64'] });
      let setupFrame: Frame | undefined;
      for (let attempt = 0; attempt < 300 && !setupFrame; attempt++) {
        for (const page of cdp.contexts().flatMap(c => c.pages())) for (const frame of page.frames()) {
          try { if (await frame.locator('.companion-platforms:visible').count()) { setupFrame = frame; break; } } catch { /* Initial webview navigation. */ }
        }
        if (!setupFrame) await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(setupFrame, 'The real setup webview must open before capturing documentation.');
      await setupFrame.page().setViewportSize({ width: 1440, height: 1100 });
      await setupFrame.locator('.companion-platforms').scrollIntoViewIfNeeded();
      await setupFrame.page().screenshot({ path: path.join(output, 'vscode-setup.png') });
      await setupFrame.locator('#cancel').click(); assert.equal(await setup, undefined);
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(source,'index.md'))));
    const request:AuthorRequest={source,store:root,rootDocument:'index.md',title:'VS Code, Node and Go interoperability',actor:creator,reviewerEmails:['alex@example.com','sam@example.com','waiting@example.com'],include:['index.md','second.md'],operationId:'mixed_client_creation',journalRoot,clientArtifact:path.join(extension.extensionPath,'dist/OpenMarkdownReview.html')};
    await (host as unknown as {runCreation(request:AuthorRequest):Promise<void>}).runCreation(request);
    assert.equal(host.active?.root,root);assert.equal(host.getChildren().length,1);
    let frame:Frame|undefined;
    for(let attempt=0;attempt<600&&!frame;attempt++) {
      for(const page of cdp.contexts().flatMap(c=>c.pages())) for(const candidate of page.frames()) {
        try { if(await candidate.locator('#workspace:visible').count()) {frame=candidate;break;} } catch { /* Frame navigation is expected during webview startup. */ }
      }
      if(!frame) await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!frame) {
      const pages=cdp.contexts().flatMap(ctx=>ctx.pages()),details=[];
      for(let i=0;i<pages.length;i++){
        const page=pages[i];await page.screenshot({path:path.join(output,`frame-timeout-${i}.png`)});
        const frames=[];
        for(const f of page.frames())frames.push({url:f.url(),state:await f.evaluate(()=>({ready:document.readyState,text:document.body?.innerText?.slice(0,3000),clientReady:document.documentElement.dataset.clientReady})).catch(error=>String(error))});
        details.push({title:await page.title(),frames});
      }
      const session=await cdp.newBrowserCDPSession();const targets=await session.send('Target.getTargets');await session.detach();
      await writeFile(path.join(output,'frame-timeout.json'),JSON.stringify({details,targets,rendererErrors,tabs:vscode.window.tabGroups.all.map(group=>group.tabs.map(tab=>({label:tab.label,active:tab.isActive})))},null,2));
      console.error(JSON.stringify({details,rendererErrors}));
    }
    assert.ok(frame,'The actual VS Code Electron webview did not open; see frame-timeout diagnostics.');
    const view=frame;
    await view.locator('#document table').waitFor();await view.locator('#document .diagram svg').waitFor();
    await view.waitForFunction(()=>[...document.querySelectorAll<HTMLImageElement>('#document img')].every(image=>image.complete&&image.naturalWidth>0));
    assert.equal(await view.locator('#actor-id').inputValue(),creator.id);
    const manifest=await readFile(path.join(root,'manifest.json')),html=await readFile(request.clientArtifact!,'utf8');
    node=await startNativeCompanion({root,journalRoot:path.join(temporary,'node-private'),html},process.env.OMR_NODE_COMPANION!);
    go=await startNativeCompanion({root,journalRoot:path.join(temporary,'go-private'),html},process.env.OMR_GO_COMPANION!);
    const pages=[] as Page[];
    for(const [helper,email,name]of [[node,'alex@example.com','Node Reviewer'],[go,'sam@example.com','Go Reviewer']] as const) {
      const ctx=await browser.newContext({viewport:{width:1440,height:1000}});
      await ctx.addInitScript(()=>{window.showDirectoryPicker=async()=>{throw new DOMException('Managed folder picker blocked.','NotAllowedError');};});
      await ctx.route(/^https?:\/\//,route=>{const url=route.request().url();if(!url.startsWith(node!.origin+'/')&&!url.startsWith(go!.origin+'/')){external.push(url);return route.abort();}return route.continue();});
      const page=await ctx.newPage();page.on('pageerror',error=>pageErrors.push(error.message));await page.goto(helper.url);await page.locator('#workspace').waitFor({state:'visible',timeout:60000});
      await page.locator('#actor-id').fill(email);await page.locator('#actor-name').fill(name);pages.push(page);
      await page.locator('#document table').waitFor();await page.locator('#document .diagram svg').waitFor();
      await page.waitForFunction(()=>[...document.querySelectorAll<HTMLImageElement>('#document img')].every(image=>image.complete&&image.naturalWidth>0));
    }
    const [nodePage,goPage]=pages;
    // An actual VS Code source selection is handed over to the actual webview.
    const sourceDocument=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(source,'index.md'))),editor=await vscode.window.showTextDocument(sourceDocument);
    const start=sourceDocument.getText().indexOf('Frozen paragraph');editor.selection=new vscode.Selection(sourceDocument.positionAt(start),sourceDocument.positionAt(start+'Frozen paragraph'.length));
    await host.forward('comment');await save(view,'VSCODE_CHALLENGE: Clarify this frozen paragraph.');
    await Promise.all([sees(nodePage,'VSCODE_CHALLENGE'),sees(goPage,'VSCODE_CHALLENGE')]);
    assert.equal(await nodePage.locator('[data-action="resolve"]').count(),0);
    await Promise.all([nodePage.locator('[data-action="reply"]').first().click(),goPage.locator('[data-action="reply"]').first().click()]);
    await Promise.all([save(nodePage,'NODE_RESPONSE: Confirmed in the Node-hosted browser.'),save(goPage,'GO_RESPONSE: Confirmed in the Go-hosted browser.')]);
    await Promise.all([sees(view,'NODE_RESPONSE'),sees(view,'GO_RESPONSE'),sees(goPage,'NODE_RESPONSE'),sees(nodePage,'GO_RESPONSE')]);
    await goPage.locator('[data-document="second.md"]').click();await goPage.locator('#document').getByText('Second document challenge target.').waitFor();
    await selectText(goPage,'Second document challenge');await goPage.locator('#selection-comment').click();await save(goPage,'GO_CHALLENGE: Finding on the second Markdown document.');
    await sees(view,'GO_CHALLENGE');await sees(nodePage,'GO_CHALLENGE');
    assert.ok(await view.locator('#document .commented, #document mark').count(),'VS Code highlights its anchored finding.');
    await view.locator('[data-action="resolve"]').first().click();await save(view,'CREATOR_RESOLUTION: Accepted and clarified during review.');
    await goPage.waitForFunction(()=>!!document.querySelector('#threads .closed'),{timeout:30000});
    await nodePage.locator('#approve').click();await save(nodePage,'NODE_APPROVAL: Approved after discussion.');
    await nodePage.locator('#finish-review').click();await save(nodePage,'NODE_FINISHED: Review completed.');
    await goPage.locator('#finish-review').click();await save(goPage,'GO_FINISHED: Review completed.');
    await view.waitForFunction(()=>document.querySelectorAll('[data-reviewer-status="finished"]').length===2,{timeout:30000});
    await nodePage.reload();await nodePage.locator('#workspace').waitFor({state:'visible',timeout:60000});
    assert.equal(await nodePage.locator('#actor-id').inputValue(),'alex@example.com');assert.ok(await nodePage.locator('#comment').isDisabled());
    await goPage.reload();await goPage.locator('#workspace').waitFor({state:'visible',timeout:60000});
    assert.equal(await goPage.locator('#actor-id').inputValue(),'sam@example.com');assert.ok(await goPage.locator('#comment').isDisabled());
    if (process.env.OMR_CAPTURE_DOCS === 'true') {
      await view.locator('#documents [data-document="index.md"]').click();
      await view.locator('#document .diagram svg').waitFor();
      await view.locator('#toast.visible').waitFor({ state: 'hidden', timeout: 15000 });
      await vscode.commands.executeCommand('notifications.clearAll');
    }
    await view.page().screenshot({path:path.join(output,'vscode-participation.png')});
    await nodePage.screenshot({path:path.join(output,'node-participation.png')});await goPage.screenshot({path:path.join(output,'go-participation.png')});
    // Final review action: export via the real VS Code webview and native bridge.
    await view.locator('#export').click();
    await view.waitForFunction(()=>['success','error'].includes(document.getElementById('export-result')?.dataset.kind??''),{timeout:90000});
    assert.equal(await view.locator('#export-result').getAttribute('data-kind'),'success',await view.locator('#export-result-message').innerText());
    const verified=new ReviewSession(new NativeStorage(root,path.join(temporary,'independent-audit')));await verified.open();
    assert.equal(verified.diagnostics.length,0);const audit=await verified.audit(verified.context(creator));assert.equal(audit.diagnostics.filter(d=>d.severity==='error').length,0);
    const exported=verified.events.find(e=>e.type==='export.created');assert.ok(exported?.type==='export.created');
    assert.equal(digest(await readFile(path.join(root,exported.pdf.path))),exported.pdf.digest);
    assert.deepEqual(await readFile(path.join(root,'manifest.json')),manifest,'Every client used the same immutable manifest.');
    for(const name of await readdir(path.join(root,'events')))assert.equal(name,`${digest(await readFile(path.join(root,'events',name))).slice(7)}.json`);
    assert.equal(verified.events.filter(e=>e.type==='review.completed').length,2);assert.equal(verified.events.filter(e=>e.type==='comment.replied').length,2);
    const last=[...verified.events].sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt)).at(-1)!;assert.equal(last.type,'export.created','Export is the final recorded review action.');
    const eventCount=verified.events.length;
    await view.locator('#export-mode').selectOption('clean');await view.locator('#export').click();
    await view.locator('#export-result[data-kind="success"],#export-result[data-kind="error"]').waitFor({timeout:90000});
    assert.equal(await view.locator('#export-result').getAttribute('data-kind'),'success',await view.locator('#export-result-message').innerText());
    const cleanPdfPath=(await view.locator('#export-result-path').innerText()).match(/exports\/[a-f0-9]{64}\.pdf/)![0];
    const cleanPdfDigest=digest(await readFile(path.join(root,cleanPdfPath)));
    await verified.refresh();assert.equal(verified.events.length,eventCount,'Clean export in the real VS Code webview does not alter review history.');
    assert.deepEqual(external,[]);assert.deepEqual(pageErrors,[]);
    const executables={node:digest(await readFile(process.env.OMR_NODE_COMPANION!)),go:digest(await readFile(process.env.OMR_GO_COMPANION!))};
    await writeFile(path.join(output,'result.json'),JSON.stringify({schemaVersion:'omr-interoperability/1',platform:process.platform,arch:process.arch,executables,root,pdfPath:exported.pdf.path,pdfDigest:exported.pdf.digest,cleanPdfPath,cleanPdfDigest,inventoryPath:exported.inventory.path,events:verified.events.map(e=>({type:e.type,actor:e.actor.id})),reviewId:verified.manifest.reviewId,executedAt:new Date().toISOString()},null,2)+'\n');
    process.stdout.write('Actual VS Code creation/selection/webview, Node HTML, Go HTML, shared live feedback, creator resolution, completion and final audited PDF passed.\n');
  } finally {
    await browser.close();await go?.close();await node?.close();host.dispose();await vscode.commands.executeCommand('workbench.action.closeAllEditors');await cdp.close();
  }
}
