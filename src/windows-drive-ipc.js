const net=require('node:net');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {EventEmitter}=require('node:events');

const MAX_FRAME=256*1024,MAX_PENDING=8;
function endpointFor(profile,platform=process.platform){
  const identity=crypto.createHash('sha256').update(path.resolve(profile).toLowerCase()).digest('hex').slice(0,32);
  return platform==='win32'?`\\\\.\\pipe\\ember-drive-${identity}`:path.join(profile,'drive.sock');
}
async function daemonToken(directory,safeStorage){
  if(!safeStorage?.isEncryptionAvailable())throw new Error('Windows credential encryption is unavailable.');
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,'daemon.dpapi');
  async function read(){
    const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw new Error('Invalid Drive daemon identity.');
    const token=safeStorage.decryptString(await fs.readFile(file));
    if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid Drive daemon identity.');return token;
  }
  try{return await read();}catch(error){if(error.code!=='ENOENT')throw error;}
  const token=crypto.randomBytes(32).toString('hex'),temporary=file+'.'+crypto.randomUUID()+'.tmp';
  let handle;
  try{
    handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(safeStorage.encryptString(token));await handle.sync();await handle.close();handle=null;
    // Linking publishes a complete file without overwriting another starter's key.
    try{await fs.link(temporary,file);}catch(error){if(error.code!=='EEXIST')throw error;}
    return await read();
  }finally{await handle?.close();await fs.rm(temporary,{force:true});}
}
function validToken(actual,expected){
  if(typeof actual!=='string'||!/^[a-f0-9]{64}$/.test(actual))return false;
  return crypto.timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));
}
function proof(token,role,clientNonce,serverNonce){return crypto.createHmac('sha256',Buffer.from(token,'hex')).update(`${role}|${clientNonce}|${serverNonce}`).digest('hex');}
function send(socket,message){
  const line=JSON.stringify(message)+'\n';
  if(Buffer.byteLength(line)>MAX_FRAME)throw new Error('Drive response exceeds its transport limit.');
  if(socket.destroyed)throw new Error('Drive connection closed.');
  if(socket.writableLength>MAX_FRAME*2){socket.destroy();throw new Error('Drive connection is not reading responses.');}
  socket.write(line);
}
function frames(socket,receive){
  let buffer=Buffer.alloc(0);
  socket.on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    for(;;){
      const end=buffer.indexOf(10);
      if(end<0){if(buffer.length>MAX_FRAME)socket.destroy();return;}
      if(end>MAX_FRAME){socket.destroy();return;}
      const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);
      try{const message=JSON.parse(line.toString('utf8'));if(!message||typeof message!=='object'||Array.isArray(message))throw new Error('Invalid frame');receive(message);}
      catch{socket.destroy();return;}
      if(socket.destroyed)return;
    }
  });
}
class DriveIpcServer{
  constructor({endpoint,token,dispatch,snapshot=()=>({})}){
    if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid Drive daemon identity.');
    Object.assign(this,{endpoint,token,dispatch,snapshot});this.clients=new Set();this.sockets=new Set();this.server=net.createServer(socket=>this.accept(socket));
  }
  listen(){return new Promise((resolve,reject)=>{
    const failed=error=>reject(error);this.server.once('error',failed);
    this.server.listen(this.endpoint,()=>{this.server.removeListener('error',failed);resolve();});
  });}
  accept(socket){
    this.sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>{this.sockets.delete(socket);this.clients.delete(socket);});
    const authTimer=setTimeout(()=>socket.destroy(),5000);authTimer.unref();socket.once('close',()=>clearTimeout(authTimer));
    let authenticated=false,clientNonce=null,serverNonce=null;const pending=new Set();
    frames(socket,message=>{
      if(!authenticated){
        if(clientNonce===null){
          if(message.type!=='hello'||message.version!==1||typeof message.nonce!=='string'||!/^[a-f0-9]{64}$/.test(message.nonce)){socket.destroy();return;}
          clientNonce=message.nonce;serverNonce=crypto.randomBytes(32).toString('hex');
          send(socket,{type:'challenge',nonce:serverNonce,proof:proof(this.token,'server',clientNonce,serverNonce)});return;
        }
        if(message.type!=='authenticate'||!validToken(message.proof,proof(this.token,'client',clientNonce,serverNonce))){socket.destroy();return;}
        authenticated=true;clearTimeout(authTimer);this.clients.add(socket);send(socket,{type:'ready',version:1,snapshot:this.snapshot()});return;
      }
      if(message.type!=='request'||!Number.isSafeInteger(message.id)||message.id<1||pending.has(message.id)||pending.size>=MAX_PENDING||typeof message.command!=='string'||!message.args||typeof message.args!=='object'||Array.isArray(message.args)){socket.destroy();return;}
      pending.add(message.id);
      Promise.resolve().then(()=>this.dispatch(message.command,message.args)).then(
        value=>{if(!socket.destroyed)send(socket,{type:'response',id:message.id,value});},
        error=>{if(!socket.destroyed)send(socket,{type:'response',id:message.id,error:String(error?.message||'Drive command failed.').slice(0,2048)});}
      ).catch(()=>socket.destroy()).finally(()=>pending.delete(message.id));
    });
  }
  publish(name,data){for(const socket of this.clients){try{send(socket,{type:'event',name,data});}catch{socket.destroy();}}}
  async close(){for(const socket of this.sockets)socket.destroy();if(this.server.listening)await new Promise(resolve=>this.server.close(resolve));}
}
class DriveIpcClient extends EventEmitter{
  constructor({endpoint,token,timeout=60000}){super();Object.assign(this,{endpoint,token,timeout});this.socket=null;this.pending=new Map();this.sequence=0;this.snapshot=null;this.connecting=null;}
  connect(){
    if(this.socket&&!this.socket.destroyed&&this.snapshot!==null)return Promise.resolve(this.snapshot);
    if(this.connecting)return this.connecting;
    const operation=new Promise((resolve,reject)=>{
      const socket=net.createConnection(this.endpoint);this.socket=socket;this.snapshot=null;let ready=false,settled=false,verifiedServer=false;const nonce=crypto.randomBytes(32).toString('hex');
      const timer=setTimeout(()=>{socket.destroy();if(!settled){settled=true;reject(new Error('Drive daemon connection timed out.'));}},5000);timer.unref();
      socket.once('connect',()=>{try{send(socket,{type:'hello',version:1,nonce});}catch(error){socket.destroy();reject(error);}});
      socket.on('error',error=>{if(!settled){settled=true;clearTimeout(timer);reject(error);}});
      socket.once('close',()=>{
        clearTimeout(timer);if(!settled){settled=true;reject(new Error('Drive daemon connection closed.'));}
        for(const [id,request] of this.pending){if(request.socket!==socket)continue;clearTimeout(request.timer);request.reject(new Error('Drive daemon disconnected; the command outcome may be uncertain.'));this.pending.delete(id);}
        if(this.socket===socket){this.socket=null;this.snapshot=null;}if(ready)this.emit('disconnect');
      });
      frames(socket,message=>{
        if(!ready){
          if(!verifiedServer){
            if(message.type!=='challenge'||typeof message.nonce!=='string'||!/^[a-f0-9]{64}$/.test(message.nonce)||!validToken(message.proof,proof(this.token,'server',nonce,message.nonce))){socket.destroy();return;}
            verifiedServer=true;send(socket,{type:'authenticate',proof:proof(this.token,'client',nonce,message.nonce)});return;
          }
          if(message.type!=='ready'||message.version!==1||!message.snapshot||typeof message.snapshot!=='object'){socket.destroy();return;}
          ready=true;settled=true;clearTimeout(timer);this.snapshot=message.snapshot;resolve(this.snapshot);return;
        }
        if(message.type==='event'&&typeof message.name==='string'){this.emit('event',message.name,message.data);return;}
        if(message.type!=='response'||!Number.isSafeInteger(message.id)){socket.destroy();return;}
        const request=this.pending.get(message.id);if(!request)return;this.pending.delete(message.id);clearTimeout(request.timer);
        if(typeof message.error==='string')request.reject(new Error(message.error));else request.resolve(message.value);
      });
    });
    this.connecting=operation;operation.finally(()=>{if(this.connecting===operation)this.connecting=null;}).catch(()=>{});return operation;
  }
  async request(command,args={},timeout=this.timeout){
    await this.connect();if(this.pending.size>=MAX_PENDING)throw new Error('Too many pending Drive commands.');
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Drive command timed out; its outcome may be uncertain.'));},timeout);timer.unref();
      this.pending.set(id,{resolve,reject,timer,socket:this.socket});
      try{send(this.socket,{type:'request',id,command,args});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  close(){this.socket?.destroy();}
}
module.exports={endpointFor,daemonToken,DriveIpcServer,DriveIpcClient};
