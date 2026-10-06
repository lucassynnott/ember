const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {LocalAI} = require('../src/local-ai');
const {WINDOWS_AI_CATALOG,windowsAiServer} = require('../src/windows-ai');
const {downloadVerified} = require('../src/model-manager');
async function main() {
  assert.equal(process.platform,'win32','inference acceptance requires Windows');
  const entry=WINDOWS_AI_CATALOG[0], file=entry.install.files[0];
  const directory=path.resolve('.windows-tools/ai-acceptance-model');
  await fs.mkdir(directory,{recursive:true});
  const model=path.join(directory,file.name);
  let last=0;
  await downloadVerified({url:`https://huggingface.co/${entry.install.repo}/resolve/${entry.install.revision}/${file.name}`,destination:model,expectedSize:file.size,sha256:file.sha256,onBytes:bytes=>{if(bytes-last>100e6){last=bytes;console.log(`Model download: ${Math.round(bytes/1e6)} MB`);}}});
  const ai=new LocalAI({getServer:options=>windowsAiServer(path.resolve('native/windows/bin/llama/llama-server.exe'),options),getModelPath:async()=>model});
  try {
    const endpoint=await ai.endpoint();
    const request=(token,body)=>fetch(endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(180000)});
    assert.equal((await request('wrong',{})).status,401);
    assert.equal(ai.running,false);
    const response=await request(ai.token,{messages:[{role:'user',content:'Reply with exactly the word Ember.'}],max_tokens:32,temperature:0});
    const data=await response.json();
    assert.equal(response.status,200,JSON.stringify(data));
    const inner = await fetch(`http://127.0.0.1:${ai.childPort}/v1/models`,{signal:AbortSignal.timeout(10000)});
    assert.equal(inner.status,401,'inner model server rejects unauthenticated access');
    const text=data.choices?.[0]?.message?.content;
    assert.ok(typeof text==='string' && /Ember/i.test(text),`Unexpected generated answer: ${JSON.stringify(data)}`);
    const stream=await request(ai.token,{messages:[{role:'user',content:'Reply with exactly the word Windows.'}],max_tokens:32,temperature:0,stream:true});
    assert.equal(stream.status,200);
    const events=await stream.text();
    assert.ok(events.includes('[DONE]'),'stream terminates');
    assert.ok(events.split('\n').filter(line=>line.startsWith('data: ') && !line.includes('[DONE]')).some(line=>JSON.parse(line.slice(6)).choices?.[0]?.delta?.content),'stream generates content');
    console.log(JSON.stringify({windowsLocalAi:'passed',model:entry.id,checksumVerified:true,chatGenerated:true,streamGenerated:true,unauthorizedRejected:true}));
  } finally {ai.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
