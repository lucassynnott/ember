const path=require('node:path');
const {spawn}=require('node:child_process');
const {DriveIpcClient,endpointFor,daemonToken}=require('./windows-drive-ipc');

class WindowsDriveClient{
  constructor({app,safeStorage,onStatus=()=>{},onEvent=()=>{},launch=spawn}){
    Object.assign(this,{app,safeStorage,onStatus,onEvent,launch});this.status={supported:process.platform==='win32',configured:false,mounted:false};this.mountPath=null;this.client=null;this.ready=null;this.generation=0;
  }
  #update(snapshot){if(!snapshot?.status||typeof snapshot.status!=='object')throw new Error('Invalid Drive daemon status.');this.status={...snapshot.status,daemonConnected:true};this.mountPath=snapshot.mountPath||null;this.onStatus(this.status);}
  #assertCurrent(generation,client){if(generation!==this.generation){client?.close();throw new Error('Drive connection attempt was stopped.');}}
  start(){if(!this.ready){const pending=this.#start(++this.generation);this.ready=pending;pending.catch(()=>{if(this.ready===pending)this.ready=null;});}return this.ready;}
  async #start(generation){
    const profile=this.app.getPath('userData'),token=await daemonToken(path.join(profile,'windows-drive'),this.safeStorage);
    this.#assertCurrent(generation);
    const client=new DriveIpcClient({endpoint:endpointFor(profile),token});this.client=client;
    client.on('event',(name,data)=>{if(this.client!==client||generation!==this.generation)return;if(name==='status')this.#update(data);else this.onEvent(name,data);});
    client.on('disconnect',()=>{if(this.client!==client||generation!==this.generation)return;this.ready=null;this.mountPath=null;this.status={...this.status,mounted:false,daemonConnected:false};this.onStatus(this.status);});
    try{const snapshot=await client.connect();this.#assertCurrent(generation,client);this.#update(snapshot);return;}
    catch(error){if(!['ENOENT','ECONNREFUSED'].includes(error.code))throw error;}
    const sessionData=this.app.getPath('sessionData');
    if(process.platform==='win32')await require('./windows-drive-profile').waitForEncryptionKey(sessionData);
    this.#assertCurrent(generation,client);
    const args=[...(this.app.isPackaged?[]:[this.app.getAppPath()]),'--ember-drive-daemon','--ember-drive-profile',profile,'--ember-drive-session-data',sessionData];
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const child=this.launch(process.execPath,args,{detached:true,stdio:'ignore',windowsHide:true,env});child.unref();
    let launchError,exited=false,exitCode;child.once('error',error=>launchError=error);child.once('exit',code=>{exited=true;exitCode=code;});
    const deadline=Date.now()+15000;
    while(Date.now()<deadline){
      this.#assertCurrent(generation,client);
      if(launchError)throw launchError;
      if(exited)throw new Error(`The Windows Drive background process exited before connecting (code ${exitCode}).`);
      try{const snapshot=await client.connect();this.#assertCurrent(generation,client);this.#update(snapshot);return;}
      catch(error){if(!['ENOENT','ECONNREFUSED'].includes(error.code))throw error;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error('The Windows Drive background process did not start.');
  }
  async request(command,args={},timeout){await this.start();return this.client.request('request',{command,args},timeout);}
  async backUp(file,relative){await this.start();return this.client.request('backup',{file,relative},300000);}
  setUpWithCloudflare(cloudflare,onStep,options={}){return require('./windows-drive-cloudflare').setUpCloudflare({backend:this,cloudflare,onStep,...options});}
  // Closing Ember releases only its pipe connection. The independent provider
  // retains native callbacks, credentials and the file watcher.
  stop(){this.generation++;const client=this.client;this.client=null;this.ready=null;this.mountPath=null;this.status={...this.status,mounted:false,daemonConnected:false};client?.close();this.onStatus(this.status);}
}
module.exports={WindowsDriveClient};
