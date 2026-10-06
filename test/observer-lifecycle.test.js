const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {ZoomAccessibilityObserver}=require('../src/zoom-accessibility');
test('A clean observer exit clears live call and speaker evidence', {timeout:5000}, async()=>{
  let resolveExit;
  const failed=new Promise(resolve=>{resolveExit=resolve;});
  const apps=[];
  const now=Date.now();
  const messages=[{type:'audio-apps',apps:[{bundleId:'windows:zoom',input:true}]},{observedAt:now-1000,accessibility:'granted',meetingOpen:true,participants:['Alice'],activeSpeakers:['Alice']}];
  const observer=new ZoomAccessibilityObserver({app:{isPackaged:false,getAppPath:()=>process.cwd()},onAudioApps:value=>apps.push(value),onState:state=>{if(state.error)resolveExit(state);},spawnProcess:()=>spawn(process.execPath,['-e',`for(const message of ${JSON.stringify(messages)})console.log(JSON.stringify(message));setTimeout(()=>process.exit(0),100);`],{stdio:['ignore','pipe','pipe']})});
  try {
    observer.start();
    const state=await failed;
    assert.match(state.error,/exited with 0/);
    assert.equal(state.meetingOpen,false);assert.deepEqual(state.participants,[]);
    assert.deepEqual(apps.at(-1),[]);
    assert.equal(observer.resolveSpeaker({startedAt:now,endedAt:now+1000}),null);
    assert.equal(observer.child,null);
  } finally {await observer.stop();}
});

test('Stopping the observer clears current attribution and terminates its process', {timeout:5000}, async()=>{
  let readyResolve;const ready=new Promise(resolve=>{readyResolve=resolve;});
  const now=Date.now();let child;
  const observer=new ZoomAccessibilityObserver({app:{isPackaged:false,getAppPath:()=>process.cwd()},onState:state=>{if(state.meetingOpen)readyResolve();},spawnProcess:()=>{
    child=spawn(process.execPath,['-e',`console.log(JSON.stringify({observedAt:${now}-1000,accessibility:'granted',meetingOpen:true,participants:['Alice'],activeSpeakers:['Alice']}));setInterval(()=>{},1000);`],{stdio:['ignore','pipe','pipe']});return child;
  }});
  try {observer.start();await ready;await observer.stop();assert.equal(observer.child,null);assert.equal(observer.publicState().meetingOpen,false);assert.equal(observer.resolveSpeaker({startedAt:now,endedAt:now+1000}),null);assert.ok(child.exitCode!==null||child.signalCode!==null);}
  finally {await observer.stop();}
});
