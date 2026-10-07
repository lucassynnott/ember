const {EventEmitter}=require('node:events');
const {spawn}=require('node:child_process');
const crypto=require('node:crypto');
const {nativeHelperPath}=require('./platform');

class WindowsCloudFiles extends EventEmitter {
  constructor({app,store,spawnImpl=spawn,helper=null,timeoutMs=35000}) {
    super();this.store=store;this.pending=new Map();this.fetches=new Map();this.buffer='';this.closed=false;this.timeoutMs=timeoutMs;
    this.child=spawnImpl(helper||nativeHelperPath(app,'hotkey'),['cloud-files'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.ready=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});
    this.ready.catch(()=>{}); // Startup errors are surfaced to the first command.
    this.child.stdin.on('error',error=>this.#fail(error));
    this.readyTimer=setTimeout(()=>this.#fail(new Error('Windows Drive helper did not start.')),timeoutMs);this.readyTimer.unref?.();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',chunk=>{
      this.buffer+=chunk;
      if(this.buffer.length>24*1024*1024)return this.#fail(new Error('Windows Drive helper exceeded its message limit.'));
      let index;
      while((index=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);if(!line.trim())continue;
        try{this.#message(JSON.parse(line));}catch{this.#fail(new Error('Invalid Windows Drive helper response.'));break;}
      }
    });
    // Drain diagnostics without exposing object names or credentials to logs.
    this.child.stderr.on('data',()=>{});
    this.child.on('error',error=>this.#fail(error));
    this.child.on('exit',()=>this.#fail(new Error('Windows Drive helper stopped.')));
  }
  #write(value){if(this.closed||!this.child.stdin.writable)throw new Error('Windows Drive helper is unavailable.');this.child.stdin.write(JSON.stringify(value)+'\n');}
  #message(message){
    if(message.event==='ready'){
      if(message.protocol!==1)throw new Error('Unsupported Drive protocol.');clearTimeout(this.readyTimer);this.readyResolve();return;
    }
    if(message.event==='cancelFetchData'){this.fetches.get(message.id)?.abort();return;}
    if(message.event==='fetchData'){void this.#fetch(message);return;}
    if(message.event==='hydrationError'){this.emit('hydrationError',new Error('Windows could not hydrate a cloud file.'));return;}
    const pending=this.pending.get(message.id);if(!pending)return;
    if(message.event==='backupProgress'){if(pending.command==='copyBackup'){pending.renew();this.emit('backupProgress',{bytes:message.bytes,total:message.total});}return;}
    this.pending.delete(message.id);clearTimeout(pending.timer);
    if(message.ok===true)pending.resolve(message);else pending.reject(new Error(message.error||'Windows Drive operation failed.'));
  }
  async #fetch(message){
    let controller;
    try {
      if(typeof message.id!=='string'||!message.id.startsWith('fetch-')||this.fetches.has(message.id)||this.fetches.size>=16)throw new Error('Invalid hydration request.');
      if(typeof message.identity!=='string'||Buffer.byteLength(message.identity)>4096)throw new Error('Invalid object identity.');
      const identity=JSON.parse(message.identity);
      if(typeof identity.key!=='string'||!identity.key||(!identity.fileID&&!identity.etag))throw new Error('Missing object revision.');
      if(identity.fileID!=null&&typeof identity.fileID!=='string'||identity.etag!=null&&typeof identity.etag!=='string')throw new Error('Invalid object revision.');
      if(!Number.isSafeInteger(message.offset)||message.offset<0||!Number.isSafeInteger(message.length)||message.length<1||message.length>8*1024*1024)throw new Error('Invalid hydration range.');
      controller=new AbortController();this.fetches.set(message.id,controller);
      for(const pending of this.pending.values())if(pending.command==='hydrate')pending.renew();
      const timer=setTimeout(()=>controller.abort(),25000);timer.unref?.();
      let data;
      try{data=await this.store.read(identity.key,message.offset,message.length,identity.fileID||null,controller.signal,identity.etag||null);}finally{clearTimeout(timer);}
      if(controller.signal.aborted)throw new Error('Cloud file read was cancelled.');
      if(data.length!==message.length)throw new Error('Cloud file changed during hydration.');
      for(const pending of this.pending.values())if(pending.command==='hydrate')pending.renew();
      this.emit('hydrationProgress',{key:identity.key,offset:message.offset,bytes:data.length});
      this.#write({id:message.id,ok:true,data:data.toString('base64')});
    }catch {
      try{this.#write({id:message.id,ok:false,error:'Cloud file could not be read.'});}catch{}
    }finally{if(controller&&this.fetches.get(message.id)===controller)this.fetches.delete(message.id);}
  }
  async command(command,args={}){
    await this.ready;if(this.closed)throw new Error('Windows Drive helper is unavailable.');
    const id=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const entry={resolve,reject,command,timer:null,renew:()=>{
        clearTimeout(entry.timer);entry.timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Windows Drive operation timed out; check its state before retrying.'));},this.timeoutMs);entry.timer.unref?.();
      }};
      this.pending.set(id,entry);entry.renew();
      try{this.#write({...args,id,command});}catch(error){clearTimeout(entry.timer);this.pending.delete(id);reject(error);}
    });
  }
  register(root,identity){return this.command('register',{root,identity});}
  async lockUpload(path){return (await this.command('lockUpload',{path})).upload;}
  unlockUpload(token){return this.command('unlockUpload',{token});}
  ackUpload(token,object){return this.command('ackUpload',{token,identity:JSON.stringify({key:object.name,fileID:object.fileID||null,etag:object.etag||null})});}
  async copyBackup(path,source,{backupId,expectedIdentity=null,hash,size,signal}){
    if(signal?.aborted)throw new Error('Backup cancelled.');
    const cancel=()=>{void this.command('cancelBackup',{backupId}).catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
    try{return (await this.command('copyBackup',{path,source,backupId,expectedIdentity:expectedIdentity?JSON.stringify({key:expectedIdentity.key,fileID:expectedIdentity.fileID||null,etag:expectedIdentity.etag||null}):null,hash,size})).backup;}finally{signal?.removeEventListener('abort',cancel);}
  }
  ackMove(token,object,expectedIdentity){return this.command('ackMove',{token,expectedIdentity,identity:JSON.stringify({key:object.name,fileID:object.fileID||null,etag:object.etag||null})});}
  refresh(path,object,expectedIdentity){return this.command('refresh',{path,size:object.size,modified:object.modified,expectedIdentity,identity:JSON.stringify({key:object.name,fileID:object.fileID||null,etag:object.etag||null})});}
  async pin(path){await this.command('pin',{path});await this.command('hydrate',{path});return this.inspect(path);}
  unpin(path){return this.command('unpin',{path});}
  dehydrate(path){return this.command('dehydrate',{path});}
  async inspect(path){return (await this.command('inspect',{path})).placeholder;}
  async explorerStatus(){return (await this.command('explorerStatus')).explorer;}
  async prepareExplorer(folder,identity){return (await this.command('explorerPrepare',{folder,identity})).explorer;}
  async explorerRegister(){return (await this.command('explorerRegister')).explorer;}
  explorerUnregister(){return this.command('explorerUnregister');}
  unregister(){return this.command('unregister');}
  create(name,object,parent=''){return this.command('create',{name,parent,kind:object.kind||'file',size:object.size,modified:object.modified,identity:JSON.stringify({key:object.name,fileID:object.fileID||null,etag:object.etag||null})});}
  #fail(error){
    if(this.closed)return;this.closed=true;clearTimeout(this.readyTimer);this.readyReject(error);
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();
    for(const controller of this.fetches.values())controller.abort();this.fetches.clear();
    this.child.kill();this.emit('stopped',error);
  }
  async closeAndWait(timeout=10000){
    if(!this.child.pid||this.child.exitCode!=null||this.child.signalCode!=null){this.close();return;}
    await new Promise((resolve,reject)=>{
      const finish=()=>{clearTimeout(timer);this.child.removeListener('exit',finish);this.child.removeListener('error',failed);resolve();};
      const failed=error=>{clearTimeout(timer);this.child.removeListener('exit',finish);this.child.removeListener('error',failed);reject(error);};
      const timer=setTimeout(()=>failed(new Error('The Windows Drive native helper is still running.')),timeout);
      this.child.once('exit',finish);this.child.once('error',failed);this.close();
    });
  }
  close(){this.#fail(new Error('Windows Drive connection closed.'));}
}
module.exports={WindowsCloudFiles};
