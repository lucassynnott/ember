const path=require('node:path');
const {spawn}=require('node:child_process');
const {DriveIpcClient,endpointFor,daemonToken}=require('./windows-drive-ipc');

class WindowsDriveClient{
  constructor({app,safeStorage,onStatus=()=>{},onEvent=()=>{},launch=spawn}){
    Object.assign(this,{app,safeStorage,onStatus,onEvent,launch});this.status={supported:process.platform==='win32',configured:false,mounted:false};this.mountPath=null;this.client=null;this.ready=null;
  }
  #update(snapshot){if(!snapshot?.status||typeof snapshot.status!=='object')throw new Error('Invalid Drive daemon status.');this.status={...snapshot.status};this.mountPath=snapshot.mountPath||null;this.onStatus(this.status);}
  start(){if(!this.ready){const pending=this.#start();this.ready=pending;pending.catch(()=>{if(this.ready===pending)this.ready=null;});}return this.ready;}
  async #start(){
    const profile=this.app.getPath('userData'),token=await daemonToken(path.join(profile,'windows-drive'),this.safeStorage);
    const client=new DriveIpcClient({endpoint:endpointFor(profile),token});this.client=client;
    client.on('event',(name,data)=>{if(name==='status')this.#update(data);else this.onEvent(name,data);});
    client.on('disconnect',()=>{this.ready=null;this.mountPath=null;this.status={...this.status,mounted:false,daemonConnected:false};this.onStatus(this.status);});
    try{this.#update(await client.connect());return;}
    catch(error){if(!['ENOENT','ECONNREFUSED'].includes(error.code))throw error;}
    const args=[...(this.app.isPackaged?[]:[this.app.getAppPath()]),'--ember-drive-daemon','--ember-drive-profile',profile];
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const child=this.launch(process.execPath,args,{detached:true,stdio:'ignore',windowsHide:true,env});child.unref();
    let launchError;child.once('error',error=>launchError=error);
    const deadline=Date.now()+15000;
    while(Date.now()<deadline){
      if(launchError)throw launchError;
      try{this.#update(await client.connect());return;}
      catch(error){if(!['ENOENT','ECONNREFUSED'].includes(error.code))throw error;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error('The Windows Drive background process did not start.');
  }
  async request(command,args={},timeout){await this.start();return this.client.request('request',{command,args},timeout);}
  async backUp(file,relative){await this.start();return this.client.request('backup',{file,relative},300000);}
  // Closing Ember releases only its pipe connection. The independent provider
  // retains native callbacks, credentials and the file watcher.
  stop(){this.client?.close();this.ready=null;}
}
module.exports={WindowsDriveClient};
