const fs=require('node:fs/promises');const path=require('node:path');const {validLocal}=require('./windows-drive-names');
function caseOnlyFileRename(from,local){
 if(typeof from!=='string'||typeof local!=='string'||from===local)return false;
 const source=from.split('/'),destination=local.split('/');
 return source.every(validLocal)&&destination.every(validLocal)&&source.length===destination.length&&source.slice(0,-1).join('/')===destination.slice(0,-1).join('/')&&source.at(-1).toUpperCase()===destination.at(-1).toUpperCase();
}
// Windows resolves both spellings after a capitalization-only rename. Inspect
// the actual directory entry before treating that alias as a duplicate source.
async function sourceRemovedForRename({bridge,from,local,localPath,directory=false}){
 if(!(await bridge.inspect(from)).exists)return true;
 if(!caseOnlyFileRename(from,local)||typeof localPath!=='string'||!path.isAbsolute(localPath)||path.basename(localPath)!==local.split('/').at(-1))return false;
 const entries=await fs.readdir(path.dirname(localPath),{withFileTypes:true});
 const source=from.split('/').at(-1),destination=local.split('/').at(-1);
 return !entries.some(entry=>entry.name===source)&&entries.some(entry=>entry.name===destination&&(directory===true?entry.isDirectory():entry.isFile())&&!entry.isSymbolicLink());
}
module.exports={caseOnlyFileRename,sourceRemovedForRename};
