const path=require('node:path');const fs=require('node:fs/promises');const assert=require('node:assert/strict');const {promisify}=require('node:util');const execFile=promisify(require('node:child_process').execFile);
async function verifyExplorer(root){
 assert.equal(process.platform,'win32');assert.equal(process.env.GITHUB_ACTIONS,'true','Explorer acceptance only operates on a disposable Windows runner');
 const directory=path.resolve('dist/windows-drive-explorer-evidence');await fs.mkdir(directory,{recursive:true});
 const result=await execFile('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-STA','-File',path.join(__dirname,'test-windows-explorer.ps1'),'-Root',root,'-Screenshot',path.join(directory,'navigation.png')],{timeout:45000,windowsHide:true,maxBuffer:1024*1024});
 const line=result.stdout.split(/\r?\n/).find(line=>line.startsWith('EMBER_EXPLORER_TEST:'));assert.ok(line,'Explorer must report visible navigation acceptance');const proof=JSON.parse(line.slice('EMBER_EXPLORER_TEST:'.length));assert.equal(proof.sidebarSelected,true);assert.equal(proof.registeredRootReached,true);assert.equal(proof.visibleWindow,true);assert.ok((await fs.stat(path.join(directory,'navigation.png'))).size>1000);await fs.writeFile(path.join(directory,'result.json'),JSON.stringify(proof,null,2));return proof;
}
module.exports={verifyExplorer};
