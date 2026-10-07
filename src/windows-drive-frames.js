const crypto=require('node:crypto');
const MAX_FRAME=256*1024,MAX_MESSAGE=16*1024*1024,CHUNK=128*1024,MAX_QUEUED=32*1024*1024;
const writers=new WeakMap();
function send(socket,message){
 const body=Buffer.from(JSON.stringify(message));if(body.length>MAX_MESSAGE)throw new Error('Drive response exceeds its transport limit.');if(socket.destroyed)throw new Error('Drive connection closed.');
 let lines;
 if(body.length+1<=MAX_FRAME)lines=[Buffer.concat([body,Buffer.from('\n')])];
 else{const transfer=crypto.randomBytes(16).toString('hex'),total=Math.ceil(body.length/CHUNK);lines=Array.from({length:total},(_,index)=>Buffer.from(JSON.stringify({type:'fragment',transfer,index,total,data:body.subarray(index*CHUNK,(index+1)*CHUNK).toString('base64')})+'\n'));}
 let writer=writers.get(socket);if(!writer){writer={queue:[],bytes:0,running:false};writers.set(socket,writer);}
 const size=lines.reduce((n,line)=>n+line.length,0);if(writer.bytes+socket.writableLength+size>MAX_QUEUED){socket.destroy();throw new Error('Drive connection is not reading responses.');}
 writer.queue.push(...lines);writer.bytes+=size;
 kick(socket,writer);
}
function kick(socket,writer){if(writer.running||socket.destroyed)return;writer.running=true;void pump(socket,writer).catch(()=>socket.destroy()).finally(()=>{writer.running=false;if(writer.queue.length)kick(socket,writer);});}
async function pump(socket,writer){
 try{while(writer.queue.length){if(socket.destroyed)throw new Error('Drive connection closed.');const line=writer.queue.shift();writer.bytes-=line.length;
  if(!socket.write(line))await new Promise((resolve,reject)=>{
   const cleanup=()=>{socket.removeListener('drain',drain);socket.removeListener('close',closed);socket.removeListener('error',failed);};
   const drain=()=>{cleanup();resolve();},closed=()=>{cleanup();reject(new Error('Drive connection closed.'));},failed=error=>{cleanup();reject(error);};
   socket.once('drain',drain);socket.once('close',closed);socket.once('error',failed);
  });
 }}finally{writer.queue=[];writer.bytes=0;}
}
function frames(socket,receive,{allowFragments=()=>false}={}){
 let buffer=Buffer.alloc(0),assembly=null,timer=null;
 const reset=()=>{clearTimeout(timer);timer=null;assembly=null;};socket.once('close',reset);
 const object=body=>{const value=JSON.parse(body);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid frame');return value;};
 const deliver=message=>{
  if(message.type!=='fragment'){if(assembly)throw new Error('Interrupted Drive message');receive(message);return;}
  if(!allowFragments()||typeof message.transfer!=='string'||!/^[a-f0-9]{32}$/.test(message.transfer)||!Number.isInteger(message.total)||message.total<2||message.total>MAX_MESSAGE/CHUNK||!Number.isInteger(message.index)||message.index<0||message.index>=message.total||typeof message.data!=='string'||message.data.length>Math.ceil(CHUNK/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(message.data))throw new Error('Invalid Drive fragment');
  const bytes=Buffer.from(message.data,'base64');if(bytes.toString('base64')!==message.data||!bytes.length||bytes.length>CHUNK||(message.index<message.total-1&&bytes.length!==CHUNK))throw new Error('Invalid Drive fragment bytes');
  if(!assembly){if(message.index!==0)throw new Error('Out-of-order Drive fragment');assembly={transfer:message.transfer,total:message.total,next:0,bytes:0,parts:[]};timer=setTimeout(()=>{reset();socket.destroy();},15000);timer.unref?.();}
  if(assembly.transfer!==message.transfer||assembly.total!==message.total||assembly.next!==message.index)throw new Error('Out-of-order Drive fragment');
  assembly.parts.push(bytes);assembly.bytes+=bytes.length;assembly.next++;if(assembly.bytes>MAX_MESSAGE)throw new Error('Drive message exceeds its transport limit.');
  if(assembly.next===assembly.total){const body=Buffer.concat(assembly.parts).toString('utf8');reset();const result=object(body);if(result.type==='fragment')throw new Error('Nested Drive fragment');receive(result);}
 };
 socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){const end=buffer.indexOf(10);if(end<0){if(buffer.length>MAX_FRAME)socket.destroy();return;}if(end>MAX_FRAME){socket.destroy();return;}const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);try{deliver(object(line.toString('utf8')));}catch{reset();socket.destroy();return;}if(socket.destroyed)return;}});
}
module.exports={send,frames,MAX_MESSAGE};
