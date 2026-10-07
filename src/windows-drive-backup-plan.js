const fs=require('node:fs/promises');const path=require('node:path');
async function jsonFile(file,limit){try{const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>limit)throw Error('Invalid backup metadata file.');return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return {};throw error;}}
async function regular(file){try{const info=await fs.lstat(file);return info.isFile()&&!info.isSymbolicLink();}catch(error){if(error.code==='ENOENT')return false;throw error;}}
const safeName=text=>String(text||'Untitled').replace(/[\\/:*?"<>|\x00-\x1f]/g,'-').replace(/\s+/g,' ').trim().slice(0,80)||'Untitled';
async function backupPlan({profile,driveRoot,signal}){
 const settings=await jsonFile(path.join(profile,'settings.json'),1024*1024),jobs=[];
 const check=()=>{if(signal?.aborted)throw Error('Backup scan cancelled.');if(jobs.length>100000)throw Error('Backup plan exceeds its limit.');};
 if(settings.driveBackupNotes===true&&typeof settings.notesDir==='string'&&path.isAbsolute(settings.notesDir)){
  let notes;try{notes=await fs.realpath(settings.notesDir);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(notes){
   const drive=await fs.realpath(driveRoot),relative=path.relative(drive,notes);if(relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))throw Error('The notes backup source cannot be inside Drive.');
   const queue=[{directory:notes,relative:''}];let count=0;
   for(let i=0;i<queue.length;i++){check();for(const entry of await fs.readdir(queue[i].directory,{withFileTypes:true})){
    if(++count>100000)throw Error('Notes backup scan exceeds its limit.');check();if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;
    const local=queue[i].relative?queue[i].relative+'/'+entry.name:entry.name,file=path.join(queue[i].directory,entry.name);
    const driveRelative=path.relative(drive,file);if(driveRelative===''||!driveRelative.startsWith('..'+path.sep)&&driveRelative!=='..'&&!path.isAbsolute(driveRelative))continue;
    if(entry.isDirectory())queue.push({directory:file,relative:local});else if(entry.isFile()&&entry.name.endsWith('.md'))jobs.push({kind:'notes',file,relative:'Notes/'+local});
   }}
  }
 }
 if(settings.driveBackupRecordings===true){
  const library=path.join(profile,'recordings');let libraryInfo;try{libraryInfo=await fs.lstat(library);}catch(error){if(error.code!=='ENOENT')throw error;}if(libraryInfo&&(!libraryInfo.isDirectory()||libraryInfo.isSymbolicLink()))throw Error('Recording backups require the original library directory.');const index=await jsonFile(path.join(library,'recordings.json'),64*1024*1024);
  for(const [id,item] of Object.entries(index.recordings||{})){
   check();if(!/^\d{8}-\d{6}(-\d+)?$/.test(id)||!item||item.status==='recording'||typeof item.createdAt!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(item.createdAt))continue;
   const folder=path.join(library,id);let info;try{info=await fs.lstat(folder);}catch(error){if(error.code==='ENOENT')continue;throw error;}if(!info.isDirectory()||info.isSymbolicLink())continue;
   const name=safeName(item.title||require('./recordings').defaultTitle(item.createdAt)),destination=`Recordings/${item.createdAt.slice(0,10)} ${name}`,finished=path.join(folder,'finished.mp4'),video=item.finished&&await regular(finished)?finished:path.join(folder,'recording.mp4');
   if(await regular(video))jobs.push({kind:'recordings',file:video,relative:`${destination}/${name}.mp4`});
   const edited=path.join(folder,'edited.mp4');if(item.edited&&!item.edited.auto&&await regular(edited))jobs.push({kind:'recordings',file:edited,relative:`${destination}/${name} (edited).mp4`});
   const transcript=(Array.isArray(item.transcript)?item.transcript:[]).map(line=>String(line.text||'')).join(' ').trim();
   if(transcript||item.summary){const text=[`# ${item.title||name}`,'',item.summary||'','',...(Array.isArray(item.chapters)?item.chapters:[]).map(chapter=>`- ${chapter.title}`),'',transcript].join('\n');jobs.push({kind:'recordings',text,relative:`${destination}/${name}.md`});}
  }
 }
 check();return jobs;
}
async function backupEnabled({profile,job}){
 const settings=await jsonFile(path.join(profile,'settings.json'),1024*1024);
 if(job.kind==='recordings')return settings.driveBackupRecordings===true;
 if(job.kind!=='notes'||settings.driveBackupNotes!==true||typeof settings.notesDir!=='string'||!path.isAbsolute(settings.notesDir))return false;
 try{
  const notes=await fs.realpath(settings.notesDir),source=await fs.realpath(job.file),relative=path.relative(notes,source);
  return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)&&'Notes/'+relative.split(path.sep).join('/')===job.relative;
 }catch(error){if(error.code==='ENOENT')return false;throw error;}
}
module.exports={backupPlan,backupEnabled};
