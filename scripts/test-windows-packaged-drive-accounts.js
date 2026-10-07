const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');const {promisify}=require('node:util');const execFile=promisify(require('node:child_process').execFile);const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function verify({client,directory,executable,evidence}){
 const firstBytes=crypto.randomBytes(1024*1024+123),secondBytes=crypto.randomBytes(1024*1024+321),fixture=require('./windows-drive-cloud-fixture');
 const first=await fixture.cloudFixture({'same.txt':firstBytes}),second=await fixture.cloudFixture({'same.txt':secondBytes});
 const evaluate=async expression=>{const result=await client.request('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));return result.result.value;};
 const request=(cmd,args={})=>evaluate(`window.meetingRecorder.driveRequest(${JSON.stringify(cmd)},${JSON.stringify(args)})`);
 const status=()=>evaluate('window.meetingRecorder.driveStatus()');
 const wait=async predicate=>{const deadline=Date.now()+30000;for(;;){const current=await status();if(await predicate(current))return current;assert(Date.now()<deadline,'Packaged account status did not reach its expected state');await delay(100);}};
 const roots=[];let proof;
 try{
  await evaluate('window.meetingRecorder.openSettings("drive")');
  await request('save',{config:first.config});const one=await wait(s=>s.mounted&&s.accounts?.length===1),firstRoot=one.path;roots.push(firstRoot);assert.equal(one.accountID,'legacy');
  await request('pin',{keys:['same.txt']});assert.deepEqual(await fs.readFile(path.join(firstRoot,'same.txt')),firstBytes);
  const firstState=path.join(directory,'user-data','windows-drive','state.dpapi'),stateBytes=await fs.readFile(firstState);
  await request('save',{config:second.config});const two=await wait(s=>s.mounted&&s.accounts?.length===2&&s.accountID!=='legacy'),secondRoot=two.path,secondID=two.accountID;roots.push(secondRoot);assert.notEqual(secondRoot,firstRoot);assert.deepEqual(await fs.readFile(firstState),stateBytes);
  await request('pin',{keys:['same.txt']});assert.deepEqual(await fs.readFile(path.join(secondRoot,'same.txt')),secondBytes);assert.deepEqual(await fs.readFile(path.join(firstRoot,'same.txt')),firstBytes);
  const writes=first.writes+second.writes,reads=first.requests.filter(r=>r.range).length+second.requests.filter(r=>r.range).length;
  const select=async(root,id)=>{
   const deadline=Date.now()+15000;let point;
   for(;;){point=await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.title===${JSON.stringify(root)}&&!b.disabled);if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);if(point)break;assert(Date.now()<deadline,'The packaged saved-account button did not become available');await delay(100);}
   await client.request('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await client.request('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
   await wait(s=>s.mounted&&s.accountID===id&&s.path===root);
   for(;;){if(await evaluate(`document.body.innerText.includes(${JSON.stringify(root)})&&[...document.querySelectorAll('button')].some(b=>b.title===${JSON.stringify(root)}&&b.disabled&&b.textContent.includes('Selected'))`))break;assert(Date.now()<deadline,'The packaged UI did not show the selected root');await delay(100);}
  };
  await select(firstRoot,'legacy');assert.deepEqual(await fs.readFile(path.join(firstRoot,'same.txt')),firstBytes);assert.equal((await request('settings')).endpoint,first.config.endpoint);
  await select(secondRoot,secondID);assert.deepEqual(await fs.readFile(path.join(secondRoot,'same.txt')),secondBytes);assert.equal((await request('settings')).endpoint,second.config.endpoint);
  assert.equal(first.writes+second.writes,writes,'Selecting an account must not write to either cloud');assert.equal(first.requests.filter(r=>r.range).length+second.requests.filter(r=>r.range).length,reads,'Selecting pinned accounts must not fetch their bytes again');
  const screenshot=await client.request('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(evidence,'packaged-account-selection.png'),Buffer.from(screenshot.data,'base64'));
  await select(firstRoot,'legacy');await request('forget');await wait(s=>!s.configured&&!s.mounted);assert.deepEqual(await fs.readFile(path.join(firstRoot,'same.txt')),firstBytes);await select(secondRoot,secondID);assert.deepEqual(await fs.readFile(path.join(secondRoot,'same.txt')),secondBytes);await request('forget');await wait(s=>!s.configured&&!s.mounted);
  proof={packagedAccountSwitchUsesMouse:true,packagedAccountRootsIsolated:true,packagedAccountPinnedBytesPreserved:true,packagedAccountSwitchNoCloudWrites:true,packagedAccountSwitchNoHydration:true,packagedAccountForgetIsolation:true};
 }finally{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  try{const current=await status().catch(()=>null);for(const account of current?.accounts||[])if(!roots.includes(account.path))roots.push(account.path);if(roots.length)await execFile(require('electron'),[path.resolve('scripts/test-windows-packaged-drive-cleanup.js'),path.join(directory,'user-data'),path.join(path.dirname(executable),'resources','bin','meeting-notes-hotkey.exe'),JSON.stringify(roots)],{env,timeout:60000,windowsHide:true});}
  finally{await first.close();await second.close();}
 }
 await fs.writeFile(path.join(evidence,'packaged-account-result.json'),JSON.stringify(proof,null,2));return proof;
}
module.exports={verify};
