const fs=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');const {backupPlan}=require('./windows-drive-backup-plan');
class WindowsDriveBackupScheduler{
 constructor({profile,runtime,intervalMs=60000,plan=backupPlan,onError=()=>{}}){Object.assign(this,{profile,runtime,intervalMs,plan,onError});this.running=null;this.controller=null;this.closed=false;this.timer=null;}
 start(){if(this.closed||this.timer)return;this.timer=setInterval(()=>void this.tick().catch(this.onError),this.intervalMs);this.timer.unref?.();void this.tick().catch(this.onError);}
 tick(){
  if(this.running)return this.running;if(this.closed||!this.runtime.mountPath)return Promise.resolve(0);
  const controller=new AbortController();this.controller=controller;
  const task=(async()=>{
   const jobs=await this.plan({profile:this.profile,driveRoot:this.runtime.mountPath,signal:controller.signal});let copied=0;
   for(const job of jobs){
    if(controller.signal.aborted)throw Error('Scheduled backup cancelled.');if(!this.runtime.mountPath)break;
    let file=job.file;
    if(typeof job.text==='string'){
     const directory=path.join(this.profile,'windows-drive','backup-notes');await fs.mkdir(directory,{recursive:true});const info=await fs.lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Backup note staging requires a regular directory.');
     const hash=crypto.createHash('sha256').update(job.relative).update('\0').update(job.text).digest('hex');file=path.join(directory,hash+'.md');
     try{await fs.writeFile(file,job.text,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;const existing=await fs.lstat(file);if(!existing.isFile()||existing.isSymbolicLink()||await fs.readFile(file,'utf8')!==job.text)throw Error('The saved backup note differs from its source.');}
    }
    try{if(await this.runtime.backUp(file,job.relative,{signal:controller.signal}))copied++;}catch(error){if(controller.signal.aborted)throw error;this.onError(error);}
   }
   return copied;
  })();
  this.running=task;task.finally(()=>{if(this.running===task)this.running=null;if(this.controller===controller)this.controller=null;}).catch(()=>{});return task;
 }
 async stop(){this.closed=true;clearInterval(this.timer);this.timer=null;this.controller?.abort();await this.running?.catch(()=>{});}
}
module.exports={WindowsDriveBackupScheduler};
