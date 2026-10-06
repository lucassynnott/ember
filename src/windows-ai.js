const path = require('node:path');
const WINDOWS_AI_CATALOG = [
  ['gemma-4-e2b-text','Gemma 4 E2B','2.8 GB','ggml-org/gemma-4-E2B-it-GGUF','b4243c156154b6dca9324415f8c7ccc098b4aed1','gemma-4-E2B-it-Q4_0.gguf',2841481184,'8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52'],
  ['gemma-4-e4b','Gemma 4 E4B','4.6 GB','ggml-org/gemma-4-E4B-it-GGUF','b8093469224f83f5c38f691eb906c380e9e63114','gemma-4-E4B-it-Q4_0.gguf',4590807392,'a555b900214b477d8880e7832e0b8925e139b0159640036b09fe472b6f2097f2'],
].map(([id,label,sizeLabel,repo,revision,name,size,sha256])=>({
  id,type:'llm',label,source:'Google · GGUF / llama.cpp',sizeLabel,
  detail:'Runs privately on your Windows PC. CPU speed depends on your processor; the larger model needs more memory.',
  install:{kind:'gguf-llm',repo,revision,target:name,single:true,files:[{name,size,sha256}]},
}));
function windowsAiRuntimePath(app, resourcesPath=process.resourcesPath) {
  return app.isPackaged ? path.join(resourcesPath,'bin','llama','llama-server.exe') : path.join(app.getAppPath(),'native','windows','bin','llama','llama-server.exe');
}
function windowsAiServer(command,{model,port,token}) {
  return {command,args:['--model',model,'--alias','ember-local','--host','127.0.0.1','--port',String(port),'--ctx-size','32768','--parallel','1','--n-gpu-layers','0','--jinja','--chat-template-kwargs',JSON.stringify({enable_thinking:false}),'--api-key',token],model:'ember-local',headers:{authorization:`Bearer ${token}`}};
}
module.exports={WINDOWS_AI_CATALOG,windowsAiRuntimePath,windowsAiServer};
