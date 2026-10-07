const fs=require('node:fs/promises');const path=require('node:path');
async function waitForEncryptionKey(directory,{timeoutMs=15000,intervalMs=100}={}){
  const file=path.join(directory,'Local State'),deadline=Date.now()+timeoutMs;
  do{
    try{
      const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024)throw new Error('Invalid Electron encryption profile; it was preserved.');
      const state=JSON.parse(await fs.readFile(file,'utf8')),encoded=state.os_crypt?.encrypted_key;
      if(typeof encoded==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)){
        const key=Buffer.from(encoded,'base64');if(key.length>5&&key.subarray(0,5).equals(Buffer.from('DPAPI')))return true;
      }
    }catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
    await new Promise(resolve=>setTimeout(resolve,intervalMs));
  }while(Date.now()<deadline);
  throw new Error('Electron has not persisted its Windows encryption key. The Drive daemon was not launched.');
}
module.exports={waitForEncryptionKey};
