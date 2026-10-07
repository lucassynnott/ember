const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {WindowsDriveBackupScheduler}=require('../src/windows-drive-backup-scheduler');
test('scheduled backups reread opt-in settings and new notes without any main app process',async()=>{
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'ember-scheduled-backup-')),root=path.join(profile,'Drive'),notes=path.join(profile,'Notes'),copied=[];await fs.mkdir(root);await fs.mkdir(notes);
 const runtime={mountPath:root,backUp:async(file,relative)=>{copied.push({relative,bytes:await fs.readFile(file,'utf8')});return true;}};const scheduler=new WindowsDriveBackupScheduler({profile,runtime});
 try{await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({driveBackupNotes:true,notesDir:notes}));await fs.writeFile(path.join(notes,'one.md'),'First');assert.equal(await scheduler.tick(),1);await fs.writeFile(path.join(notes,'two.md'),'Second');assert.equal(await scheduler.tick(),2);assert.equal(copied.at(-1).bytes,'Second');await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({driveBackupNotes:false,notesDir:notes}));assert.equal(await scheduler.tick(),0);}finally{await scheduler.stop();await fs.rm(profile,{recursive:true,force:true});}
});
test('scheduler coalesces concurrent scans and aborts its active copy before stopping',async()=>{
 let entered,plans=0,copies=0;const began=new Promise(resolve=>entered=resolve);const runtime={mountPath:'/fixture',backUp:async(file,relative,{signal})=>{copies++;entered();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('copy cancelled')),{once:true}));}};
 const scheduler=new WindowsDriveBackupScheduler({profile:'/profile',runtime,enabled:async()=>true,plan:async()=>{plans++;return [{file:'/source',relative:'Notes/source.md'}];}});const first=scheduler.tick(),rejected=assert.rejects(first,/copy cancelled/);assert.equal(scheduler.tick(),first);await began;await scheduler.stop();await rejected;assert.equal(plans,1);assert.equal(copies,1);assert.equal(await scheduler.tick(),0);
});
test('generated recording notes keep stable bytes and timestamps across repeated scans',async()=>{
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'ember-backup-text-')),files=[];const runtime={mountPath:'/fixture',backUp:async file=>{files.push({file,mtime:(await fs.stat(file)).mtimeMs,bytes:await fs.readFile(file,'utf8')});return true;}};
 const scheduler=new WindowsDriveBackupScheduler({profile,runtime,enabled:async()=>true,plan:async()=>[{text:'# Summary\n\nTranscript',relative:'Recordings/call/call.md'}]});
 try{assert.equal(await scheduler.tick(),1);assert.equal(await scheduler.tick(),1);assert.deepEqual(files[0],files[1]);await fs.writeFile(files[0].file,'Altered');await assert.rejects(scheduler.tick(),/differs from its source/);}finally{await scheduler.stop();await fs.rm(profile,{recursive:true,force:true});}
});
test('disabling notes backups during a scan prevents the next planned file from being copied',async()=>{
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'ember-backup-disable-')),root=path.join(profile,'Drive'),notes=path.join(profile,'Notes');await fs.mkdir(root);await fs.mkdir(notes);for(const name of ['a.md','b.md'])await fs.writeFile(path.join(notes,name),name);
 const settingsFile=path.join(profile,'settings.json');await fs.writeFile(settingsFile,JSON.stringify({driveBackupNotes:true,notesDir:notes}));let copies=0;
 const runtime={mountPath:root,backUp:async()=>{copies++;await fs.writeFile(settingsFile,JSON.stringify({driveBackupNotes:false,notesDir:notes}));return true;}};const scheduler=new WindowsDriveBackupScheduler({profile,runtime});
 try{assert.equal(await scheduler.tick(),1);assert.equal(copies,1);}finally{await scheduler.stop();await fs.rm(profile,{recursive:true,force:true});}
});
