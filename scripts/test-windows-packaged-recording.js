// Exercises the real packaged preload, recorder controls, library and media protocol.
const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {promisify}=require('node:util');const execFile=promisify(require('node:child_process').execFile);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function verify({client:welcomeClient,connect,port,directory,executable,evidence}){
 let client=welcomeClient;
 const stages=[];const checkpoint=async(stage,details={})=>{stages.push({stage,...details});await fs.writeFile(path.join(evidence,'recording-stages.json'),JSON.stringify(stages,null,2));};
 const evaluate=async(peer,expression,awaitPromise=true)=>{const result=await peer.request('Runtime.evaluate',{expression,awaitPromise,returnByValue:true});assert.ok(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));return result.result.value;};
 const target=async suffix=>{const deadline=Date.now()+30000;for(;;){const pages=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)}).then(r=>r.json());const page=pages.find(p=>p.type==='page'&&p.url.includes(suffix));if(page)return connect(page.webSocketDebuggerUrl);assert.ok(Date.now()<deadline,`Missing packaged recorder ${suffix}`);await delay(100);}};
 let setup,controls;
 try{
  // Complete the real first-run flow, then use the main window's media policy.
  await evaluate(welcomeClient,'setTimeout(()=>void window.meetingRecorder.finishOnboarding(),100)',false);
  client=await target('index.html');await checkpoint('main-window-connected');
  const previous=await evaluate(client,'window.meetingRecorder.recordingsList()');assert.deepEqual(previous,[],'the acceptance profile must be empty');
  await evaluate(client,'window.meetingRecorder.saveSettings({recordCamera:false,recordHideCursor:false,recordAutoFinish:false,recordCountdownSeconds:0})');
  await evaluate(client,'window.meetingRecorder.newScreenRecording()');setup=await target('record.html#setup');
  const sources=await evaluate(setup,'window.record.sources()');assert.ok(sources.displays.length>0);const display=sources.displays.find(d=>d.primary)||sources.displays[0];
  // start closes its own setup window, so submit without waiting on that renderer.
  await evaluate(setup,`setTimeout(()=>void window.record.start(${JSON.stringify({mode:'screen',displayId:display.id,microphone:'none',systemAudio:false,countdown:0})}),100)`,false);
  setup.close();setup=null;controls=await target('record.html#controls');
  const status=async()=>evaluate(controls,'window.record.status()');const deadline=Date.now()+30000;
  while((await status()).state!=='recording'){assert.ok(Date.now()<deadline,'packaged desktop recording did not start');await delay(100);}
  await delay(1300);await evaluate(controls,'window.record.control("pause")');
  while(!(await status()).paused){assert.ok(Date.now()<deadline,'packaged pause failed');await delay(100);}
  await delay(300);await evaluate(controls,'window.record.control("resume")');
  while((await status()).paused){assert.ok(Date.now()<deadline,'packaged resume failed');await delay(100);}
  await delay(1100);await evaluate(controls,'setTimeout(()=>window.record.control("stop"),100)',false);controls.close();controls=null;
  let saved;const savedDeadline=Date.now()+45000;
  while(!saved){const recordings=await evaluate(client,'window.meetingRecorder.recordingsList()');saved=recordings.find(item=>item.duration>=1);if(!saved){assert.ok(Date.now()<savedDeadline,'recording did not reach the packaged library');await delay(150);}}
  const detail=await evaluate(client,`window.meetingRecorder.recordingGet(${JSON.stringify(saved.id)})`);assert.equal(detail.source,'The whole screen');
  const file=path.join(directory,'user-data','recordings',saved.id,'recording.mp4');assert.ok((await fs.stat(file)).size>1000);
  const bin=path.join(path.dirname(executable),'resources','bin');const probe=JSON.parse((await execFile(path.join(bin,'ffprobe.exe'),['-v','error','-show_streams','-show_format','-of','json',file],{timeout:30000})).stdout);
  const video=probe.streams.find(stream=>stream.codec_type==='video');assert.ok(video&&video.width>0&&video.height>0);assert.ok(Number(probe.format.duration)>=1);
  await execFile(path.join(bin,'ffmpeg.exe'),['-v','error','-i',file,'-f','null','-'],{timeout:30000});
  await checkpoint('desktop-capture-decoded',{duration:Number(probe.format.duration),width:video.width,height:video.height});
  const editorDeadline=Date.now()+30000;let editorReady=false;
  while(!editorReady){editorReady=await evaluate(client,`Boolean(document.querySelector('button[aria-label="Play"]')&&[...document.querySelectorAll('video')].some(video=>video.src.includes('/${saved.id}/video')&&video.readyState>=2))`);if(!editorReady){assert.ok(Date.now()<editorDeadline,'the packaged editor did not load its recorded video');await delay(100);}}
  assert.equal(await evaluate(client,`document.querySelector('button[aria-label="Undo"]').title`),'Undo (Ctrl+Z)','the Windows editor must show its actual shortcut keys');
  const click=async expression=>{const point=await evaluate(client,`(()=>{const button=${expression};if(!button||button.disabled)throw new Error('The editor control is unavailable');const rect=button.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()`);await client.request('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await client.request('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});};
  const editorTime=()=>evaluate(client,`[...document.querySelectorAll('video')].find(video=>video.src.includes('/${saved.id}/video')).currentTime`);
  const beforePlay=await editorTime();await click(`document.querySelector('button[aria-label="Play"]')`);await delay(450);const afterPlay=await editorTime();assert.ok(afterPlay>beforePlay,'the real editor Play control must advance the recorded video');
  await click(`document.querySelector('button[aria-label="Pause"]')`);
  assert.ok(await evaluate(client,`[...document.querySelectorAll('canvas')].some(canvas=>{const r=canvas.getBoundingClientRect();return canvas.width>0&&canvas.height>0&&r.width>0&&r.height>0;})()`),'the real editor must render a visible preview canvas');
  const editorScreenshot=await client.request('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(evidence,'editor.png'),Buffer.from(editorScreenshot.data,'base64'));
  await checkpoint('editor-preview-controls',{beforePlay,afterPlay});
  await click(`[...document.querySelectorAll('header button')].find(button=>button.textContent.trim()==='Done')`);
  await delay(400);
  const playback=await evaluate(client,`(async()=>{const video=document.createElement('video');video.muted=true;video.src='ember-media://recording/${saved.id}/video';document.body.append(video);try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Recorded video metadata timed out')),10000);video.onloadedmetadata=()=>{clearTimeout(timer);resolve();};video.onerror=()=>{clearTimeout(timer);reject(new Error('Recorded media protocol failed'));};});await video.play();await new Promise(resolve=>setTimeout(resolve,400));return {duration:video.duration,width:video.videoWidth,height:video.videoHeight,time:video.currentTime};}finally{video.pause();video.remove();}})()`);
  assert.ok(playback.time>0&&playback.duration>=1);assert.equal(playback.width,video.width);assert.equal(playback.height,video.height);
  await checkpoint('recorded-media-playback',{time:playback.time});
  const ts=require('../renderer/node_modules/typescript');const bundle=ts.transpileModule(await fs.readFile(path.resolve('renderer/src/editor/model.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const model={exports:{}};new Function('module','exports',bundle)(model,model.exports);const project=model.exports.newProject(saved.duration,null);project.clips[0].speed=1.25;
  assert.equal(await evaluate(client,`window.meetingRecorder.saveRecordingEdit(${JSON.stringify(saved.id)},${JSON.stringify(project)})`),true);
  const loaded=await evaluate(client,`window.meetingRecorder.loadRecordingEdit(${JSON.stringify(saved.id)})`);assert.deepEqual(loaded.project,project);assert.deepEqual(JSON.parse(await fs.readFile(path.join(path.dirname(file),'edit.json'),'utf8')),project);
  await checkpoint('editor-project-persisted');
  const originalHash=require('node:crypto').createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const end=Math.min(Number(probe.format.duration),saved.duration),outputDuration=end/1.25;
  const spec={width:320,height:180,fps:30,clips:[[0,end,1.25,0]],content:[0,0,320,180],view:[[0,0,0,video.width,video.height],[outputDuration,0,0,video.width,video.height]],audio:{volume:1},sprites:[]};
  // The share-preparation flag only renders edited.mp4 locally in this handler;
  // upload/link creation are separate commands and are never invoked here.
  assert.equal(await evaluate(client,`window.meetingRecorder.exportRecordingEdit(${JSON.stringify(saved.id)},${JSON.stringify(spec)},{share:true})`),true);
  const exportDeadline=Date.now()+60000;let exported;
  while(!exported){const current=await evaluate(client,`window.meetingRecorder.recordingGet(${JSON.stringify(saved.id)})`);exported=current?.edited;if(!exported){assert.ok(Date.now()<exportDeadline,'the packaged edited export did not finish');await delay(200);}}
  const edited=path.join(path.dirname(file),'edited.mp4');const editedProbe=JSON.parse((await execFile(path.join(bin,'ffprobe.exe'),['-v','error','-show_streams','-show_format','-of','json',edited],{timeout:30000})).stdout);
  const editedVideo=editedProbe.streams.find(stream=>stream.codec_type==='video');assert.equal(editedVideo.width,320);assert.equal(editedVideo.height,180);assert.ok(Math.abs(Number(editedProbe.format.duration)-outputDuration)<0.15,'edited export must apply clip speed');
  await execFile(path.join(bin,'ffmpeg.exe'),['-v','error','-i',edited,'-f','null','-'],{timeout:30000});assert.equal(require('node:crypto').createHash('sha256').update(await fs.readFile(file)).digest('hex'),originalHash,'editing/export must preserve original video bytes');
  await checkpoint('edited-export-decoded',{duration:Number(editedProbe.format.duration)});
  const proof={onboardingCompleted:true,packagedDesktopCapture:true,packagedPauseResume:true,savedLibraryRecording:true,fullVideoDecode:true,mediaProtocolPlayback:true,editorPreviewControls:true,editorProjectPersistence:true,packagedEditedExport:true,originalVideoPreserved:true,editedDuration:Number(editedProbe.format.duration),duration:Number(probe.format.duration),width:video.width,height:video.height};await fs.writeFile(path.join(evidence,'recording-result.json'),JSON.stringify(proof,null,2));return proof;
 }finally{setup?.close();controls?.close();if(client!==welcomeClient)client.close();}
}
module.exports={verify};
