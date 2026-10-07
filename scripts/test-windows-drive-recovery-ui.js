// Real production settings renderer/preload with controlled IPC responses.
// Native file preservation and daemon recovery are verified by separate gates.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');
const {app,BrowserWindow,ipcMain}=require('electron');
// Keep shutdown under the test's control so cleanup cannot mask a rejection.
app.on('window-all-closed',()=>{});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
 assert.equal(process.platform,'win32','This gate requires the real Windows preload platform.');
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'ember-recovery-ui-'));app.setPath('userData',profile);await app.whenReady();
 const evidence=path.resolve('dist/windows-drive-recovery-ui-evidence');await fs.mkdir(evidence,{recursive:true});
 const id=crypto.randomUUID(),calls=[],errors=[];let mounted=true,recoveryReason='local-changed',entries=[{id,type:'pinned',local:'remote/Recovered.txt',started:Date.now()}];
 const status=()=>({supported:true,configured:true,mounted,provider:'s3',bucket:'fixture',path:'C:\\Ember UI Fixture',cacheLimitGB:5,pins:{keys:[],syncing:false,done:0,total:0}});
 ipcMain.handle('settings:get',()=>({driveBackupRecordings:false,driveBackupNotes:false}));
 ipcMain.handle('share:state',()=>({configured:false}));ipcMain.handle('drive:status',status);
 ipcMain.handle('drive:request',(_event,cmd,args)=>{
  calls.push({cmd,args});if(cmd==='recover'&&args?.list)return {entries:[...entries],count:entries.length};if(cmd==='cache')return {bytes:0,pinnedBytes:0};
  if(cmd==='recover'){
   assert.equal(args.id,id);assert.equal(entries.length,1);
   if(args.revealCopies){assert.equal(args.kind,'pinned-copy');return {revealed:true};}
   if(args.forget){assert.equal(args.kind,'pinned-copy');assert.equal(args.forget,true);entries=[];return {removed:true};}
   if(entries[0].type==='delete'){
    assert.equal(args.kind,'delete');assert.equal(mounted,true);
    if(args.revealFile===true)return {revealed:true};
    assert.equal(args.finish,false,'settings must only inspect deletion outcomes');return {resolved:false,reason:recoveryReason};
   }
   if(entries[0].type==='folder-move'){
    assert.equal(args.kind,'folder-move');assert.equal(mounted,true);
    if(args.finish===true){entries=[];return {resolved:true};}
    assert.equal(args.finish,false);return {resolved:false,reason:'folder-copy-missing'};
   }
   assert.equal(args.kind,'pinned');assert.equal(mounted,true);
   if(args.finish===true){entries=[{...entries[0],type:'pinned-copy'}];return {resolved:true,localCopiesPreserved:true};}
   assert.equal(args.finish,false);return {resolved:false,reason:recoveryReason};
  }
  throw Error('Unexpected renderer request: '+cmd);
 });
 const window=new BrowserWindow({width:1250,height:1100,show:true,webPreferences:{preload:path.resolve('src/preload.js'),contextIsolation:true,nodeIntegration:false}});
 window.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
 const evaluate=expression=>window.webContents.executeJavaScript(expression,true);
 const wait=async(expression,label)=>{const end=Date.now()+15000;while(!await evaluate(expression)){assert(Date.now()<end,label);await delay(50);}};
 const button=label=>`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)})`;
 const visible=label=>`Boolean(${button(label)})`;
 const click=async label=>{
  const point=await evaluate(`(()=>{const b=${button(label)};if(!b||b.disabled)throw Error('Unavailable control: '+${JSON.stringify(label)});b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
 };
 const recoverCalls=()=>calls.filter(call=>call.cmd==='recover'&&!call.args?.list);
 const screenshot=async name=>{await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await delay(150);await fs.writeFile(path.join(evidence,name+'.png'),(await window.webContents.capturePage()).toPNG());};
 const confirmationVisible=async label=>{try{await wait(`(()=>{const b=${button(label)},panel=b?.parentElement?.parentElement;if(!panel)return false;const r=panel.getBoundingClientRect();return r.top>=0&&r.bottom<=window.innerHeight&&document.activeElement===panel;})()`, 'The '+label+' confirmation must be visible and focused.');}catch(error){const detail=await evaluate(`(()=>{const b=${button(label)},panel=b?.parentElement?.parentElement,r=panel?.getBoundingClientRect();return {label:${JSON.stringify(label)},top:r?.top,bottom:r?.bottom,height:window.innerHeight,focused:document.activeElement===panel,activeTag:document.activeElement?.tagName,activeText:document.activeElement?.textContent?.slice(0,200),panelText:panel?.textContent};})()`);await fs.writeFile(path.join(evidence,'confirmation-failure.json'),JSON.stringify(detail,null,2));await screenshot('confirmation-failure');throw Error(error.message+' '+JSON.stringify(detail));}};
 try{
  await window.loadFile(path.resolve('renderer/dist/settings.html'),{hash:'drive'});await wait(visible('Check transfer'),'The populated Windows recovery panel did not render.');
  assert.equal(await evaluate('window.meetingRecorder.platform'),'win32');await click('Check transfer');await wait(visible('Finish downloaded update'),'A partial update must offer explicit finishing.');assert.equal(recoverCalls().length,1);
  await click('Finish downloaded update');await wait(visible('Save local copy and finish'),'The finishing confirmation did not render.');assert.equal(recoverCalls().length,1,'opening confirmation must not overwrite');await confirmationVisible('Save local copy and finish');await screenshot('finish-confirmation');
  await click('Cancel');await wait('!'+visible('Save local copy and finish'),'Cancellation must dismiss the confirmation.');assert.equal(recoverCalls().length,1,'cancellation must not finish');
  await click('Finish downloaded update');await wait(visible('Save local copy and finish'),'The second confirmation did not render.');mounted=false;window.webContents.send('drive:status',status());await wait(`${button('Save local copy and finish')}.disabled`,'Finishing must be disabled after disconnect.');assert.equal(recoverCalls().length,1,'disconnect must not finish an update');mounted=true;window.webContents.send('drive:status',status());await wait(`!${button('Save local copy and finish')}.disabled`,'Finishing must become available after reconnect.');await click('Save local copy and finish');await wait(visible('Reveal saved copies'),'Completed recovery must show its retained copies.');assert.equal(recoverCalls().length,2);assert.equal(recoverCalls()[1].args.finish,true);
  mounted=false;window.webContents.send('drive:status',status());await wait("document.body.innerText.includes('Not mounted')",'Disconnect status did not render.');await click('Reveal saved copies');await wait("document.body.innerText.includes('Saved copies are open in File Explorer')",'Saved copies must remain accessible while disconnected.');assert.equal(recoverCalls().at(-1).args.revealCopies,true);
  await click('Remove from list');await wait(visible('Keep files and remove entry'),'History removal requires confirmation.');const before= recoverCalls().length;await confirmationVisible('Keep files and remove entry');await screenshot('saved-copy-removal-confirmation');await click('Cancel');await wait('!'+visible('Keep files and remove entry'),'Removal cancellation did not dismiss.');assert.equal(recoverCalls().length,before,'cancelling must keep the history');
  await click('Remove from list');await wait(visible('Keep files and remove entry'),'Removal confirmation did not reopen.');await click('Keep files and remove entry');await wait("document.body.innerText.includes('The saved files remain in their folder on this PC')",'Removal must explain file retention.');await wait('!'+visible('Reveal saved copies'),'Removed history must leave the list.');assert.equal(recoverCalls().at(-1).args.forget,true);mounted=true;entries=[{id,type:'pinned',local:'remote/Changed-before-update.txt',started:Date.now()}];recoveryReason='pinned-source-changed-before-replacement';window.reload();await delay(150);await wait(visible('Check transfer'),'Changed-source recovery entry did not render.');const beforeCheck=recoverCalls().length;await click('Check transfer');await wait("Boolean(document.querySelector('[role=status]'))",'The changed source reason must be visible.');assert.equal(await evaluate(visible('Finish downloaded update')),false,'Changed sources before replacement must not offer unsupported finishing.');assert.equal(recoverCalls().length,beforeCheck+1);assert.equal(recoverCalls().at(-1).args.finish,false);assert.equal(errors.length,0,JSON.stringify(errors));
  entries=[{id,type:'folder-move',local:'Moved folder',started:Date.now()}];window.reload();await delay(150);await wait(visible('Check transfer'),'Folder move recovery did not render.');await click('Check transfer');await wait(visible('Finish recorded folder move'),'Missing folder copies must offer explicit finishing.');const beforeFolder=recoverCalls().length;
  await click('Finish recorded folder move');await wait(visible('Verify copies and finish move'),'Folder completion confirmation did not render.');await confirmationVisible('Verify copies and finish move');await screenshot('folder-move-confirmation');assert.equal(recoverCalls().length,beforeFolder,'opening folder confirmation must not write');await click('Cancel');await wait('!'+visible('Verify copies and finish move'),'Folder cancellation must dismiss confirmation.');assert.equal(recoverCalls().length,beforeFolder,'cancelling must retain the folder transaction');
  await click('Finish recorded folder move');await wait(visible('Verify copies and finish move'),'Folder confirmation did not reopen.');mounted=false;window.webContents.send('drive:status',status());await wait(`${button('Verify copies and finish move')}.disabled`,'Disconnected folder finishing must be disabled.');assert.equal(recoverCalls().length,beforeFolder);mounted=true;window.webContents.send('drive:status',status());await wait(`!${button('Verify copies and finish move')}.disabled`,'Folder finishing must be available after reconnect.');await click('Verify copies and finish move');await wait('!'+visible('Finish recorded folder move'),'Completed folder transaction must leave the list.');assert.equal(recoverCalls().length,beforeFolder+1);assert.equal(recoverCalls().at(-1).args.kind,'folder-move');assert.equal(recoverCalls().at(-1).args.finish,true);assert.equal(errors.length,0,JSON.stringify(errors));
  entries=[{id,type:'delete',local:'Held deletion.txt',started:Date.now()}];recoveryReason='delete-copy-missing';window.reload();await delay(150);await wait(visible('Check deletion'),'Held deletion recovery did not render.');await click('Check deletion');await wait("document.body.innerText.includes('Retry deleting it in File Explorer')",'The held deletion must explain a native retry.');assert.equal(recoverCalls().at(-1).args.finish,false);assert.equal(await evaluate(visible('Finish recorded folder move')),false);assert.equal(await evaluate(visible('Finish downloaded update')),false);await evaluate("document.querySelector('[role=status]')?.scrollIntoView({block:'center'})");await wait("(()=>{const r=document.querySelector('[role=status]')?.getBoundingClientRect();return r&&r.top>=0&&r.bottom<=window.innerHeight;})()",'The full deletion explanation must be visible.');await screenshot('held-deletion');
  mounted=false;window.webContents.send('drive:status',status());await wait(`${button('Check deletion')}.disabled && ${button('Show in File Explorer')}.disabled`,'Disconnected deletion actions must be disabled.');const beforeDeletion=recoverCalls().length;mounted=true;window.webContents.send('drive:status',status());await wait(`!${button('Show in File Explorer')}.disabled`,'Deletion reveal must return after reconnect.');await click('Show in File Explorer');await wait("document.body.innerText.includes('The held file is selected in File Explorer')",'Deletion reveal must explain native retry.');assert.equal(recoverCalls().length,beforeDeletion+1);assert.equal(recoverCalls().at(-1).args.revealFile,true);
  recoveryReason='delete-local-file-still-present';await click('Check deletion');await wait("document.body.innerText.includes('The cloud deletion and recoverable trash copy are verified')",'The verified outcome must still explain the pending local file.');assert.equal(recoverCalls().at(-1).args.finish,false);assert.equal(errors.length,0,JSON.stringify(errors));
  const result={productionRenderer:true,productionPreload:true,realMouseControls:true,confirmationVisibleAndFocused:true,controlledIpcFixture:true,finishRequiresConfirmation:true,cancelPreservesHold:true,disconnectDisablesFinishing:true,changedSourceDoesNotOfferFinishing:true,savedCopiesWhileDisconnected:true,historyRemovalRequiresConfirmation:true,deletionExplanationFullyVisible:true,deletionChecksReadOnly:true,deletionRetryUsesFileExplorer:true,deletionDisconnectDisablesActions:true,folderMoveRequiresConfirmation:true,folderCancellationPreservesHold:true,folderDisconnectDisablesFinishing:true,calls};await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{window.destroy();await fs.rm(profile,{recursive:true,force:true}).catch(()=>{});}
}
main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
